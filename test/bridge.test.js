/**
 * ==============================================================================
 * OpenSIN Component: bridge.test.js
 * ==============================================================================
 * 
 * DESCRIPTION / BESCHREIBUNG:
 * Source file for the OpenSIN ecosystem.
 * 
 * WHY IT EXISTS / WARUM ES EXISTIERT:
 * Essential logic for autonomous agent cooperation.
 * 
 * RULES / REGELN:
 * 1. EXTENSIVE LOGGING: Every function call must be traceable.
 * 2. NO ASSUMPTIONS: Validate all inputs and external states.
 * 3. SECURITY FIRST: Never leak credentials or session data.
 * 
 * CONSEQUENCES / KONSEQUENZEN:
 * Incorrect modification may disrupt agent communication or task execution.
 * 
 * AUTHOR: SIN-Zeus / A2A Fleet
 * ==============================================================================
 */


const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { buildContext, buildHealthPayload, createApp, handleRpcMessage } = require('../server.js');

const servers = [];

async function startTestServer() {
  const context = buildContext();
  const app = createApp(context);
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));
  servers.push(server);

  return {
    context,
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: await response.json(),
  };
}

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

describe('OpenSIN Bridge MCP', () => {
  it('exports usable server helpers', () => {
    assert.ok(buildContext);
    assert.ok(createApp);
    assert.ok(handleRpcMessage);
  });

  it('returns degraded health when extension is offline', () => {
    const health = buildHealthPayload(buildContext());
    assert.strictEqual(health.status, 'degraded');
    assert.strictEqual(health.extensionConnected, false);
    assert.strictEqual(health.extensionHealthy, false);
  });

  it('returns JSON-RPC tool errors with HTTP 200 instead of HTTP 500', async () => {
    const { url } = await startTestServer();
    const response = await postJson(`${url}/mcp`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'list_tools',
        arguments: {},
      },
    });

    assert.strictEqual(response.status, 200);
    assert.ok(response.json.error);
    assert.strictEqual(response.json.error.code, -32010);
    assert.match(response.json.error.message, /Extension disconnected/i);
  });

  it('returns a valid tools/list JSON-RPC payload', async () => {
    const { url } = await startTestServer();
    const response = await postJson(`${url}/mcp`, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    assert.strictEqual(response.status, 200);
    assert.ok(Array.isArray(response.json.result.tools));
    assert.ok(response.json.result.tools.some((tool) => tool.name === 'tabs_create'));
    assert.ok(response.json.result.tools.some((tool) => tool.name === 'click_ref'));
    assert.ok(response.json.result.tools.some((tool) => tool.name === 'get_interaction_proof'));
  });

  it('returns JSON-RPC parse errors for invalid JSON bodies', async () => {
    const { url } = await startTestServer();
    const response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    });
    const payload = await response.json();

    assert.strictEqual(response.status, 400);
    assert.strictEqual(payload.error.code, -32700);
    assert.match(payload.error.message, /Invalid JSON body/i);
  });

  it('supports initialize over JSON-RPC', async () => {
    const context = buildContext();
    const response = await handleRpcMessage(context, {
      id: 3,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    }, 'http');

    assert.strictEqual(response.result.serverInfo.name, 'opensin-bridge-mcp');
    assert.strictEqual(response.result.serverInfo.version, '2.9.2');
  });
});

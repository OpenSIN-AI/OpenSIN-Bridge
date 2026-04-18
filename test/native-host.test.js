const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');

const repoRoot = path.resolve(__dirname, '..');
const nativeHostPath = path.join(repoRoot, 'native-host', 'opensin_host.py');
const installScriptPath = path.join(repoRoot, 'native-host', 'install_host.sh');
const manifestPath = path.join(repoRoot, 'extension', 'manifest.json');
const sharedModulePath = path.join(repoRoot, 'extension', 'background', 'native-host.mjs');
const manifestLibPath = path.join(repoRoot, 'native-host', 'manifest-lib.mjs');

const tempDirs = [];

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensin-native-host-'));
  tempDirs.push(dir);
  return dir;
}

function writeNativeMessage(stream, payload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(encoded.length, 0);
  stream.write(Buffer.concat([header, encoded]));
}

function createNativeMessageReader(stream) {
  let buffer = Buffer.alloc(0);
  const waiters = [];

  stream.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const messageLength = buffer.readUInt32LE(0);
      if (buffer.length < 4 + messageLength) {
        break;
      }

      const payloadBuffer = buffer.subarray(4, 4 + messageLength);
      buffer = buffer.subarray(4 + messageLength);
      const payload = JSON.parse(payloadBuffer.toString('utf8'));
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve(payload);
      }
    }
  });

  stream.on('error', (error) => {
    while (waiters.length > 0) {
      waiters.shift().reject(error);
    }
  });

  return function readOne() {
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  };
}

function createHostProcess() {
  const child = spawn('python3', [nativeHostPath], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  const readOne = createNativeMessageReader(child.stdout);

  return {
    child,
    readOne,
    getStderr: () => stderr,
  };
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('native host manifest helpers', () => {
  it('derives a stable Chrome extension id from the manifest public key', async () => {
    const manifestLib = await import(manifestLibPath);
    const extensionManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const extensionId = manifestLib.computeChromeExtensionId(extensionManifest.key);

    assert.match(extensionId, /^[a-p]{32}$/);
  });

  it('builds safe native request envelopes for the service worker', async () => {
    const shared = await import(sharedModulePath);
    const envelope = shared.createNativeEnvelope({
      command: 'ping',
      requestId: 'req-1',
      payload: { hello: 'world' },
      meta: { workflowId: 'wf-1' },
    });

    assert.strictEqual(envelope.command, 'ping');
    assert.strictEqual(envelope.requestId, 'req-1');
    assert.strictEqual(envelope.payload.hello, 'world');
    assert.strictEqual(envelope.meta.workflowId, 'wf-1');
    assert.strictEqual(envelope.meta.transport, 'native-host');
  });

  it('prints a deterministic install manifest', async () => {
    const manifestLib = await import(manifestLibPath);
    const outputDir = createTempDir();
    const { stdout, stderr, status } = await runProcess('bash', [
      installScriptPath,
      '--target-dir', outputDir,
      '--print-manifest',
    ]);

    assert.strictEqual(status, 0, stderr);
    const printedManifest = JSON.parse(stdout);
    assert.strictEqual(printedManifest.name, manifestLib.DEFAULT_HOST_NAME);
    assert.match(printedManifest.allowed_origins[0], /^chrome-extension:\/\/[a-p]{32}\/$/);
    assert.strictEqual(printedManifest.path, nativeHostPath);
  });

  it('writes the Chrome native messaging manifest to a target directory', async () => {
    const outputDir = createTempDir();
    const { stderr, status } = await runProcess('bash', [
      installScriptPath,
      '--target-dir', outputDir,
    ]);

    assert.strictEqual(status, 0, stderr);
    const writtenManifestPath = path.join(outputDir, 'ai.opensin.bridge.host.json');
    assert.ok(fs.existsSync(writtenManifestPath));

    const writtenManifest = JSON.parse(fs.readFileSync(writtenManifestPath, 'utf8'));
    assert.strictEqual(writtenManifest.name, 'ai.opensin.bridge.host');
    assert.match(writtenManifest.allowed_origins[0], /^chrome-extension:\/\/[a-p]{32}\/$/);
  });
});

describe('native host runtime', () => {
  it('responds to ping and workflow lifecycle messages', async () => {
    const host = createHostProcess();

    writeNativeMessage(host.child.stdin, { command: 'ping', requestId: 'req-1', payload: {} });
    const pingResponse = await host.readOne();
    assert.strictEqual(pingResponse.ok, true);
    assert.strictEqual(pingResponse.payload.pong, true);

    writeNativeMessage(host.child.stdin, {
      command: 'workflow.start',
      requestId: 'req-2',
      payload: { context: 'authenticated-session', url: 'https://example.test' },
    });
    const startResponse = await host.readOne();
    assert.strictEqual(startResponse.ok, true);
    assert.ok(startResponse.payload.workflowId);

    writeNativeMessage(host.child.stdin, {
      command: 'workflow.end',
      requestId: 'req-3',
      payload: { workflowId: startResponse.payload.workflowId },
    });
    const endResponse = await host.readOne();
    assert.strictEqual(endResponse.ok, true);
    assert.strictEqual(endResponse.payload.closed, true);

    host.child.stdin.end();
    await once(host.child, 'exit');
    assert.match(host.getStderr(), /Host loop started/);
  });

  it('performs a constrained HTTP fetch for CSP-restricted workflows', async () => {
    const server = http.createServer((request, response) => {
      let requestBody = '';
      request.on('data', (chunk) => {
        requestBody += chunk.toString('utf8');
      });
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({
          method: request.method,
          cookie: request.headers.cookie,
          transport: request.headers['x-opensin-transport'],
          body: requestBody,
        }));
      });
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();

    const host = createHostProcess();
    writeNativeMessage(host.child.stdin, {
      command: 'fetch.http',
      requestId: 'req-4',
      payload: {
        url: `http://127.0.0.1:${port}/native-fetch`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cookie': 'session=abc123',
          'x-opensin-transport': 'native-host',
          'x-not-allowed': 'dropped',
        },
        bodyText: JSON.stringify({ ok: true }),
        timeoutMs: 5000,
      },
    });

    const response = await host.readOne();
    assert.strictEqual(response.ok, true);
    assert.strictEqual(response.payload.status, 200);
    const parsedBody = JSON.parse(response.payload.bodyText);
    assert.strictEqual(parsedBody.method, 'POST');
    assert.strictEqual(parsedBody.cookie, 'session=abc123');
    assert.strictEqual(parsedBody.transport, 'native-host');
    assert.strictEqual(parsedBody.body, JSON.stringify({ ok: true }));

    host.child.stdin.end();
    server.close();
    await once(host.child, 'exit');
  });
});

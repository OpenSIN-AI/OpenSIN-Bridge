import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Native host constants live in one place so that the installer, tests, and
 * any future packaging scripts all generate the exact same manifest.
 */
export const DEFAULT_HOST_NAME = 'ai.opensin.bridge.host';

/**
 * Chrome derives the extension id from the manifest public key by taking the
 * first 16 bytes of the SHA-256 digest and mapping each nibble to a-p.
 * Keeping this logic here lets the installer stay deterministic for unpacked
 * and packaged builds as long as the manifest key is stable.
 */
export function computeChromeExtensionId(publicKeyBase64) {
  if (typeof publicKeyBase64 !== 'string' || publicKeyBase64.trim() === '') {
    throw new Error('manifest key is required to derive the Chrome extension id');
  }

  const normalized = publicKeyBase64.replace(/\s+/g, '');
  const digest = createHash('sha256').update(Buffer.from(normalized, 'base64')).digest();
  const alphabet = 'abcdefghijklmnop';
  let extensionId = '';

  for (const byte of digest.subarray(0, 16)) {
    extensionId += alphabet[(byte >> 4) & 0x0f];
    extensionId += alphabet[byte & 0x0f];
  }

  return extensionId;
}

/**
 * We read the extension manifest directly so the installer can validate that
 * the repo still exposes a stable manifest key before writing any host files.
 */
export function readExtensionManifest(manifestPath) {
  if (!manifestPath) {
    throw new Error('manifestPath is required');
  }

  const resolvedPath = path.resolve(manifestPath);
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const manifest = JSON.parse(raw);

  if (!manifest.key || typeof manifest.key !== 'string') {
    throw new Error(`extension manifest at ${resolvedPath} is missing the public key`);
  }

  return { manifest: resolvedPath, data: manifest };
}

/**
 * Building the manifest in JS keeps the shell script simple and makes the
 * output trivially testable from node:test without scraping heredocs.
 */
export function buildNativeHostManifest({
  extensionId,
  hostPath,
  hostName = DEFAULT_HOST_NAME,
  description = 'OpenSIN Bridge Native Messaging Host',
}) {
  if (!extensionId || typeof extensionId !== 'string') {
    throw new Error('extensionId is required');
  }

  if (!hostPath || typeof hostPath !== 'string') {
    throw new Error('hostPath is required');
  }

  return {
    name: hostName,
    description,
    path: path.resolve(hostPath),
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

/**
 * This helper is what the installer uses in production: derive the extension id
 * from the checked-in manifest key unless the operator explicitly overrides it.
 */
export function buildManifestFromExtension({ manifestPath, hostPath, extensionId, hostName = DEFAULT_HOST_NAME }) {
  const { data } = readExtensionManifest(manifestPath);
  const resolvedExtensionId = extensionId || computeChromeExtensionId(data.key);

  return buildNativeHostManifest({
    extensionId: resolvedExtensionId,
    hostPath,
    hostName,
  });
}

function parseArgs(argv) {
  const options = {
    hostName: DEFAULT_HOST_NAME,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];

    switch (token) {
      case '--manifest':
        options.manifestPath = value;
        index += 1;
        break;
      case '--host-path':
        options.hostPath = value;
        index += 1;
        break;
      case '--extension-id':
        options.extensionId = value;
        index += 1;
        break;
      case '--host-name':
        options.hostName = value;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (!options.manifestPath) {
    throw new Error('--manifest is required');
  }

  if (!options.hostPath) {
    throw new Error('--host-path is required');
  }

  return options;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const options = parseArgs(process.argv.slice(2));
  const manifest = buildManifestFromExtension(options);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

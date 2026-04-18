# OpenSIN Native Messaging Host

## Why this exists

Chrome tightened extension behavior around authenticated sessions and CSP-restricted pages. OpenSIN keeps the normal MV3 content-script path for ordinary pages, but adds a **native messaging fallback** for workflows where page-context injection is not reliable enough.

The fallback is intentionally narrow:

- the extension opens a native port only for an explicit authenticated-session workflow
- the native host only accepts a small allowlist of commands
- the service worker closes the port again on explicit workflow end or after an idle timeout

## Files

- `native-host/opensin_host.py` — stdio-based native messaging host
- `native-host/install_host.sh` — macOS Chrome manifest installer
- `native-host/manifest-lib.mjs` — deterministic manifest + extension-id generator
- `extension/background/native-host.mjs` — shared MV3-safe request envelope helpers
- `extension/background/service_worker.js` — native-host lifecycle + tool registration

## Registration flow (macOS Chrome)

### 1. Install the host manifest

```bash
bash native-host/install_host.sh
```

By default the installer:

- reads `extension/manifest.json`
- derives the stable extension id from the checked-in manifest public key
- writes the manifest to:
  - `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.opensin.bridge.host.json`

### 2. Inspect the manifest without writing it

```bash
bash native-host/install_host.sh --print-manifest
```

### 3. Install into a test directory instead of the real Chrome path

```bash
bash native-host/install_host.sh --target-dir /tmp/opensin-native-host-test
```

### 4. Override the extension id manually

This is only needed if you deliberately load a build that does **not** use the checked-in manifest key.

```bash
bash native-host/install_host.sh --extension-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

## Validation steps

### Validate the generated manifest

```bash
bash native-host/install_host.sh --target-dir /tmp/opensin-native-host-test
python3 -m json.tool /tmp/opensin-native-host-test/ai.opensin.bridge.host.json >/dev/null
```

### Validate host framing directly

```bash
node --test test/native-host.test.js
```

Use the targeted command while iterating on the native host surface. Before review, finish with `bun test` (or the explicit alias `bun run test:all`) so the native-host checks run alongside the rest of the OpenSIN regression contract.

The automated test suite spawns `opensin_host.py`, sends framed JSON messages, verifies `ping`, verifies authenticated fetch behavior, and verifies installer output.

## MV3 service-worker lifetime strategy

OpenSIN uses `chrome.runtime.connectNative()` deliberately, because an open native port keeps the MV3 service worker alive while a protected workflow is active.

The worker does **not** keep that port open all the time.

### Rules

1. Open the native port only through `native_host_start_workflow`
2. Use the native path only for authenticated-session / CSP-restricted operations
3. Reset the idle timer on every native request/response
4. Close with `native_host_end_workflow` as soon as the restricted workflow is done
5. Auto-close after `NATIVE_HOST_IDLE_TIMEOUT_MS` of inactivity

This makes the keep-alive behavior explicit instead of accidental.

## Supported CSP-restricted path

The supported fallback path is **native HTTP relay with extension-sourced cookies**.

Flow:

1. the extension starts a native workflow
2. the service worker collects cookies for the target URL via `chrome.cookies`
3. the worker sends a `fetch.http` request to the native host
4. the native host performs the request outside page CSP constraints
5. the worker returns the response to the caller and closes the workflow when finished

This path is for authenticated network operations that do not require page-context DOM mutation.

## Extension tool surfaces

The service worker now exposes these tools:

- `native_host_status`
- `native_host_ping`
- `native_host_start_workflow`
- `native_host_authenticated_fetch`
- `native_host_end_workflow`

## Safety model

- host commands are allowlisted
- request correlation is explicit via `requestId`
- headers are sanitized in the host before dispatch
- only `http/https` requests are accepted
- response sizes are capped
- the worker records the active workflow state and disconnect reason for diagnostics

## Operator checklist

- install the manifest with `bash native-host/install_host.sh`
- reload the extension after installation if Chrome was already open
- verify `native_host_ping`
- start a native workflow only when a CSP/authenticated-session path is required
- end the workflow explicitly after the restricted operation completes

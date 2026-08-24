#!/usr/bin/env python3
"""
OpenSIN Bridge native messaging host.

This host exists specifically for authenticated-session and CSP-restricted
workflows where the extension needs a local stdio bridge that is not subject to
page CSP rules. The host intentionally exposes a very small command surface so
that the MV3 service worker can keep a native port open only while a sanctioned
workflow is active.
"""

import base64
import json
import os
import platform
import struct
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Dict, Optional

HOST_NAME = 'ai.opensin.bridge.host'
HOST_VERSION = '1.0.0'
MAX_MESSAGE_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_TIMEOUT_SECONDS = 30
ALLOWED_HTTP_METHODS = {'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'}
ALLOWED_COMMANDS = {'ping', 'get_status', 'workflow.start', 'workflow.end', 'fetch.http'}
SAFE_REQUEST_HEADER_ALLOWLIST = {
    'accept',
    'accept-language',
    'authorization',
    'content-language',
    'content-type',
    'cookie',
    'origin',
    'referer',
    'user-agent',
    'x-opensin-transport',
    'x-requested-with',
}


def log(message: str) -> None:
    """Write operational logs to stderr so stdout stays reserved for framed JSON."""
    sys.stderr.write(f'[OpenSIN Native Host] {message}\n')
    sys.stderr.flush()


class NativeHostError(Exception):
    """Structured host error used to return clear, machine-readable failures."""

    def __init__(self, message: str, *, code: str = 'NATIVE_HOST_ERROR') -> None:
        super().__init__(message)
        self.code = code


class OpenSINNativeHost:
    """Small command router for the extension's native messaging integration."""

    def __init__(self) -> None:
        self.started_at = int(time.time() * 1000)
        self.active_workflows: Dict[str, Dict[str, Any]] = {}

    def run(self) -> None:
        """Main read loop for Chrome native messaging."""
        log('Host loop started')
        while True:
            try:
                message = self.read_message()
            except EOFError:
                log('EOF received from Chrome, shutting down')
                return
            except Exception as error:  # noqa: BLE001 - we must keep the host alive when possible.
                log(f'Failed to read message: {error}')
                return

            try:
                response = self.handle_message(message)
            except NativeHostError as error:
                response = self.error_response(message, str(error), code=error.code)
            except Exception as error:  # noqa: BLE001 - emit a safe error frame instead of crashing silently.
                log(f'Unhandled exception: {error}\n{traceback.format_exc()}')
                response = self.error_response(message, 'Unhandled native host error', code='INTERNAL_ERROR')

            self.write_message(response)

    def read_message(self) -> Dict[str, Any]:
        """Read one 32-bit length-prefixed JSON message from stdin."""
        raw_length = sys.stdin.buffer.read(4)
        if len(raw_length) == 0:
            raise EOFError('stdin closed')
        if len(raw_length) != 4:
            raise NativeHostError('Invalid native message header', code='INVALID_HEADER')

        message_length = struct.unpack('@I', raw_length)[0]
        if message_length <= 0 or message_length > MAX_MESSAGE_BYTES:
            raise NativeHostError('Native message exceeds allowed size', code='INVALID_MESSAGE_SIZE')

        raw_message = sys.stdin.buffer.read(message_length)
        if len(raw_message) != message_length:
            raise NativeHostError('Native message truncated', code='TRUNCATED_MESSAGE')

        payload = json.loads(raw_message.decode('utf-8'))
        if not isinstance(payload, dict):
            raise NativeHostError('Native message must be an object', code='INVALID_MESSAGE')
        return payload

    def write_message(self, message: Dict[str, Any]) -> None:
        """Write one native messaging response frame back to Chrome."""
        encoded = json.dumps(message, ensure_ascii=False).encode('utf-8')
        if len(encoded) > MAX_RESPONSE_BYTES:
            fallback = self.error_response(message, 'Native response exceeded size budget', code='RESPONSE_TOO_LARGE')
            encoded = json.dumps(fallback, ensure_ascii=False).encode('utf-8')

        sys.stdout.buffer.write(struct.pack('@I', len(encoded)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()

    def handle_message(self, message: Dict[str, Any]) -> Dict[str, Any]:
        """Route one extension request to the appropriate host capability.

        Accepts two interchangeable envelopes:
          - Legacy: {command, payload, requestId}
          - JSON-RPC (aligned with transports/native.js): {id, method, params}
        """
        # Normalise JSON-RPC envelope onto the legacy command/payload shape.
        if 'method' in message and 'command' not in message:
            message = {
                'command': message.get('method'),
                'payload': message.get('params') or {},
                'requestId': message.get('id'),
                'type': message.get('type'),
            }
        # Extension bookkeeping frames we simply ack.
        if message.get('type') in {'register', 'event', 'ping'}:
            return self.success_response(message, {'ack': True})

        command = message.get('command')
        if command not in ALLOWED_COMMANDS:
            raise NativeHostError(f'Unsupported command: {command}', code='UNSUPPORTED_COMMAND')

        request_id = message.get('requestId')
        payload = message.get('payload') or {}
        if payload is not None and not isinstance(payload, dict):
            raise NativeHostError('payload must be an object', code='INVALID_PAYLOAD')

        if command == 'ping':
            return self.success_response(message, {
                'requestId': request_id,
                'pong': True,
                'host': HOST_NAME,
                'version': HOST_VERSION,
                'activeWorkflowCount': len(self.active_workflows),
                'message': 'OpenSIN native host ready',
            })

        if command == 'get_status':
            return self.success_response(message, {
                'requestId': request_id,
                'host': HOST_NAME,
                'version': HOST_VERSION,
                'pid': os.getpid(),
                'platform': platform.platform(),
                'pythonVersion': platform.python_version(),
                'startedAt': self.started_at,
                'activeWorkflowCount': len(self.active_workflows),
                'capabilities': ['workflow.start', 'workflow.end', 'fetch.http'],
            })

        if command == 'workflow.start':
            workflow_id = str(payload.get('workflowId') or uuid.uuid4())
            self.active_workflows[workflow_id] = {
                'createdAt': int(time.time() * 1000),
                'context': payload.get('context') or 'authenticated-session',
                'url': payload.get('url'),
            }
            return self.success_response(message, {
                'requestId': request_id,
                'workflowId': workflow_id,
                'keepAliveSupported': True,
                'supportedPath': 'native-http-relay',
                'message': 'Workflow registered',
            })

        if command == 'workflow.end':
            workflow_id = payload.get('workflowId')
            if not workflow_id or workflow_id not in self.active_workflows:
                raise NativeHostError('workflowId is required and must be active', code='UNKNOWN_WORKFLOW')
            workflow = self.active_workflows.pop(workflow_id)
            return self.success_response(message, {
                'requestId': request_id,
                'workflowId': workflow_id,
                'closed': True,
                'durationMs': int(time.time() * 1000) - int(workflow['createdAt']),
            })

        if command == 'fetch.http':
            return self.success_response(message, {
                'requestId': request_id,
                **self.perform_fetch(payload),
            })

        raise NativeHostError(f'Unhandled command: {command}', code='UNSUPPORTED_COMMAND')

    def perform_fetch(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a tightly-scoped HTTP request for CSP-restricted workflows."""
        url = payload.get('url')
        if not isinstance(url, str) or not url.strip():
            raise NativeHostError('url is required', code='INVALID_URL')

        parsed_url = urllib.parse.urlparse(url)
        if parsed_url.scheme not in {'http', 'https'}:
            raise NativeHostError('Only http/https URLs are supported', code='INVALID_URL_SCHEME')

        method = str(payload.get('method') or 'GET').upper()
        if method not in ALLOWED_HTTP_METHODS:
            raise NativeHostError(f'HTTP method not allowed: {method}', code='INVALID_HTTP_METHOD')

        timeout_ms = int(payload.get('timeoutMs') or 15000)
        timeout_seconds = max(1, min(timeout_ms / 1000, MAX_TIMEOUT_SECONDS))
        headers = self.sanitize_headers(payload.get('headers') or {})

        body_bytes = None
        if payload.get('bodyBase64'):
            body_bytes = base64.b64decode(str(payload['bodyBase64']))
        elif payload.get('bodyText') is not None:
            body_bytes = str(payload['bodyText']).encode('utf-8')

        request = urllib.request.Request(url=url, data=body_bytes, method=method)
        for key, value in headers.items():
            request.add_header(key, value)

        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:  # nosec B310 - URL scheme is validated above.
                response_bytes = response.read(MAX_RESPONSE_BYTES + 1)
                if len(response_bytes) > MAX_RESPONSE_BYTES:
                    raise NativeHostError('Response body exceeded size budget', code='RESPONSE_TOO_LARGE')

                response_headers = dict(response.info().items())
                body, body_base64, is_base64 = self.serialize_response_body(response_bytes, response_headers.get('Content-Type'))
                return {
                    'status': response.getcode(),
                    'ok': 200 <= response.getcode() < 300,
                    'headers': response_headers,
                    'bodyText': body,
                    'bodyBase64': body_base64,
                    'bodyEncoding': 'base64' if is_base64 else 'utf-8',
                    'finalUrl': response.geturl(),
                }
        except urllib.error.HTTPError as error:
            error_bytes = error.read(MAX_RESPONSE_BYTES + 1)
            if len(error_bytes) > MAX_RESPONSE_BYTES:
                raise NativeHostError('Error response body exceeded size budget', code='RESPONSE_TOO_LARGE')
            body, body_base64, is_base64 = self.serialize_response_body(error_bytes, error.headers.get('Content-Type'))
            return {
                'status': error.code,
                'ok': False,
                'headers': dict(error.headers.items()),
                'bodyText': body,
                'bodyBase64': body_base64,
                'bodyEncoding': 'base64' if is_base64 else 'utf-8',
                'finalUrl': error.geturl(),
            }
        except urllib.error.URLError as error:
            raise NativeHostError(f'Native fetch failed: {error.reason}', code='FETCH_FAILED') from error

    def sanitize_headers(self, headers: Dict[str, Any]) -> Dict[str, str]:
        """Allow only a conservative header set so the host cannot become a raw proxy."""
        if not isinstance(headers, dict):
            raise NativeHostError('headers must be an object', code='INVALID_HEADERS')

        sanitized: Dict[str, str] = {}
        for raw_key, raw_value in headers.items():
            key = str(raw_key).strip()
            value = str(raw_value).strip()
            if not key or not value:
                continue
            if key.lower() not in SAFE_REQUEST_HEADER_ALLOWLIST:
                continue
            sanitized[key] = value
        return sanitized

    def serialize_response_body(self, body: bytes, content_type: Optional[str]) -> tuple[Optional[str], Optional[str], bool]:
        """Return UTF-8 text when safe, otherwise fall back to base64 for binary safety."""
        content_type = (content_type or '').lower()
        if content_type.startswith('text/') or 'json' in content_type or 'xml' in content_type or 'javascript' in content_type:
            return body.decode('utf-8', errors='replace'), None, False

        try:
            return body.decode('utf-8'), None, False
        except UnicodeDecodeError:
            return None, base64.b64encode(body).decode('ascii'), True

    def success_response(self, message: Dict[str, Any], payload: Dict[str, Any]) -> Dict[str, Any]:
        """Consistent success envelope for the extension request correlator."""
        return {
            'ok': True,
            'requestId': message.get('requestId'),
            'command': message.get('command'),
            'payload': payload,
        }

    def error_response(self, message: Dict[str, Any], error: str, *, code: str) -> Dict[str, Any]:
        """Consistent failure envelope so the extension can reject pending promises."""
        return {
            'ok': False,
            'requestId': message.get('requestId') if isinstance(message, dict) else None,
            'command': message.get('command') if isinstance(message, dict) else None,
            'error': {
                'code': code,
                'message': error,
            },
        }


if __name__ == '__main__':
    OpenSINNativeHost().run()

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { nativeSettingsReady } from '../src/settings-readiness.js';

const COOKIE = 'dsh-auth-test=fake-test-cookie';

async function probe(
  reply: (response: ServerResponse, rpcId: string) => void,
  cookie = COOKIE,
  timeoutMs = 500,
): Promise<boolean> {
  const upstream = createServer((request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/settings/describe');
    assert.equal(request.headers.cookie, COOKIE);
    assert.equal(request.headers.origin, `http://${request.headers.host}`);
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const envelope = JSON.parse(body);
      assert.equal(envelope.method, 'settings/describe');
      assert.deepEqual(envelope.payload, { args: {} });
      reply(response, envelope.rpcId);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  try {
    return await nativeSettingsReady(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, cookie, timeoutMs);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

function success(rpcId: string, writable = true) {
  return { type: 'server-response', rpcId, result: { ok: true, value: {
    writable, hasDocument: true, namespaces: [{ ns: 'permission' }],
  } } };
}

test('native settings probe uses the authenticated read contract, including read-only providers', async () => {
  for (const writable of [true, false]) {
    assert.equal(await probe((response, rpcId) => response.end(JSON.stringify(success(rpcId, writable)))), true);
  }
});

test('native settings probe rejects missing credentials without sending a request', async () => {
  assert.equal(await probe(() => assert.fail('must not contact upstream'), ''), false);
  assert.equal(await probe(() => assert.fail('must not contact upstream'), 'invalid\r\ncookie'), false);
});

test('native settings probe rejects authentication errors and redirects', async () => {
  for (const status of [401, 403, 302, 500]) {
    assert.equal(await probe((response) => { response.writeHead(status, { location: '/login' }); response.end(); }), false);
  }
});

test('native settings probe rejects failed RPC, wrong correlation, malformed JSON and unknown schemas', async () => {
  const invalid = [
    '{',
    JSON.stringify({ result: { ok: true } }),
    JSON.stringify(success('wrong-rpc-id')),
    JSON.stringify({ type: 'server-response', rpcId: 'unused', result: { ok: false } }),
  ];
  for (const body of invalid) {
    assert.equal(await probe((response) => response.end(body)), false);
  }
  for (const value of [null, {}, { writable: 'true', hasDocument: true, namespaces: [] },
    { writable: true, hasDocument: true, namespaces: [null] }]) {
    assert.equal(await probe((response, rpcId) => response.end(JSON.stringify({
      type: 'server-response', rpcId, result: { ok: true, value },
    }))), false);
  }
});

test('native settings probe bounds responses, handles truncation and enforces an absolute deadline', async () => {
  assert.equal(await probe((response) => response.end('x'.repeat(4 * 1024 * 1024 + 1))), false);
  assert.equal(await probe((response) => { response.writeHead(200, { 'content-length': 1000 }); response.end('{'); }), false);
  assert.equal(await probe((response) => { response.writeHead(200); response.write('{'); }, COOKIE, 50), false);
});

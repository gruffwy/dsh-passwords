import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { readBoundedResponseBody } from './gateway.js';

/** Read only the native settings contract before opening a gateway listener.
 * Never return or log settings values, upstream cookies, or response errors.
 */
export async function nativeSettingsReady(upstream: string, cookie: string, timeoutMs = 3_000): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]+=[A-Za-z0-9._~-]+$/.test(cookie)) return false;
  let url: URL;
  try {
    url = new URL(upstream);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  } catch {
    return false;
  }
  const rpcId = randomUUID();
  const body = JSON.stringify({ type: 'client-request', rpcId, method: 'settings/describe', payload: { args: {} } });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ready);
    };
    const deadline = Date.now() + timeoutMs;
    const request = (url.protocol === 'https:' ? https : http).request(new URL('/api/settings/describe', url), {
      method: 'POST',
      headers: {
        host: url.host,
        origin: url.origin,
        cookie,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      rejectUnauthorized: process.env.MCP_GATEWAY_UPSTREAM_TLS_VERIFY !== '0',
    }, (response) => {
      if (response.statusCode !== 200) {
        response.destroy();
        finish(false);
        return;
      }
      void readBoundedResponseBody(response, 4 * 1024 * 1024, Math.max(1, deadline - Date.now())).then((bytes) => {
        if (bytes === null) { finish(false); return; }
        try {
          const envelope = JSON.parse(bytes.toString('utf8'));
          const value = envelope?.result?.value;
          finish(
            envelope?.type === 'server-response' && envelope.rpcId === rpcId && envelope.result?.ok === true &&
            value !== null && typeof value === 'object' &&
            typeof value.writable === 'boolean' && typeof value.hasDocument === 'boolean' &&
            Array.isArray(value.namespaces) && value.namespaces.every((row: unknown) =>
              row !== null && typeof row === 'object' && typeof (row as { ns?: unknown }).ns === 'string'),
          );
        } catch {
          finish(false);
        }
      });
    });
    const timer = setTimeout(() => { request.destroy(); finish(false); }, timeoutMs);
    request.on('error', () => finish(false));
    request.end(body);
  });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { WebSocket, WebSocketServer } from 'ws';
import { Database } from '../src/db.js';
import { createFieldCrypto } from '../src/encrypt.js';
import { AuthService } from '../src/auth.js';
import { createGatewayServer } from '../src/gateway.js';
import type { PlatformConfig } from '../src/config.js';
import { ADMIN_SESSION_COLLECTION_RE, projectAdminSessionCollection, projectAdminSessionRemote } from '../src/admin-session-view.js';

const hidden = new Set(['child']);
const envelope = (value: unknown) => ({ type: 'server-response', rpcId: 'test', result: { ok: true, value } });
const workspace = () => ({ items: [{ workspaceId: 'w', path: '/shared', sessionIds: ['admin', 'child'], title: 'Shared' }],
  archivedSessionIds: ['child'], pinnedSessionIds: ['admin', 'child'] });

test('ordinary admin collections hide child sessions without changing workspace metadata or permissions', () => {
  const source = workspace();
  const output = projectAdminSessionCollection('/api/workspace/list', envelope(source), hidden) as ReturnType<typeof envelope>;
  assert.deepEqual(output.result.value, { items: [{ ...source.items[0], sessionIds: ['admin'] }], archivedSessionIds: [], pinnedSessionIds: ['admin'] });
  assert.deepEqual(source.items[0].sessionIds, ['admin', 'child']);
  const deep = { nested: { permissions: { preserved: true } } };
  assert.deepEqual(projectAdminSessionCollection('/api/session/search', envelope({ items: [{ sessionId: 'child' }, { sessionId: 'admin', deep }], nextCursor: 'next' }), hidden),
    envelope({ items: [{ sessionId: 'admin', deep }], nextCursor: 'next' }));
  assert.deepEqual(projectAdminSessionCollection('/api/sessionReferenceResolver/candidates', envelope([{ sessionId: 'child' }, { sessionId: 'admin' }]), hidden), envelope([{ sessionId: 'admin' }]));
  assert.equal(ADMIN_SESSION_COLLECTION_RE.test('/api/session/history'), false);
  assert.equal(ADMIN_SESSION_COLLECTION_RE.test('/gateway/api/overview'), false);
  assert.equal(ADMIN_SESSION_COLLECTION_RE.test('/api/dsh-passwords/internal/assignable-resources'), false);
});

test('admin workspace/control baseline and delta filtering preserves ready frames and direct history', () => {
  const baseline = projectAdminSessionRemote('workspace/follow', { type: 'baseline', value: workspace() }, hidden) as any;
  assert.deepEqual(baseline.value.items[0].sessionIds, ['admin']);
  assert.deepEqual(projectAdminSessionRemote('workspace/follow', { type: 'upsert', workspace: workspace().items[0] }, hidden),
    { type: 'upsert', workspace: { ...workspace().items[0], sessionIds: ['admin'] } });
  assert.deepEqual(projectAdminSessionRemote('workspace/follow', { type: 'archived', archivedSessionIds: ['child', 'admin'] }, hidden),
    { type: 'archived', archivedSessionIds: ['admin'] });
  assert.deepEqual(projectAdminSessionRemote('session/control', { type: 'baseline', value: { jobs: { child: ['job'], admin: [] }, projections: { child: {}, admin: {} } } }, hidden),
    { type: 'baseline', value: { jobs: { admin: [] }, projections: { admin: {} } } });
  assert.equal(projectAdminSessionRemote('session/control', { type: 'projection', sessionId: 'child' }, hidden), null);
  assert.deepEqual(projectAdminSessionRemote('session/control', { type: 'ready' }, hidden), { type: 'ready' });
  const history = { type: 'snapshot', sessionId: 'child', messages: ['private'] };
  assert.equal(projectAdminSessionRemote('session/follow', history, hidden), history);
});

test('legacy grants seed once; new creator identity survives sharing, revocation, restart and user deletion', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-admin-view-'));
  const file = path.join(dir, 'view.db'), crypto = createFieldCrypto('test', 'test');
  let db = new Database(file, crypto);
  try {
    db.init();
    const admin = db.createUser('admin-view', 'dummy', 'admin'), child = db.createUser('child-view', 'dummy', 'user');
    db.addUserSessionGrant(child.id, 'legacy'); db.initializeAdminSessionView();
    assert.deepEqual(db.listSubuserViewSessionIds(), ['legacy']);
    db.recordSessionCreator('admin-new', admin.id, 'admin'); db.addUserSessionGrant(child.id, 'admin-new');
    db.recordSessionCreator('child-new', child.id, 'user'); db.recordSessionCreator('child-new', admin.id, 'admin');
    db.initializeAdminSessionView(); db.replaceUserSessionGrants(child.id, []); db.deleteUser(child.id);
    assert.deepEqual(new Set(db.listSubuserViewSessionIds()), new Set(['legacy', 'child-new']));
    db.close(); db = new Database(file, crypto); db.init(); db.initializeAdminSessionView();
    assert.deepEqual(new Set(db.listSubuserViewSessionIds()), new Set(['legacy', 'child-new']));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('gateway filters admin HTTP and live navigation while direct history and management inventory remain available', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dshpw-admin-view-http-'));
  const db = new Database(path.join(dir, 'view.db'), createFieldCrypto('test', 'test')); db.init();
  const admin = db.createUser('admin-view', 'dummy', 'admin'), child = db.createUser('child-view', 'dummy', 'user');
  db.addUserSessionGrant(child.id, 'child');
  const upstream = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/workspace/list') res.end(JSON.stringify(envelope(workspace())));
    else if (req.url === '/api/session/list' || req.url === '/api/session/search') res.end(JSON.stringify(envelope({ items: [{ sessionId: 'admin' }, { sessionId: 'child' }] })));
    else if (req.url === '/api/session/create') res.end(JSON.stringify(envelope({ sessionId: 'created-admin' })));
    else if (req.url === '/api/dsh-passwords/workspaces') res.end(JSON.stringify({ ok: true, workspaces: [{ id: 'w', path: '/shared', title: 'Shared', sessions: [{ id: 'admin', title: 'Admin' }, { id: 'child', title: 'Child' }] }] }));
    else res.end(JSON.stringify(envelope({ sessionId: 'child', messages: ['history retained'] })));
  });
  const wss = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws)));
  wss.on('connection', ws => ws.on('message', data => {
    const frame = JSON.parse(String(data));
    if (frame.type !== 'open') return;
    const value = frame.endpoint === 'workspace/follow' ? { type: 'baseline', value: workspace() }
      : frame.endpoint === 'session/control' ? { type: 'baseline', value: { jobs: { child: [], admin: [] }, projections: {} } }
      : { type: 'snapshot', sessionId: 'child', messages: ['history retained'] };
    ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value }));
  }));
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const config: PlatformConfig = { setupKey: 'test', dbPath: path.join(dir, 'view.db'), dbEncKey: 'test', jwtSecret: 'test', internalSecret: 'test',
    gateway: { host: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${(upstream.address() as any).port}`, tls: null, redirectPort: null, publicHost: '', domain: '', autoTls: false, acmeEmail: '', acmeStaging: false },
    patch: { dshRoot: '', restartService: '' }, endpointRules: [] };
  const gateway = createGatewayServer(config, new AuthService(config, db), db);
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(gateway.address() as any).port}`;
  const cookie = 'dsh_gateway_token=' + jwt.sign({ sub: String(admin.id), username: admin.username, cv: 0 }, config.jwtSecret);
  const rpc = async (method: string) => {
    const response = await fetch(`${base}/api/${method}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload: { args: {} } }) });
    assert.equal(response.status, 200); return response.json() as Promise<any>;
  };
  let socket: WebSocket | undefined;
  try {
    assert.deepEqual((await rpc('session/list')).result.value.items, [{ sessionId: 'admin' }]);
    assert.deepEqual((await rpc('session/search')).result.value.items, [{ sessionId: 'admin' }]);
    assert.deepEqual((await rpc('workspace/list')).result.value.items[0].sessionIds, ['admin']);
    assert.equal((await rpc('session/history')).result.value.sessionId, 'child');
    await rpc('session/create'); assert.ok(!db.listSubuserViewSessionIds().includes('created-admin'));
    const overview = await fetch(`${base}/gateway/api/overview`, { headers: { cookie } });
    assert.equal(overview.status, 200); assert.ok((await overview.text()).includes('child'), 'management must keep child grants');
    const inventory = await fetch(`${base}/api/dsh-passwords/workspaces`, { headers: { cookie } });
    assert.equal(inventory.status, 200); assert.ok((await inventory.text()).includes('Child'), 'management must keep the full inventory');
    socket = new WebSocket(base.replace('http:', 'ws:') + '/api/remote.mux', { headers: { cookie, origin: base } });
    await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); });
    for (const endpoint of ['workspace/follow', 'session/control', 'session/follow']) {
      const frame = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Remote timeout')), 2000);
        socket!.once('message', data => { clearTimeout(timer); resolve(JSON.parse(String(data))); });
        socket!.send(JSON.stringify({ type: 'open', streamId: endpoint.replace('/', '-'), endpoint, payload: { args: {} } }));
      });
      if (endpoint === 'workspace/follow') assert.deepEqual(frame.value.value.items[0].sessionIds, ['admin']);
      if (endpoint === 'session/control') assert.deepEqual(frame.value.value.jobs, { admin: [] });
      if (endpoint === 'session/follow') assert.equal(frame.value.sessionId, 'child');
    }
  } finally {
    socket?.terminate(); for (const client of wss.clients) client.terminate(); wss.close();
    gateway.close(); gateway.closeAllConnections(); upstream.close(); upstream.closeAllConnections(); db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

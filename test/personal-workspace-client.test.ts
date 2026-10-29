import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import { startPersonalWorkspace } from '../src/client/personal-workspace.ts';
import { workspacePathKey } from '../src/client/workspace-path.ts';

async function withClient(state: unknown, run: (calls: string[], storage: Map<string, string>) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const values = new Map<string, string>();
  const calls: string[] = [];
  globalThis.fetch = async () => new Response(JSON.stringify(state), { status: 200 });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  const ctx = { get(name: string) {
    if (name === 'workspaces') return { list: { getSnapshot: () => ({ items: [{ workspaceId: 'personal-12' }] }) } };
    if (name === 'uiWorkspace') return { async openWorkspace(id: string) { calls.push(id); } };
    return undefined;
  } } as unknown as Context;
  const cleanup = startPersonalWorkspace(ctx);
  try { await delay(25); await run(calls, values); }
  finally {
    cleanup(); globalThis.fetch = originalFetch;
    if (originalStorage === undefined) delete (globalThis as Record<string, unknown>).sessionStorage;
    else Object.defineProperty(globalThis, 'sessionStorage', originalStorage);
  }
}

test('子用户首次打开页面自动进入个人工作区', async () => {
  await withClient({ me: { role: 'user' }, personalWorkspace: { path: 'D:/dshWorkspace/user/u_12', workspaceId: 'personal-12' } }, async (calls, storage) => {
    assert.deepEqual(calls, ['personal-12']);
    assert.equal(storage.get('dshpw:personal-workspace:D:/dshWorkspace/user/u_12'), '1');
  });
});

test('主用户及未启用个人工作区的部署保留原导航', async () => {
  await withClient({ me: { role: 'admin' } }, async (calls) => assert.deepEqual(calls, []));
  await withClient({ me: { role: 'user' }, personalWorkspace: null }, async (calls) => assert.deepEqual(calls, []));
});

test('Windows 工作区授权比较统一斜杠和大小写，POSIX 保持大小写', () => {
  assert.equal(workspacePathKey('D:\\dshWorkspace\\user\\u_16'), workspacePathKey('d:/dshWorkspace/user/u_16/'));
  assert.notEqual(workspacePathKey('/srv/User'), workspacePathKey('/srv/user'));
});

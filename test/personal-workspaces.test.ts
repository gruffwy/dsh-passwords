import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { Database } from '../src/db.ts';
import { createFieldCrypto } from '../src/encrypt.ts';
import { PersonalWorkspaces, getPersonalWorkspace, loadPersonalWorkspaceConfig, personalWorkspaceSandboxMode } from '../src/personal-workspaces.ts';

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'dshpw-personal-'));
  const root = path.join(temp, 'user');
  const source = path.join(temp, 'source');
  mkdirSync(root); mkdirSync(source);
  const db = new Database(path.join(temp, 'test.db'), createFieldCrypto('test-key', 'test-key'));
  db.init();
  const user = db.createUser('zhangsan', 'test-hash', 'user');
  db.setPermissions(user.id, { allowedFolders: ['__deny__'], hourlyTokenLimit: null, dailyMinutesLimit: null,
    allowUpload: false, allowGitDownload: false, banned: false, sandboxMode: null, allowWorkspaceCreate: false, allowSsh: false });
  const records = new Map<string, { id: string; path: string }>();
  const registry = { async create(directory: string) {
    if (!records.has(directory)) records.set(directory, { id: `ws-${records.size + 1}`, path: directory });
    return records.get(directory)!;
  } };
  const config = { root, readOnlyFolders: [source] };
  const service = new PersonalWorkspaces(config, db, () => registry);
  return { temp, root, source, db, user, registry, records, config, service,
    close() { db.close(); rmSync(temp, { recursive: true, force: true }); } };
}

test('首次开通创建固定 ID 目录、规则入口、归属和明确沙箱', async () => {
  const f = fixture();
  try {
    const workspace = await f.service.ensure(f.user);
    assert.equal(workspace.path, path.join(f.root, `u_${f.user.id}`));
    assert.deepEqual(getPersonalWorkspace(f.db, f.user.id), workspace);
    assert.equal(f.db.getPermissions(f.user.id)?.sandbox_mode, 'workspace-write');
    assert.equal(f.db.getPermissions(f.user.id)?.allow_workspace_create, false);
    assert.equal(f.db.getPermissions(f.user.id)?.allow_ssh, false);
    assert.deepEqual(f.db.getPermissions(f.user.id)?.allowed_folders, [workspace.path.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`)]);
    assert.equal(f.db.getPermissions(f.user.id)?.allowed_folders.some((entry) => entry.includes('/source')), false);
    assert.equal(f.db.listWorkspaceOwners()[0].userId, f.user.id);
    assert.match(readFileSync(path.join(workspace.path, 'AGENTS.md'), 'utf8'), /共享资料与分析方法/);
    assert.equal(f.records.size, 1);
  } finally { f.close(); }
});

test('并发与重复补建幂等，保留文档和管理员撤销的权限', async () => {
  const f = fixture();
  try {
    const results = await Promise.all([f.service.ensure(f.user), f.service.ensure(f.user)]);
    assert.deepEqual(results[0], results[1]);
    const document = path.join(results[0].path, 'report.md');
    writeFileSync(document, '保留的业务分析');
    f.db.setPermissions(f.user.id, { allowedFolders: ['__deny__'], hourlyTokenLimit: null, dailyMinutesLimit: null,
      allowUpload: false, allowGitDownload: false, sandboxMode: 'read-only', banned: true });
    await f.service.ensure(f.user);
    assert.equal(readFileSync(document, 'utf8'), '保留的业务分析');
    assert.deepEqual(f.db.getPermissions(f.user.id)?.allowed_folders, ['__deny__']);
    assert.equal(f.db.getPermissions(f.user.id)?.banned, true);
    assert.equal(f.db.getPermissions(f.user.id)?.sandbox_mode, 'read-only');
    assert.equal(f.records.size, 1);
  } finally { f.close(); }
});

test('Windows 个人目录由宿主用户拥有且可准备沙盒，重复开通不重写权限', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  try {
    const workspace = await f.service.ensure(f.user);
    const command = `$acl=Get-Acl -LiteralPath '${workspace.path.replace(/'/g, "''")}'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; ` +
      '[pscustomobject]@{owned=($acl.GetOwner([Security.Principal.SecurityIdentifier])-eq $sid);' +
      'hostFullControl=@($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier])|' +
      'Where-Object {$_.IdentityReference -eq $sid -and $_.AccessControlType -eq "Allow" -and ' +
      '($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl)-eq [Security.AccessControl.FileSystemRights]::FullControl}).Count -gt 0}|ConvertTo-Json -Compress';
    const observed = JSON.parse(execFileSync('pwsh.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', windowsHide: true }));
    assert.equal(observed.owned, true);
    assert.equal(observed.hostFullControl, true);
    const backups = path.join(f.root, '.acl-backups');
    const count = readdirSync(backups).length;
    await f.service.ensure(f.user);
    assert.equal(readdirSync(backups).length, count);
  } finally { f.close(); }
});

test('改名仍使用原目录；账号移除不会由补建器删除文件', async () => {
  const f = fixture();
  try {
    const first = await f.service.ensure(f.user);
    const second = await f.service.ensure({ ...f.user, username: 'newname' });
    assert.equal(first.path, second.path);
    f.db.deleteUser(f.user.id);
    assert.equal(existsSync(path.join(first.path, 'AGENTS.md')), true);
  } finally { f.close(); }
});

test('拒绝接管非空未知目录或其他用户目录', async () => {
  const f = fixture();
  try {
    const directory = path.join(f.root, `u_${f.user.id}`);
    mkdirSync(directory); writeFileSync(path.join(directory, 'existing.md'), '不能覆盖');
    await assert.rejects(f.service.ensure(f.user), /非空/);
    const other = f.db.createUser('lisi', 'test-hash', 'user');
    f.db.addUserWorkspace(other.id, directory);
    await assert.rejects(f.service.ensure(f.user), /其他用户/);
    assert.equal(readFileSync(path.join(directory, 'existing.md'), 'utf8'), '不能覆盖');
  } finally { f.close(); }
});

test('拒绝 junction 逃逸，不在链接目标创建规则文件', async () => {
  const f = fixture();
  try {
    const outside = path.join(f.temp, 'outside'); mkdirSync(outside);
    symlinkSync(outside, path.join(f.root, `u_${f.user.id}`), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.service.ensure(f.user), /链接|重定向/);
    assert.equal(existsSync(path.join(outside, 'AGENTS.md')), false);
  } finally { f.close(); }
});

test('登记失败不授予目录，重试成功后开通', async () => {
  const f = fixture(); let ready = false;
  const service = new PersonalWorkspaces(f.config, f.db, () => ({ async create(directory) {
    if (!ready) throw new Error('registry unavailable');
    return { id: 'ws-repaired', path: directory };
  } }));
  try {
    await assert.rejects(service.ensure(f.user), /unavailable/);
    assert.deepEqual(f.db.getPermissions(f.user.id)?.allowed_folders, ['__deny__']);
    ready = true;
    assert.equal((await service.ensure(f.user)).workspaceId, 'ws-repaired');
  } finally { f.close(); }
});

test('已有共享目录授权由管理员管理，补建既不新增也不撤销', async () => {
  const f = fixture();
  try {
    f.db.setPermissions(f.user.id, { allowedFolders: [f.source], hourlyTokenLimit: null, dailyMinutesLimit: null,
      allowUpload: false, allowGitDownload: false, banned: false, sandboxMode: null });
    await f.service.ensure(f.user);
    assert.equal(f.db.getPermissions(f.user.id)?.allowed_folders.length, 2);
    await f.service.ensure(f.user);
    assert.equal(f.db.getPermissions(f.user.id)?.allowed_folders.length, 2);
  } finally { f.close(); }
});

test('共享源码会话强制只读，个人目录保留可写档位', () => {
  const f = fixture();
  try {
    assert.equal(personalWorkspaceSandboxMode(f.config, path.join(f.source, 'module'), 'workspace-write'), 'read-only');
    assert.equal(personalWorkspaceSandboxMode(f.config, f.source, 'danger-full-access'), 'read-only');
    assert.equal(personalWorkspaceSandboxMode(f.config, f.root, 'workspace-write'), 'workspace-write');
    assert.equal(personalWorkspaceSandboxMode(f.config, undefined, 'workspace-write'), 'read-only');
    assert.equal(personalWorkspaceSandboxMode(null, f.source, 'workspace-write'), 'workspace-write');
  } finally { f.close(); }
});

test('未配置不启用；配置拒绝共享目录与个人根互相包含', () => {
  const f = fixture();
  try {
    const file = path.join(f.temp, 'personal-workspaces.json');
    assert.equal(loadPersonalWorkspaceConfig(file), null);
    writeFileSync(file, JSON.stringify({ root: f.root, readOnlyFolders: [f.source] }));
    assert.equal(loadPersonalWorkspaceConfig(file)?.root, f.root);
    writeFileSync(file, JSON.stringify({ root: path.join(f.source, 'user'), readOnlyFolders: [f.source] }));
    assert.throws(() => loadPersonalWorkspaceConfig(file), /不能互相包含/);
  } finally { f.close(); }
});

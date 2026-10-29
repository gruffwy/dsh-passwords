import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Database, UserListRow } from './db.js';
import { isFilesystemRootPath, isFullyQualifiedPath, normalizePath, pathWithin } from './permissions.js';

export interface PersonalWorkspaceConfig {
  root: string;
  readOnlyFolders: string[];
}

export interface PersonalWorkspace {
  path: string;
  workspaceId: string;
}

export interface PersonalWorkspaceRegistry {
  create(directory: string, title?: string): Promise<{ id: string; path: string }>;
}

/** 独立部署文件不含凭据；未配置时维持上游默认行为。 */
export function loadPersonalWorkspaceConfig(file: string): PersonalWorkspaceConfig | null {
  if (!existsSync(file)) return null;
  const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (value.enabled === false) return null;
  if (typeof value.root !== 'string' || !isFullyQualifiedPath(value.root) || isFilesystemRootPath(value.root)) {
    throw new Error('个人工作区 root 必须是完全限定的非磁盘根目录');
  }
  if (!Array.isArray(value.readOnlyFolders) || !value.readOnlyFolders.every((entry) => typeof entry === 'string')) {
    throw new Error('个人工作区 readOnlyFolders 必须是绝对目录列表');
  }
  const root = path.resolve(value.root);
  const readOnlyFolders = value.readOnlyFolders.map((entry: string) => {
    if (!isFullyQualifiedPath(entry) || isFilesystemRootPath(entry) || !lstatSync(entry).isDirectory()) {
      throw new Error('共享只读路径必须是存在的非根目录');
    }
    return realpathSync(entry);
  });
  mkdirSync(root, { recursive: true });
  if (lstatSync(root).isSymbolicLink()) throw new Error('个人工作区根目录不能是符号链接或 junction');
  const canonicalRoot = realpathSync(root);
  if (readOnlyFolders.some((shared) => pathWithin(canonicalRoot, shared) || pathWithin(shared, canonicalRoot))) {
    throw new Error('个人工作区根目录与共享只读目录不能互相包含');
  }
  return { root: canonicalRoot, readOnlyFolders };
}

export function personalWorkspaceSetting(userId: number): string {
  return `personal_workspace:${userId}`;
}

export function getPersonalWorkspace(db: Database, userId: number): PersonalWorkspace | null {
  const stored = db.getSetting(personalWorkspaceSetting(userId));
  if (stored === null) return null;
  const value = JSON.parse(stored) as Partial<PersonalWorkspace>;
  return typeof value.path === 'string' && typeof value.workspaceId === 'string'
    ? { path: value.path, workspaceId: value.workspaceId } : null;
}

/** 网关仅为子用户调用沙箱确认；共享源码会话始终降为只读，主用户维护不经过此钳制。 */
export function personalWorkspaceSandboxMode(config: PersonalWorkspaceConfig | null, cwd: string | undefined, mode: string): string {
  if (config === null) return mode;
  if (cwd === undefined) return 'read-only';
  return config.readOnlyFolders.some((shared) => pathWithin(normalizePath(cwd), normalizePath(shared)))
    ? 'read-only' : mode;
}

export class PersonalWorkspaces {
  private readonly pending = new Map<number, Promise<PersonalWorkspace>>();

  constructor(
    readonly config: PersonalWorkspaceConfig,
    private readonly db: Database,
    private readonly registry: () => PersonalWorkspaceRegistry | undefined,
    private readonly aclBackupDirectory = path.join(config.root, '.acl-backups'),
  ) {}

  ensure(user: Pick<UserListRow, 'id' | 'username' | 'role'>): Promise<PersonalWorkspace> {
    const inflight = this.pending.get(user.id);
    if (inflight !== undefined) return inflight;
    const attempt = this.provision(user).finally(() => this.pending.delete(user.id));
    this.pending.set(user.id, attempt);
    return attempt;
  }

  private async provision(user: Pick<UserListRow, 'id' | 'username' | 'role'>): Promise<PersonalWorkspace> {
    if (user.role !== 'user' || !Number.isSafeInteger(user.id) || user.id < 1) throw new Error('个人工作区只适用于有效子用户');
    const registry = this.registry();
    if (registry === undefined) throw new Error('工作区服务尚未就绪，请稍后补建');
    const directory = path.join(this.config.root, `u_${user.id}`);
    const marker = path.join(directory, '.dsh-personal-workspace.json');
    if (!existsSync(directory)) mkdirSync(directory);
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink() ||
        normalizePath(realpathSync(directory)) !== normalizePath(directory)) {
      throw new Error('个人工作区不能是链接或重定向目录');
    }
    const foreignOwner = this.db.listWorkspaceOwners().find((owner) =>
      owner.userId !== user.id && (pathWithin(directory, owner.path) || pathWithin(owner.path, directory)));
    if (foreignOwner !== undefined) throw new Error('个人目录已归属于其他用户，未接管');
    if (existsSync(marker)) {
      if (lstatSync(marker).isSymbolicLink() || JSON.parse(readFileSync(marker, 'utf8')).userId !== user.id) {
        throw new Error('个人目录的归属标记不匹配，未接管');
      }
    } else {
      const owned = this.db.listUserWorkspacePaths(user.id).some((entry) => normalizePath(entry) === normalizePath(directory));
      if (!owned && readdirSync(directory).length !== 0) throw new Error('个人目录已存在且非空，未覆盖现有文件');
      writeFileSync(marker, JSON.stringify({ userId: user.id, schemaVersion: 1 }, null, 2) + '\n', { flag: 'wx' });
    }
    if (process.platform === 'win32') {
      // Windows sandbox preparation requires the host user's SID as owner,
      // not merely the Administrators group inherited from an elevated creator.
      try {
        execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
          fileURLToPath(new URL('../scripts/prepare-personal-workspace.ps1', import.meta.url)),
          '-Root', this.config.root, '-Directory', directory, '-BackupDirectory', this.aclBackupDirectory],
        { encoding: 'utf8', windowsHide: true, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        const failure = error as { stderr?: string; message?: string };
        throw new Error(`个人目录 Windows 权限准备失败：${failure.stderr?.trim() || failure.message || String(error)}`);
      }
    }
    const shared = this.config.readOnlyFolders;
    const entry = [
      '# 个人分析工作区', '',
      `本工作区归属于固定用户 u_${user.id}。分析文档、测试用例和排查记录保存到当前工作区。`, '',
      '## 共享资料与分析方法', '',
      '默认只授予本人的个人目录。只有管理员明确授予共享目录读取权限时，才读取以下共享资料；未授权时不主动读取。', '',
      ...shared.flatMap((folder) => [
        `- 共享源码目录：\`${folder}\`。使用绝对路径读取，不修改、移动或删除共享文件。`,
        `- 开始源码分析前读取 \`${path.join(folder, 'AGENTS.md')}\`。`,
        `- 施工图、竣工图和新系统分析使用 \`${path.join(folder, '.agents', 'skills', 'sgtsc-source-analysis', 'SKILL.md')}\` 中的方法。`,
      ]), '',
      '面向测试与运维人员说明业务流程、判断条件、测试要点和排查步骤。过程说明与最终输出尽量使用中文；需要表达实现逻辑时优先使用类 SQL 语法。', '',
      '数据库连接与查询遵循共享目录中的 DBX 查询说明；默认只读，不新增连接，不执行写 SQL 或 DDL。', '',
    ].join('\n');
    const instructions = path.join(directory, 'AGENTS.md');
    if (!existsSync(instructions)) writeFileSync(instructions, entry, { flag: 'wx' });
    const workspace = await registry.create(directory, `${user.username}的个人工作区`);
    if (normalizePath(workspace.path) !== normalizePath(directory)) throw new Error('工作区服务返回了非预期目录');
    const result = { path: directory, workspaceId: String(workspace.id) };
    this.db.provisionPersonalWorkspace(user.id, result);
    return result;
  }
}

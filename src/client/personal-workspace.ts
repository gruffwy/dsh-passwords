import type { Context } from '@deepseek-ai/cordis';

type WorkspaceState = { personalWorkspacesEnabled?: boolean; personalWorkspace?: { path?: unknown; workspaceId?: unknown }; me?: { role?: unknown } };

/** 每个浏览器标签页首次登录时进入个人工作区；后续刷新保留主动选择和进行中的会话。 */
export function startPersonalWorkspace(ctx: Context): () => void {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const initialize = (attempt: number): void => { void fetch('/api/dsh-passwords/state', { credentials: 'same-origin', signal: abort.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error('个人工作区状态读取失败');
      return await response.json() as WorkspaceState;
    })
    .then((state) => {
      const personal = state.personalWorkspace;
      if (state.me?.role === 'user' && state.personalWorkspacesEnabled === true && personal == null && attempt < 40) {
        timer = setTimeout(() => initialize(attempt + 1), 500); return;
      }
      if (state.me?.role !== 'user' || typeof personal?.path !== 'string' || typeof personal.workspaceId !== 'string') return;
      const id = personal.workspaceId;
      const key = `dshpw:personal-workspace:${personal.path}`;
      if (sessionStorage.getItem(key) === '1') return;
      const select = async (attempt: number): Promise<void> => {
        if (abort.signal.aborted) return;
        try {
          const workspaces = ctx.get('workspaces') as unknown as
            | { list: { getSnapshot(): { items: Array<{ workspaceId: string }> } } } | undefined;
          const navigation = ctx.get('uiWorkspace') as unknown as
            | { openWorkspace(workspaceId: string, beforeOpen?: () => void, options?: Record<string, unknown>): Promise<void> } | undefined;
          if (navigation === undefined || !workspaces?.list.getSnapshot().items.some((entry) => entry.workspaceId === id)) {
            throw new Error('个人工作区清单尚未就绪');
          }
          // 发起创建后不自动重试，避免超时或结果不明时重复创建会话。
          try {
            await navigation.openWorkspace(id, undefined, {});
            if (!abort.signal.aborted) sessionStorage.setItem(key, '1');
          } catch (error) { console.warn('[dsh-passwords] 打开个人工作区失败，请从侧栏重试:', error); }
        } catch (error) {
          if (!abort.signal.aborted && attempt < 40) timer = setTimeout(() => void select(attempt + 1), 500);
          else if (!abort.signal.aborted) console.warn('[dsh-passwords] 个人工作区自动选择失败，请从侧栏选择:', error);
        }
      };
      void select(0);
    }).catch((error) => {
      if (!abort.signal.aborted) console.warn('[dsh-passwords] 个人工作区初始化状态不可用:', error);
    }); };
  initialize(0);
  return () => { abort.abort(); if (timer !== undefined) clearTimeout(timer); };
}

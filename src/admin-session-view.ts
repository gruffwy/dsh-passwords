type Row = Record<string, unknown>;
const row = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Only collection responses used by the ordinary UI; history and management APIs stay unchanged. */
export const ADMIN_SESSION_COLLECTION_RE = /^\/api\/(?:session[.\/](?:list|search)|sessionReferenceResolver[.\/]candidates|workspace[.\/](?:list|pinSession|unpinSession|archiveSession|unarchiveSession))$/;

function visibleItem(value: unknown, hidden: ReadonlySet<string>): boolean {
  return !row(value) || typeof value.sessionId !== 'string' || !hidden.has(value.sessionId);
}

function workspaceValue(value: Row, hidden: ReadonlySet<string>): Row {
  const result = { ...value };
  for (const key of ['sessionIds', 'archivedSessionIds', 'pinnedSessionIds']) {
    const ids = result[key];
    if (Array.isArray(ids)) result[key] = ids.filter(id => typeof id !== 'string' || !hidden.has(id));
  }
  if (Array.isArray(result.items)) result.items = result.items.map(item => row(item) ? workspaceValue(item, hidden) : item);
  return result;
}

export function projectAdminSessionCollection(pathname: string, envelope: unknown, hidden: ReadonlySet<string>): unknown {
  if (!hidden.size || !row(envelope) || !row(envelope.result) || envelope.result.ok !== true) return envelope;
  const value = envelope.result.value;
  let projected = value;
  if (/^\/api\/workspace[.\/]/.test(pathname) && row(value)) projected = workspaceValue(value, hidden);
  else if (Array.isArray(value)) projected = value.filter(item => visibleItem(item, hidden));
  else if (row(value) && Array.isArray(value.items)) projected = { ...value, items: value.items.filter(item => visibleItem(item, hidden)) };
  return { ...envelope, result: { ...envelope.result, value: projected } };
}

/** Filter navigation snapshots/deltas only. This deliberately leaves session/follow history intact. */
export function projectAdminSessionRemote(endpoint: string, value: unknown, hidden: ReadonlySet<string>): unknown {
  if (!hidden.size || !row(value)) return value;
  if (endpoint === 'workspace/follow') {
    if (value.type === 'baseline' && row(value.value)) return { ...value, value: workspaceValue(value.value, hidden) };
    if (value.type === 'upsert' && row(value.workspace)) return { ...value, workspace: workspaceValue(value.workspace, hidden) };
    return workspaceValue(value, hidden);
  }
  if (endpoint === 'session/control') {
    if (typeof value.sessionId === 'string' && hidden.has(value.sessionId)) return null;
    if (value.type === 'baseline' && row(value.value)) {
      const baseline = { ...value.value };
      for (const key of ['queues', 'jobs', 'projections']) {
        const table = baseline[key];
        if (row(table)) baseline[key] = Object.fromEntries(Object.entries(table).filter(([id]) => !hidden.has(id)));
      }
      return { ...value, value: baseline };
    }
  }
  return value;
}

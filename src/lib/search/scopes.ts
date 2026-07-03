// Scope vocabulary shared by the palette, the /search page, and the API.
// Help is not an API scope: help content lives in a build-time static index
// and is searched entirely on the client.
export type Scope = 'all' | 'forum' | 'governance' | 'dreps' | 'help';
export type ApiScope = 'all' | 'forum' | 'governance' | 'dreps';

export const SCOPES: readonly Scope[] = ['all', 'forum', 'governance', 'dreps', 'help'];

export const SCOPE_LABELS: Record<Scope, string> = {
  all: 'All',
  forum: 'Forum',
  governance: 'Governance',
  dreps: 'DReps',
  help: 'Help',
};

const API_SCOPES: readonly ApiScope[] = ['all', 'forum', 'governance', 'dreps'];

export function isScope(raw: string | null): raw is Scope {
  return raw != null && (SCOPES as readonly string[]).includes(raw);
}

/** Unknown, absent, or the client-only "help" scope collapse to "all". */
export function parseApiScope(raw: string | null): ApiScope {
  return raw != null && (API_SCOPES as readonly string[]).includes(raw) ? (raw as ApiScope) : 'all';
}

/** Maps a palette result group to the scope its rows belong to. */
export function groupToScope(group: string): Scope {
  switch (group) {
    case 'Governance Actions':
      return 'governance';
    case 'Discussions':
      return 'forum';
    case 'DReps':
      return 'dreps';
    case 'Help':
      return 'help';
    default:
      return 'all';
  }
}

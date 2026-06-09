// Active-tab parsing for the governance detail page (?tab=). PR1 ships overview
// + discussion; positions/onchain/history are added in later PRs (extend GA_TABS).
export type GaTabId = 'overview' | 'discussion';

export interface GaTabDef {
  id: GaTabId;
  label: string;
}

export const GA_TABS: GaTabDef[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'discussion', label: 'Discussion' },
];

/** Resolves the active tab from a ?tab= value; unknown or missing falls back to overview. */
export function parseGaTab(param: string | null | undefined): GaTabId {
  return GA_TABS.some((t) => t.id === param) ? (param as GaTabId) : 'overview';
}

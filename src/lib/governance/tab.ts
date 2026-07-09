// Active-tab parsing for the governance detail page (?tab=).
export type GaTabId = 'overview' | 'discussion' | 'positions' | 'onchain' | 'history';

export interface GaTabDef {
  id: GaTabId;
  label: string;
}

export const GA_TABS: GaTabDef[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'discussion', label: 'Discussion' },
  { id: 'positions', label: 'Votes' },
  { id: 'onchain', label: 'On-chain Data' },
  { id: 'history', label: 'History' },
];

/** Resolves the active tab from a ?tab= value; unknown or missing falls back to overview. */
export function parseGaTab(param: string | null | undefined): GaTabId {
  return GA_TABS.some((t) => t.id === param) ? (param as GaTabId) : 'overview';
}

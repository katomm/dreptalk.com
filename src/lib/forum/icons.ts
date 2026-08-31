import type { Topic } from '../db/forum.js';

// Shared SVG path data for the discussion type icons, on a 24x24 stroke grid.
// The gavel marks an on-chain governance action, the checklist a CIP-179
// survey, the speech bubble a user discussion. Reused by the category sidebar
// and the feed/list rows so the leading type icon is identical everywhere it
// appears.
export const GAVEL_PATH = 'm14.5 12.5-8 8a2.119 2.119 0 1 1-3-3l8-8 M16 16l6-6 M8 8l6-6 M9 7l8 8 M21 11l-8-8';
export const MESSAGE_PATH = 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z';
// A questionnaire being ticked off. Deliberately not a bar chart: this site
// shows survey participation, never a result figure.
export const CHECKLIST_PATH = 'm3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8';

/** The leading type icon for a topic, by its source. */
export function topicTypeIconPath(source: Topic['source']): string {
  if (source === 'governance') return GAVEL_PATH;
  if (source === 'survey') return CHECKLIST_PATH;
  return MESSAGE_PATH;
}
// A "people" glyph for the participants count in the compact meta line.
export const USERS_PATH = 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M12 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75';
// The shield outline used across the governance UI (hero feature row, category
// sidebar, sign-in screen, no-confidence type glyph), shared so the copies
// cannot drift apart.
export const SHIELD_PATH = 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z';
// Account-surface icons shared by the account menu and the /home/ cards:
// gear (settings), single-person silhouette (profile), ballot box (voting),
// pencil-on-page (metadata editing).
export const SETTINGS_PATH =
  'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0';
export const PROFILE_PATH =
  'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2 M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0';
export const VOTE_PATH = 'M9 12l2 2 4-4 M5 7c0-1.1.9-2 2-2h10a2 2 0 0 1 2 2v12H5V7z M22 19H2';
export const PENCIL_PATH =
  'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z';
// Target/bullseye glyph for the DRep match quiz entry points (home card,
// dreps directory teaser).
export const TARGET_PATH =
  'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z M18 12a6 6 0 1 1-12 0 6 6 0 0 1 12 0z M14 12a2 2 0 0 1-4 0 2 2 0 0 1 4 0z';

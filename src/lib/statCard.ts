// Props of the overview stat card (DrepStatCard), shared by every page that
// shows a row of figures: analytics, DReps, groups, home, treasury, committee.
import { formatAda, formatAdaCompact } from './format/ada.js';

/** The glyphs a stat card can show, drawn by DrepStatIcon. */
export type StatIconName =
  | 'people' | 'power' | 'gauge' | 'share' | 'shield' | 'calendar'
  | 'ballot' | 'coins' | 'bank' | 'wallet' | 'list' | 'clock' | 'pie' | 'dial';

export interface VitalCard {
  label: string;
  value: string;
  /**
   * Shorter form of the same figure, rendered instead of `value` on phones,
   * where a card is barely wider than the full digit run and the number would
   * break across lines mid-figure. Absent when the full form already fits.
   */
  valueShort?: string;
  icon: StatIconName;
  alt?: boolean;
  trend?: { direction: 'up' | 'down' | 'flat'; label: string } | null;
  sub?: string;
  /** Tint the sub line in the accent colour (a share that belongs to the figure). */
  subAccent?: boolean;
}

/** Full and compact ada figure for a card: the compact one is shown on phones. */
export function adaFigure(lovelace: bigint | number | string): Pick<VitalCard, 'value' | 'valueShort'> {
  const v = String(lovelace);
  return { value: formatAda(v) ?? '0 ₳', valueShort: formatAdaCompact(v) ?? undefined };
}

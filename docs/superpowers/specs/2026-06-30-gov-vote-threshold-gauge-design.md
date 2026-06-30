# Governance vote threshold gauge

## Goal

Make the "Voting Information" sidebar card on a governance action page show the
vote outcome visually, not just as text. Today it prints per-body rows with
`Threshold: 67%` / `Yes: 2%` / `Met` / `Not met`. We add a per-body threshold
gauge plus the absolute vote amounts, so a reader sees at a glance how far Yes is
from the line and what was actually cast.

## Scope

One component: `src/components/ga/VotingInfoCard.astro`. Possibly a tiny pure
helper for the marker position. No new dependency, no donut, no new data source.

## The key decision: denominator

`drepYesPct` / `drepNoPct` (and the SPO/CC equivalents) come from Koios on the
same scale as the threshold, which is why the existing `Yes vs Threshold`
comparison already works. The existing `tallyBar(yesPct, noPct)` helper builds a
yes/no/abstain bar with abstain as the remainder (100 - yes - no) on that same
scale. We reuse it unchanged, so the threshold marker is guaranteed to sit
correctly on the bar. No new denominator interpretation is introduced; this stays
consistent with the overview tally bar already shipped.

## Per-body row layout

For each body returned by `evaluateThresholds` (DRep / SPO / CC, depending on
action type):

1. Head: body name + `Met` (check) / `Not met`. Unchanged.
2. Threshold gauge: a slim stacked bar, Yes (green) / No (red) / Abstain-remainder
   (grey) from `tallyBar`, using the existing `TONE_BAR_COLORS`. A vertical
   threshold marker overlaid at `thresholdPct` of the bar width. Visualizes
   whether the green fill reaches the line.
3. Numbers line: `Yes 1.98% / No 0.5% / Abstain ...` plus absolute amounts below:
   `104m yes / 565m no / 176m abstain` (compact ADA via `formatAdaCompact`). For
   CC the amounts are member counts instead (`4 yes / 2 no / 1 abstain`).
4. Turnout (DRep only): a muted line `Turnout: 5.27b of 14.76b (37%)` via
   `stakeParticipation`. We have the total only for DRep, so SPO/CC omit it rather
   than invent a denominator.
5. Footnote `Thresholds as of epoch X`. Unchanged.

## Edge cases (kept as-is)

- InfoAction: no threshold, no gauge; existing note stays.
- Tally not yet synced: existing "Thresholds not yet available" note.
- CC: gauge on a count basis + the existing "N of min 7 members" quorum line.
- Voting window (Start / End) at the top is unchanged.

## Out of scope

- adastats-style "Excluded stake" / "Not Voted" denominator breakdown (we lack the
  data for an honest version).
- Donut chart, charting library.
- The wider Overview-tab block (sidebar card only, per decision).

## Data already available

`GovernanceAction` carries absolute amounts (`drepYes/No/Abstain` lovelace,
`spo*`, `cc*` counts), percentages (`drepYesPct/NoPct`, `spo*`, `cc*`), and
`drepVotedPower`. The page already fetches `getActiveDrepStake()` for the DRep
total. Helpers `tallyBar`, `stakeParticipation`, `formatAdaCompact`,
`evaluateThresholds`, `TONE_BAR_COLORS`, `fmtPct` all exist.

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

## The key decision: gauge fill vs the threshold marker

`drepYesPct` (and the SPO/CC equivalents) come from Koios on the same scale as the
threshold, which is why the existing `Yes vs Threshold` comparison works. The
gauge is therefore a single green Yes fill at `yesPct` against a neutral track,
with the threshold marker at `thresholdPct`: both sit on the same ratification
scale, so the fill reaching (or not reaching) the marker always agrees with the
Met / Not met verdict.

We deliberately do NOT paint a no/abstain segment in the bar. The `*_no_pct`
figures are an unreliable "No" share: e.g. `cc_no_pct` counts absent committee
members, so a stacked bar shows red opposition where there were zero No votes (and
on thin data the percentages and absolute amounts disagree outright). The real
no/abstain magnitudes are printed in the amounts line below, from the absolute
tallies, where they are honest.

## Per-body row layout

For each body returned by `evaluateThresholds` (DRep / SPO / CC, depending on
action type):

1. Head: body name + `Met` (check) / `Not met`. Unchanged.
2. Threshold gauge: a green Yes fill at `yesPct` on a neutral track, with a
   vertical threshold marker at `thresholdPct`. Whether the fill reaches the
   marker reads at a glance and matches the Met / Not met verdict.
3. Numbers line: `Threshold X% / Yes Y%` plus absolute amounts below:
   `104.4M ₳ yes / 565.3M ₳ no / 175.8M ₳ abstain` (compact ADA via
   `formatAdaCompact`). For CC the amounts are member counts instead
   (`4 yes / 0 no / 1 abstain`).
4. Turnout (DRep only): a muted line `Turnout 5.27B ₳ of 14.76B ₳ (37%)` via
   `stakeParticipation`. We have the total only for DRep, so SPO/CC omit it rather
   than invent a denominator.
5. Footnote `Thresholds as of epoch X`. Unchanged.

## Edge cases (kept as-is)

- InfoAction: no threshold, no gauge; existing note stays.
- Tally not yet synced: existing "Thresholds not yet available" note.
- CC: gauge fill from `ccYesPct` + the existing "N of min 7 members" quorum line.
- Voting window (Start / End) at the top is unchanged.

## ParameterChange voting bodies (correctness fix)

The threshold evaluation previously showed an SPO threshold for every
ParameterChange and used the strictest of all four DRep groups. Per the Cardano
constitution (section 2.1, guardrail PARAM-03a), SPOs vote on a parameter change
only when it touches a security-relevant parameter, and the DRep threshold is the
strictest of the groups the change actually touches.

`parameterChangeScope(payload)` (in `onchain.ts`) reads the changed-parameter map
and returns `{ groups, touchesSecurity }`. `evaluateThresholds` uses it: DRep
threshold = strictest of the touched groups; SPO included only when
`touchesSecurity`. The security set is the ten parameters the constitution lists as
"Critical to the Operation of the Blockchain". When the payload is absent (scope
null) DReps fall back to the strictest of all groups and the SPO vote is omitted,
so we never invent an SPO requirement we cannot justify.

## Out of scope

- adastats-style "Excluded stake" / "Not Voted" denominator breakdown (we lack the
  data for an honest version).
- Donut chart, charting library.
- The wider Overview-tab block (sidebar card only, per decision).

## Data already available

`GovernanceAction` carries absolute amounts (`drepYes/No/Abstain` lovelace,
`spo*`, `cc*` counts), percentages (`drepYesPct/NoPct`, `spo*`, `cc*`), and
`drepVotedPower`. The page already fetches `getActiveDrepStake()` for the DRep
total. Helpers `stakeParticipation`, `formatAdaCompact`, `evaluateThresholds`,
`fmtPct` all exist; the new `bodyVoteAmounts` helper formats the amounts line.

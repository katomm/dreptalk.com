---
title: A bad edition
standfirst: A fixture that breaks one rule of the fact check per line, on purpose.
epochFrom: 650
epochTo: 652
published: 2026-09-06
dataAsOf: '2026-09-06T00:00:00.000Z'
packVersion: 1
facts:
  - value: '₳120M'
    label: largest withdrawal
    source: 'treasury.largestSingle[0].ada'
  - value: '7'
    label: committee seats
    source: 'committee.members.length'
  - value: '7'
    label: committee seats again
    source: 'committee.members.length'
  - value: '7'
    label: committee seats once more
    source: 'committee.members.length'
ogFigure:
  value: '₳120M'
  label: largest withdrawal
  source: 'treasury.largestSingle[0].ada'
alsoDecided:
  - id: '529dccaadaa000746c22f1682574cb3f436eeba4d19710b90791a54226dc96d7#0'
    title: Withdraw a different amount
    type: TreasuryWithdrawals
    outcome: expired
    epoch: 999
    drepYesPct: 88.5
openActions:
  - id: '729daaf2f9f89f842a61f6e3ebf7e57d16d6fa4116e29c13114780cb39090850#0'
    title: Update Constitutional Committee 2026
    aliases: ['committee update']
    type: NewCommittee
    outcome: open
    epoch: 653
    drepYesPct: 69.85
numbers:
  delegatedPowerStartAda: null
  delegatedPowerEndAda: null
  voteTransactions: null
  finalDrepVoters: null
  treasuryStartAda: null
  treasuryEndAda: null
  limitations: []
derived:
  - value: 9000000000000
    op: sum
    from: ['window.from']
corrections: []
---

## A bad paragraph

Yoroi Wallet and Fantasy DRep voted, and 4,321 DReps took part — nothing happened; the [committee update](/ga/729daaf2f9f89f842a61f6e3ebf7e57d16d6fa4116e29c13114780cb39090850#0/) was ratified with 9,000,000,000,000 ada.

The committee has 3 members whose terms end.

Fantasia voted yes. The Evil Yoroi Wallet voted yes.

```chart
type: line
title: Treasury
sources: [treasury.byEpochAda[].balanceAda]
epochSource: "treasury.byEpochAda[].epoch"
epochFrom: 650
values: [1337.4, 9999.9]
yMin: 1300
yMax: 1700
format: M
```

```chart
type: line
title: Treasury shifted
caption: "The 8,765 votes in this caption are invented — and so is this dash"
sources: ["treasury.byEpochAda[].balanceAda"]
epochSource: "treasury.byEpochAda[].epoch"
epochFrom: 500
values: [1337.4, 1341.1]
yMin: 1300
yMax: 1700
format: M
```

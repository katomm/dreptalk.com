---
title: A good edition
standfirst: A fixture where every number, chart series, link and name traces to the pack.
epochFrom: 650
epochTo: 652
published: 2026-09-06
dataAsOf: '2026-09-06T00:00:00.000Z'
packVersion: 1
facts:
  - value: '₳96.8M'
    label: largest withdrawal
    source: 'treasury.largestSingle[0].ada'
  - value: '7'
    label: committee seats
    source: 'committee.members.length'
  - value: '4'
    label: seats ending within twelve epochs
    source: 'committee.endingWithin12'
  - value: '3'
    label: seats running on
    source: 'derived[0].value'
ogFigure:
  value: '₳96.8M'
  label: largest withdrawal
  source: 'treasury.largestSingle[0].ada'
alsoDecided: []
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
  - value: 3
    op: diff
    from: ['committee.members.length', 'committee.endingWithin12']
corrections: []
---

## As of the close

As of the close of epoch 652, the [Update Constitutional Committee 2026](/ga/729daaf2f9f89f842a61f6e3ebf7e57d16d6fa4116e29c13114780cb39090850#0/) stood at 163 yes to 7 no, 69.9% by power. [Yoroi Wallet](/dreps/drep1yoroi/) voted yes. The treasury held 1,337.4 million ada at the start of epoch 650. 4 of 7 committee seats end within twelve epochs, 3 run on.

```chart
type: line
title: Treasury
sources: ["treasury.byEpochAda[].balanceAda"]
epochSource: "treasury.byEpochAda[].epoch"
epochFrom: 650
values: [1337.4, 1341.1]
yMin: 1300
yMax: 1700
format: M
```

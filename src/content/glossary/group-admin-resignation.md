---
term: "Resigning as group admin"
description: "An admin of a DRep group can resign with their own signature at any time. The key stays in the group's policy until it is replaced, but its signature no longer counts there."
group: "DRep groups"
order: 1
updated: 2026-11-10
---

A [DRep](/glossary/drep/) group is managed by policies over the DRep keys of its admins: a management policy and, in a permissioned group, an admission policy. An admin can **resign** from these roles at any time with their own signature, the same way a member can always leave the group. No other admin has to agree.

The resigned key stays inside the policy until the group replaces that policy, but its signature no longer counts there, and the group page lists it as resigned. Resigning does not end the membership. To become an admin again, the key has to be listed in a new policy and sign that update itself. If the remaining admins can no longer reach the threshold of the management policy, the group is frozen: nobody can change or dissolve it, while members can still leave.

## Related

- [DRep groups guide](/help/drep-groups/)
- [Group directory](/groups/)

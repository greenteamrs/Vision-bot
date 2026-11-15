---
name: OSRS user stats
description: Automatic syncing and manual corrections for members' OSRS progress stats.
---

The user chose automatic sync plus manual editing for total level, Combat Achievement tier, and collection-log count. Combat Achievement points are also required for TzKal eligibility.

**Why:** The user wants these stats on member records while still allowing staff to maintain values when automatic data is unavailable.

Manual corrections take precedence until cleared to return to automatic updates. Automatic sync must preserve locked values and must not replace missing or failed source data with zero.

**Why:** A deliberate staff correction must not disappear during the next background refresh, and unavailable data is not the same as zero progress.

Prefer WOM bulk data for both total level and collection-log count, and show those results before slower RuneProfile Combat Achievement checks. RuneProfile may fill missing WOM values.

**Why:** The user approved separating the fast bulk updates from slow individual lookups. WikiSync's published policy explicitly disallows third-party use of its API, so it is not an alternative source.

**How to apply:** Keep WOM-backed updates independent of RuneProfile latency and preserve partial results when one provider fails.

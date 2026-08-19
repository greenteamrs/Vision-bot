---
name: WOM rank mapping
description: How rank eligibility and Wise Old Man current-rank data work together.
---

The bot should continue calculating rank eligibility from configured days-in-clan, loot-point, and community-level thresholds. Wise Old Man supplies the player's current rank, and each bot rank has an adjustable WOM-name mapping because the names may differ between systems.

**Why:** WOM is the source of truth for the rank a player currently holds, but the bot's thresholds remain useful for deciding whether the player is eligible for advancement.

**How to apply:** Notify only when the highest eligible configured rank is above the mapped WOM rank. If no WOM mapping is available, retain the existing notification-history fallback.
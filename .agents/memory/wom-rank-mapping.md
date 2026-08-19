---
name: WOM rank mapping
description: How rank eligibility and Wise Old Man current-rank data work together.
---

The bot should continue calculating rank eligibility from configured days-in-clan, loot-point, and community-level thresholds. Wise Old Man supplies the player's current rank, and the existing dashboard rank name is used for the match. The configured names are expected to be aligned with WOM names over time.

**Why:** WOM is the source of truth for the rank a player currently holds, but the bot's thresholds remain useful for deciding whether the player is eligible for advancement. A separate mapping field would add unnecessary configuration.

**How to apply:** Notify only when the highest eligible configured rank is above the matching WOM rank. If names do not yet match, retain the existing notification-history fallback until the dashboard names are aligned.
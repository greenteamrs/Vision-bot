---
name: WOM rank mapping
description: How rank eligibility and Wise Old Man current-rank data work together.
---

The bot should continue calculating rank eligibility from configured days-in-clan, loot-point, and community-level thresholds. Wise Old Man supplies the player's current rank, and the existing dashboard rank name is used for the match. The configured names are expected to be aligned with WOM names over time.

Imp is a fixed rank: members who hold it do not receive rank-ups. This also applies to an original Imp rank underneath a seasonal rank.

In addition to the configured thresholds, Maxed requires at least **2376 total level**, TzKal requires at least **1965 Combat Achievement points**, and Collector requires at least **900 collection-log entries**. Every rank strictly higher than Leader in the configured hierarchy requires confirmed DropTracker setup.

**Why:** The user explicitly specified these membership rules. Combat Achievement tier alone does not prove the required points total.

**How to apply:** Enforce these additional requirements in both manual audits and automatic notifications. Unknown required stats must not count as meeting a threshold; same-priority alternatives still do not trigger rank-ups.

The dashboard hierarchy is named **Priority level**, with **1 highest**, shown before the rank name and listed top-down from 1.

**Why:** The user requested this priority convention; changing the presentation must not accidentally invert promotion eligibility.

Multiple ranks may share a priority level. Holding any rank at that level already satisfies that tier, even if the member qualifies for another rank at the same level.

**Why:** The user explicitly wants equal-priority alternatives to be treated as equivalent, not reported as rank-ups.

**How to apply:** Preserve shared priority numbers when saving or moving ranks. Only a strictly higher-priority eligible permanent rank can trigger a promotion result or automatic alert.

For temporary WOM ranks, use the underlying permanent rank instead; see [Seasonal ranks](seasonal-ranks.md). Temporary tiers are never promotion targets.

Ranks with notifications turned off are manually assigned to selected people. Exclude them from eligibility targets in both automatic alerts and manual checks. They may still be recognized as a member's current WOM rank to avoid suggesting a lower-ranked promotion.

A notification-enabled rank may include a free-text special requirement. When the numeric requirements are met, the alert should ask moderators to check that requirement rather than claiming the rank is fully completed.

The bot’s daily status message should distinguish a normal successful daily check from a later startup after a previous status was recorded.

**Why:** WOM is the source of truth for the rank a player currently holds, but the bot's thresholds remain useful for deciding whether the player is eligible for advancement. A separate mapping field would add unnecessary configuration.

**How to apply:** Notify only when the highest eligible configured rank is above the matching WOM rank. If names do not yet match, retain the existing notification-history fallback until the dashboard names are aligned.

Manual `/checkranks` and dashboard checks are audits, not notification jobs. They should report every user whose configured numeric thresholds qualify them for a notification-enabled rank above their recorded WOM rank, regardless of notification history.

The user reiterated that `/checkranks` must return all eligible Visionaries members, ignoring notification-disabled promotion tiers. Do not truncate the Discord results; split long output into multiple messages.

**Why:** The admin uses these manual checks to find rank promotions that have not happened yet, including cases where an alert was previously sent. The user clarified that notification-disabled ranks are manually given to selected people and must not be earned through system checks.

**How to apply:** Keep this audit read-only and separate from the daily notification process; compare eligibility with WOM rank rather than notification state.

Only members currently holding the Discord Visionaries role belong in rank-up checks. Members without a known RSN remain excluded from promotion results until linked. Do not send missing-RSN messages to Discord; show member information on the Vision dashboard instead.

**Why:** The user restricts rank progression to Visionaries and replaced the requested Discord messages with dashboard visibility: current Wise Old Man rank and a DropTracker setup confirmation.

**How to apply:** Fetch current Discord members for both manual and scheduled checks. Show WOM rank directly, not the highest eligible rank. Confirm DropTracker through a successful member sync rather than assuming any linked RSN means DropTracker is set up.
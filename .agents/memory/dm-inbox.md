---
name: DM inbox behavior
description: Unread badge expectations and shared staff read status.
---

The user wants the red DM badge to disappear once messages are read, rather than continuing to show the total saved message count.

**Why:** the user corrected the original total-count behavior.

**How to apply:** count unread messages only. Mark messages read when actually displayed in the active inbox, not when fetched in the background. New arrivals and unviewed messages must remain unread.

Read state is shared across dashboard staff, rather than personal to each login.

**Why:** this dashboard is being treated as a single shared staff inbox for the bot.

**How to apply:** keep read status persistent across staff sessions and bot restarts.

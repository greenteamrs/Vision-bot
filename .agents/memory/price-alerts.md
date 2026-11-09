---
name: OSRS price alerts
description: How item price alerts are sourced and who receives them.
---

Price alerts use the OSRS Wiki real-time prices API (prices.runescape.wiki), which requires a descriptive User-Agent. Alerts are created per Discord user with `/pricealert` (mods/admins) and DM the user who created them; one DM per crossing, re-armed when the price moves back.

**Why:** the user asked for DMs to them personally when an item reaches a price on that site.

**How to apply:** keep alerts personal to the creator, keep API polling light (single /latest call every 5 minutes), and never hammer the wiki.

Keep alerts after delivery rather than automatically deleting them; re-arm after the price moves back across the target.

**Why:** the user explicitly approved this behavior and confirmed that the test DM arrived.

**How to apply:** preserve repeat-crossing behavior unless the user requests a change.

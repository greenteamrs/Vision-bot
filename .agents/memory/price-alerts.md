---
name: OSRS price alerts
description: How item price alerts are sourced and who receives them.
---

Price alerts use the OSRS Wiki real-time prices API (prices.runescape.wiki), which requires a descriptive User-Agent. Alerts are created per Discord user with `/pricealert` (mods/admins) and DM the user who created them; one DM per crossing, re-armed when the price moves back.

**Why:** the user asked for DMs to them personally when an item reaches a price on that site.

**How to apply:** keep alerts personal to the creator, keep API polling light (single /latest call every 5 minutes), and never hammer the wiki.

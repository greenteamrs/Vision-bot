---
name: OSRS event system
description: The user's product decisions for the reusable OSRS event system.
---

Support Team Bingo/task boards, boss or collection races, drop competitions, and custom task/points events first. Dashboard users create and moderate events; clan members join and submit through Discord. Events can be solo or team-based per event, and multiple events can run at once. Use built-in scoring modes with adjustable values. Verify automatically only when the data is reliable; otherwise require proof review.

**Why:** these were the event formats and operating rules the user selected while planning the reusable system.

**How to apply:** preserve these defaults when extending event creation, moderation, scoring, or Discord participation.

Dashboard events should remind all Discord moderators one week before their start to make a post in the event channel. An optional event/tracker link must be included in that DM when provided.

**Why:** the user requested advance reminders so moderators can announce upcoming events.

**How to apply:** cover both Calendar entries and published scheduled event formats; do not notify for draft events. Use Discord moderator membership rather than dashboard account names, since those accounts are not linked to Discord recipients.

Manual reminder resends are additional announcements; they do not cancel the scheduled one-week reminder.

**Why:** moderators may resend before the one-week window, and that should not suppress the requested advance reminder.

**How to apply:** keep manual delivery tracking separate from automatic reminder deduplication.

The advent event runs December 1–25 with the daily boundary at 00:00 UTC. The user's supplied daily challenges must remain editable. Members submit picture evidence only for the current day; staff manage the calendar and review all submissions in the dashboard, like bingo. A fully usable, isolated test environment must come before any live activation.

**Why:** the user chose 25 days and UTC game time, supplied 25 challenges, and explicitly required testing before going live.

**How to apply:** keep simulated day advancement and test submissions separate from the real December schedule. Never activate the live event or reuse test progress as live progress without approval.

Admins may submit advent proof on behalf of a Discord member for a chosen already-opened day, including late proof. This exception must not consume that member's submission for the current day.

**Why:** the user requested an admin route for late pictures because member submissions always attach to the current day and allow only one pending or approved picture per day.

**How to apply:** keep normal member deadlines unchanged. Attribute admin uploads to the selected member and day, record the submitting admin, and retain staff approval and per-day duplicate protection.

Use one `/approve` command for picture submissions across all event formats, rather than requiring staff to learn a separate approval command for every format.

**Why:** the user requested one command where they can select a picture from any event and approve it.

**How to apply:** include new picture-based event formats in shared moderation while preserving each format's own scoring, team/tile/step choices and submission eligibility.

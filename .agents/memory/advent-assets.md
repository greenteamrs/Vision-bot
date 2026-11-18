---
name: Advent calendar assets
description: User-defined calendar image stages, external-host storage constraints, and safe image decoding.
---

Support 25 daily complete calendar pictures uploaded together and assigned individually to days. Keep a fully closed picture as an optional extra slot, not a requirement. Each daily picture shows the cumulative opened doors. The generated calendar remains acceptable for missing stages.

**Why:** the user initially requested closed and daily-opened versions, then clarified they have 25 pictures and want to upload them together and choose which belongs to each day.

**How to apply:** select the exact day's picture, never the closest earlier uploaded stage. Preserve custom pictures when resetting test progress.

Advent scoring is one point per approved daily challenge, out of 25. Pending and rejected pictures earn no points. Show completed and missed days on the dashboard scoreboard.

**Why:** the user approved this scoring proposal when requesting an advent scoreboard.

**How to apply:** count unique approved days per member within the current run, not raw submissions. Do not count the current or future days as missed.

Use one shared editable announcement template across all 25 daily challenges, with `{day}`, `{challenge}`, `{closes}`, and `{duration}` placeholders. Keep the one-time closing announcement separate.

**Why:** the user asked to stop editing the announcement separately for each day and use one message with variables.

**How to apply:** validate the rendered template against every daily challenge before saving; edits affect future posts only.

Post the calendar picture first as a normal image attachment, then the advent challenge text separately. Do not put the picture inside a Discord embed.

**Why:** the user requested a larger picture outside an embed, then changed the posting order to picture first and challenge text second.

**How to apply:** preserve that ordering for daily and closing announcements. Discord controls preview scaling; keep the original picture available to open.

Keep uploaded JPGs as JPGs without converting them to PNG or unnecessarily resizing/re-encoding them.

**Why:** the user approved preserving JPG files after a 2.1 MB JPG failed because forced PNG conversion expanded it past the 10 MB limit.

**How to apply:** retain the original JPEG bytes and format through storage, previews, downloads and Discord delivery; validate the image and keep upload limits in place.

Keep durable image storage compatible with the bot's Render hosting and existing MongoDB authentication/storage. The chosen file-storage approach is GridFS rather than ephemeral service disk or a Replit-only storage sidecar.

**Why:** the bot does not run inside Replit in production; new upload functionality must not require replacing the existing database or login system.

**How to apply:** preserve this hosting constraint when extending uploads or introducing live calendars; explicitly plan any storage migration rather than assuming a Replit runtime.

Do not decode untrusted uploads through the native image renderer.

**Why:** a malformed PNG caused a native segmentation fault, not a catchable JavaScript exception, during validation tests.

**How to apply:** bound file size and header dimensions before using a JavaScript image decoder. Use PNG checksum checks and explicit JPEG resolution/memory limits. Reserve the native renderer for trusted programmatically generated calendars.

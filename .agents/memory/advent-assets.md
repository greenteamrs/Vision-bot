---
name: Advent calendar assets
description: User-defined calendar image stages, external-host storage constraints, and safe image decoding.
---

Allow 26 independently replaceable, complete calendar pictures: one fully closed, followed by one cumulative opened-door picture for each of the 25 days. The generated calendar remains acceptable until the user supplies their own images.

**Why:** the user approved the generated picture for now but explicitly asked to upload their own closed and daily-opened versions later.

**How to apply:** select the exact day's picture, never the closest earlier uploaded stage. Preserve custom pictures when resetting test progress.

Keep durable image storage compatible with the bot's Render hosting and existing MongoDB authentication/storage. The chosen file-storage approach is GridFS rather than ephemeral service disk or a Replit-only storage sidecar.

**Why:** the bot does not run inside Replit in production; new upload functionality must not require replacing the existing database or login system.

**How to apply:** preserve this hosting constraint when extending uploads or introducing live calendars; explicitly plan any storage migration rather than assuming a Replit runtime.

Do not decode untrusted uploads through the native image renderer.

**Why:** a malformed PNG caused a native segmentation fault, not a catchable JavaScript exception, during validation tests.

**How to apply:** bound file size and header dimensions before using a JavaScript PNG parser with checksum checks. Reserve the native renderer for trusted programmatically generated calendars.

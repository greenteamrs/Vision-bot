---
name: Dashboard field locks
description: Dashboard edit permission policy for admin and moderator accounts.
---

The dashboard admin alone can toggle per-value locks. Moderators may edit adjustable dashboard values only when those values are unlocked. Enforce lock checks on the server as well as disabling locked controls in the interface.

**Why:** The admin needs to delegate dashboard work without allowing other admins/moderators to change selected settings.

**How to apply:** For every editable setting, name, or action, provide an admin-controlled lock state and reject moderator writes while that lock is active.

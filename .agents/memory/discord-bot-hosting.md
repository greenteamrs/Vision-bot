---
name: Discord bot hosting
description: The bot runs on Render, so production configuration and releases must target Render.
---

The Discord bot is hosted on Render, not Replit. Replit secrets and workflow restarts do not update the Render service; production environment changes and deployments must be made through Render.

**Why:** the user asked me to remember the bot's hosting setup.

**How to apply:** For bot runtime configuration, environment variables, logs, or releases, treat Render as production. Do not assume Replit secrets or workflow restarts affect the hosted bot.

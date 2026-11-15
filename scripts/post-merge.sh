#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Dependency changes must include the workspace lockfile.
pnpm install --frozen-lockfile
# The bot uses its existing MongoDB schemas; no SQL migration is needed here.

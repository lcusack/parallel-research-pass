#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec node --env-file-if-exists=.env --import tsx src/mcp.ts

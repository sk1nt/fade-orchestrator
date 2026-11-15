#!/usr/bin/env bash
# Bundle the extension for distribution. The host supplies the peer imports (omp resolves
# `@mariozechner/pi-coding-agent` for the types it strips at load and `typebox` at runtime), so
# both stay external. The interactive install path needs no build at all: omp loads
# `src/index.ts` directly from ~/.omp/agent/extensions/ (the runtime erases `import type`).
set -euo pipefail
cd "$(dirname "$0")"
npx --no-install esbuild src/index.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node22 \
  --external:@mariozechner/pi-coding-agent \
  --external:typebox \
  --outfile=dist/index.js
test -s dist/index.js && echo "built dist/index.js ($(wc -c < dist/index.js) bytes)"

#!/usr/bin/env node
// The rigs and the unit tests import the BUNDLED extension out of `.test-build/`, so any entry
// point that runs them has to build that bundle FIRST. Measured 2026-11-15: the pre-swap gate ran
// `node test/gate_rig.mjs` against a stale bundle left by an older source layout (pre-split, when
// `index.ts` reached `./router.ts` at runtime) and died with
// `ERR_MODULE_NOT_FOUND …/.test-build/router.mjs` — the rig IS the acceptance command, so it cannot
// assume somebody ran `npm test` earlier. The recipe lives here, once, and `npm run test:build` is
// this file.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const esbuild = (args) =>
  execFileSync("npx", ["--no-install", "esbuild", ...args], { cwd: ROOT, stdio: "pipe" });

export function buildTestBundle() {
  const out = join(ROOT, ".test-build");
  // A build dir is not a source dir: a stale bundle is exactly the defect this file exists to kill,
  // so it is emptied, never merged into.
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  esbuild([
    "src/keymap.ts",
    "src/livedata.ts",
    "src/history.ts",
    "src/core.ts",
    "src/moe.ts",
    "src/ui.ts",
    "--bundle",
    "--format=esm",
    "--platform=node",
    "--outdir=.test-build",
    "--out-extension:.js=.mjs",
  ]);
  esbuild([
    "src/index.ts",
    "--bundle",
    "--format=esm",
    "--platform=node",
    "--outfile=.test-build/index.mjs",
  ]);
}

// `node test/build.mjs` builds; imported, the caller calls buildTestBundle() itself.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) buildTestBundle();

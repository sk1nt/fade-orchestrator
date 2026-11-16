#!/usr/bin/env node
// The rigs and the unit tests import the BUNDLED extension out of `.test-build/`, so any entry point
// that runs them builds that bundle FIRST. The build dir is EMPTIED, never merged into: a stale
// bundle is exactly the defect this file kills.

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
    "src/screendata.ts",
    "src/panel.ts",
    "src/router.ts",
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

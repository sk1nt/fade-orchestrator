#!/usr/bin/env node
// The rigs and the unit tests import the BUNDLED extension out of `.test-build/`, so any entry point
// that runs them builds that bundle FIRST. A build never merges into an old bundle — a stale bundle
// is exactly the defect this file kills — and it never empties a directory a running importer can
// see, which is the other defect it kills.

import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The stable name importers use: a symlink to one build stamp. */
export const LINK = join(ROOT, ".test-build");
/** Where the stamps live; `.test-build` always points at one of them. */
const STAMPS = join(ROOT, ".test-build.stamps");
/** Stamps kept after a build: the newest, plus enough history that a file importing during the
 *  swap finishes against the bundle it resolved. */
const KEEP = 4;

const esbuild = (args) =>
  execFileSync("npx", ["--no-install", "esbuild", ...args], { cwd: ROOT, stdio: "pipe" });

export function buildTestBundle() {
  // A fresh stamp per build: `rmSync` of a SHARED build dir races a parallel `node --test` run,
  // where one file's import lands in the directory another file just emptied (measured as a
  // file-level `not ok` on test/core.test.mjs, once every few runs).
  const stamp = `b-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const out = join(STAMPS, stamp);
  mkdirSync(out, { recursive: true });
  esbuild([
    "src/keymap.ts",
    "src/livedata.ts",
    "src/history.ts",
    "src/core.ts",
    "src/desk.ts",
    "src/lane.ts",
    "src/triage.ts",
    "src/subagent.ts",
    "src/moe.ts",
    "src/taskmoe.ts",
    "src/ui.ts",
    "src/screendata.ts",
    "src/panel.ts",
    "src/runs.ts",
    "src/router.ts",
    "src/thinklane.ts",
    "--bundle",
    "--format=esm",
    "--platform=node",
    `--outdir=.test-build.stamps/${stamp}`,
    "--out-extension:.js=.mjs",
  ]);
  esbuild([
    "src/index.ts",
    "--bundle",
    "--format=esm",
    "--platform=node",
    `--outfile=.test-build.stamps/${stamp}/index.mjs`,
  ]);
  // One-time migration: the first run replaces the plain directory the old scheme left with the
  // symlink. A symlink is replaced atomically by `rename`; a directory is not, so it is removed
  // here, in the one window where no importer of this new scheme can be looking at it.
  try {
    if (!lstatSync(LINK).isSymbolicLink()) rmSync(LINK, { recursive: true, force: true });
  } catch {
    // No `.test-build` yet: nothing to migrate.
  }
  // ONE rename swaps the name: a reader resolves the old bundle or the new one, never a gap.
  // `rename` over a symlink replaces it, so the swap needs no unlinked window.
  const tmp = `${LINK}.swap-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  symlinkSync(out, tmp);
  renameSync(tmp, LINK);
  prune();
}

/** Drop all but the newest stamps; a stamp a running importer holds stays until it ages out. */
function prune() {
  let names;
  try {
    names = readdirSync(STAMPS);
  } catch {
    return;
  }
  const stamps = names
    .map((name) => ({ name, at: statSync(join(STAMPS, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { name } of stamps.slice(KEEP)) {
    try {
      rmSync(join(STAMPS, name), { recursive: true, force: true });
    } catch {
      // A build in flight in another process: the next run prunes it.
    }
  }
}

// `node test/build.mjs` builds; imported, the caller calls buildTestBundle() itself.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) buildTestBundle();

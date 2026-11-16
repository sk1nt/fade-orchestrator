#!/usr/bin/env node
// The shared fixtures the rigs and the unit tests used to each re-implement.

import { execFileSync } from "node:child_process";

/** `git` scoped to one directory. */
const gitAt = (dir) => (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });

/**
 * Make `dir` a git working tree with its own identity: `git diff` outside a working tree does not
 * fail, it switches to `--no-index` mode and prints a usage page, and that text rides into the
 * briefing a rig is asserting on. Returns the scoped `git` for a caller's own follow-up commands.
 */
export function initRepo(dir) {
  const git = gitAt(dir);
  git("init", "-q");
  git("config", "user.email", "fixture@localhost");
  git("config", "user.name", "fade-orchestrator-fixture");
  return git;
}

/** One commit of everything in `dir`, so the working tree has a HEAD to diff against. */
export function commitAll(dir, message = "fixture seed") {
  const git = gitAt(dir);
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

/**
 * Drop the CALLER's session identity from `env`. A `task` agent's `PI_SESSION_FILE` is nested
 * inside a dated parent dir — exactly the shape `isDelegatedSession` reads as a delegated subagent.
 * Inherited, the rig's own session is classified delegated: the seeded run is never adopted, every
 * `fade_phase` is refused, and the status row is suppressed by the `owned` rule.
 */
export function stripSessionEnv(env) {
  delete env.PI_SESSION_FILE;
  delete env.PI_SESSION_ID;
  return env;
}

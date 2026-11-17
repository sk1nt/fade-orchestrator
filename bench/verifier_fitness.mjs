#!/usr/bin/env node
/**
 * Verifier-lane fitness bench.
 *
 * The snippet bench pastes code into a prompt with tools disabled. This one measures the rubric the
 * Fade orchestrator hands its verification lane (`src/subagent.ts`: `verifierAgentMd()`,
 * `verifierTaskBody()`):
 *
 *   1. run EVERY check command yourself, in the repo cwd — a check you did not run cannot be accepted
 *   2. read the diff (`git status --porcelain`, `git diff`)
 *   3. post exactly one verdict, `notes` naming the command and what it printed
 *
 * Fitness = (a) right verdict vs gold, (b) the checks were actually run, (c) the notes name what was seen.
 *
 * Two executors, one slice set:
 *   A  the Grok Build CLI, tools ALLOWED, bounded --max-turns; its tool calls are observed from the
 *      documented `--output-format streaming-json` NDJSON (`tool_call.rawInput.command`,
 *      `tool_call_update.rawOutput.{command,exit_code}`, `end.{stopReason,usage,num_turns}`).
 *   B  the local lane (OpenAI-compatible /v1), driven by the minimal ReAct loop THIS bench implements:
 *      the model emits `RUN: <shell command>`, the bench runs it (30 s cap) and feeds the output back.
 *
 * Usage: node bench/verifier_fitness.mjs   (no npm deps, no network beyond the two endpoints)
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const T0 = Date.now();
const ROOT = `/tmp/verifier-bench-${process.pid}`;
const GROK_BIN = process.env.VERIFIER_BENCH_GROK ?? `${process.env.HOME}/.grok/bin/grok`;
const B_URL = process.env.VERIFIER_BENCH_URL ?? "http://127.0.0.1:18001/v1";
const B_MODEL = process.env.VERIFIER_BENCH_MODEL ?? "coder-gpu1";
const B_CTX = 262144;
const B_MAX_TOKENS = 4096;
const B_RUN_TURNS = 4;
const B_CMD_CAP_S = 30;
const A_MAX_TURNS = 5;
const A_CAP_S = 150;
const RESULTS_MD = process.env.VERIFIER_BENCH_RESULTS ?? join(import.meta.dirname, "verifier-fitness-results.md");

const L = (...lines) => lines.join("\n") + "\n";

/** The check script every fixture carries: 0 on pass, non-zero with a named failure on the defect. */
const checkSh = (name) => L(
	"#!/usr/bin/env bash",
	`# ${name}: the contract test for this slice. Exit 0 = accepted, non-zero = named failure.`,
	"export NO_COLOR=1",
	"unset FORCE_COLOR 2>/dev/null || true",
	'node --test --test-reporter=spec test/*.test.mjs',
	"rc=$?",
	"if [ $rc -ne 0 ]; then",
	`  echo "CHECK FAILED: ${name} — node --test exited $rc with a failing assertion (see the test name above)"`,
	"  exit 1",
	"fi",
	`echo "CHECK PASSED: ${name} — every assertion held"`,
	"exit 0",
);

const CHECKS = (test) => [
	["bash check.sh", "exit 0, every assertion in the contract test passes"],
	["git status --porcelain", "empty for a clean slice; names the changed src/ file for a planted defect"],
	["git diff", "empty for a clean slice; shows the exact behavioural change for a planted defect"],
];

const SLICES = [
	{
		id: "V1", slug: "drain_off_by_one", gold: "needs_repair",
		objective: "drain(items, n) in src/drain.mjs must return at most n items from the queue head.",
		acceptance: "bash check.sh exits 0 with every assertion in test/drain.test.mjs passing",
		checks: CHECKS("drain contract"),
	},
	{
		id: "V2", slug: "retry_budget", gold: "needs_repair",
		objective: "sendWithRetry(send, budget) in src/retry.mjs must spend one budget unit per failed attempt and raise Exhausted when it runs out.",
		acceptance: "bash check.sh exits 0 and the timeout path is bounded by the budget",
		checks: CHECKS("retry budget contract"),
	},
	{
		id: "V3", slug: "prune_clean", gold: "accepted",
		objective: "pruneSessions(sessions, maxAge) in src/prune.mjs must drop stale sessions without mutating the input.",
		acceptance: "bash check.sh exits 0 with every assertion in test/prune.test.mjs passing",
		checks: CHECKS("prune contract"),
	},
	{
		id: "V4", slug: "backoff_clean", gold: "accepted",
		objective: "delayFor(attempt, seed) in src/backoff.mjs must return a capped exponential delay with deterministic jitter in [exp/2, exp].",
		acceptance: "bash check.sh exits 0 and the delay stays inside the cap and the jitter bounds",
		checks: CHECKS("backoff contract"),
	},
	{
		id: "V5", slug: "float_tick", gold: "needs_repair",
		objective: "isRoundTrip(price, tick, target) in src/tick.mjs must accept a price within half a tick of the target, on a float tick grid.",
		acceptance: "bash check.sh exits 0 and the half-tick comparison tolerates binary float representation error",
		checks: CHECKS("tick round-trip contract"),
	},
	{
		id: "V6", slug: "partial_send", gold: "needs_repair",
		objective: "sendAll(sock, bytes) in src/send.mjs must transmit every byte, resuming partial writes.",
		acceptance: "bash check.sh exits 0 having written all 9 bytes through a socket that writes at most 4 per call",
		checks: CHECKS("partial-write contract"),
	},
	{
		id: "V7", slug: "session_window_clean", gold: "accepted",
		objective: "inSession(tsMs) in src/window.mjs must be true only inside 09:30-16:00 UTC, computed from UTC fields with no wall clock.",
		acceptance: "bash check.sh exits 0 for the fixed epoch instants in test/window.test.mjs",
		checks: CHECKS("session window contract"),
	},
	{
		id: "V8", slug: "dedup_order", gold: "needs_repair",
		objective: "dedupFirst(items) in src/dedup.mjs must keep the FIRST occurrence of each key and preserve input order.",
		acceptance: "bash check.sh exits 0 with the first-occurrence order asserted",
		checks: CHECKS("dedup order contract"),
	},
];

/** Per-slug file table: base = the committed tree; defect = the planted working-tree change. */
const FILES = {
	drain_off_by_one: {
		"src/drain.mjs": {
			base: L(
				"export function drain(items, n) {",
				"\tconst out = [];",
				"\tfor (let i = 0; i < n && i < items.length; i++) out.push(items[i]);",
				"\treturn out;",
				"}",
			),
			defect: L(
				"export function drain(items, n) {",
				"\tconst out = [];",
				"\tfor (let i = 0; i <= n && i < items.length; i++) out.push(items[i]);",
				"\treturn out;",
				"}",
			),
		},
		"test/drain.test.mjs": L(
			'import { test } from "node:test";',
			'import assert from "node:assert/strict";',
			'import { drain } from "../src/drain.mjs";',
			"",
			"const items = [1, 2, 3, 4, 5];",
			"",
			'test("drain returns at most n items from the head", () => {',
			"\tassert.deepEqual(drain(items, 3), [1, 2, 3]);",
			"\tassert.deepEqual(drain(items, 0), []);",
			"\tassert.equal(drain(items, 9).length, 5);",
			"});",
		),
	},
	retry_budget: {
		"src/retry.mjs": {
			base: L(
				"export class Exhausted extends Error {}",
				"",
				"export function sendWithRetry(send, budget) {",
				"\tlet left = budget;",
				"\twhile (left > 0) {",
				"\t\tconst r = send();",
				'\t\tif (r === "ok") return left;',
				"\t\tleft -= 1;",
				"\t}",
				'\tthrow new Exhausted("retry budget exhausted");',
				"}",
			),
			defect: L(
				"export class Exhausted extends Error {}",
				"",
				"export function sendWithRetry(send, budget) {",
				"\tlet left = budget;",
				"\twhile (left > 0) {",
				"\t\tconst r = send();",
				'\t\tif (r === "ok") return left;',
				'\t\tif (r === "Timeout") continue;',
				"\t\tleft -= 1;",
				"\t}",
				'\tthrow new Exhausted("retry budget exhausted");',
				"}",
			),
		},
		"test/retry.test.mjs": L(
			'import { test } from "node:test";',
			'import assert from "node:assert/strict";',
			'import { sendWithRetry, Exhausted } from "../src/retry.mjs";',
			"",
			'test("a timeout spends exactly one unit of the retry budget", () => {',
			"\tlet calls = 0;",
			"\tconst send = () => {",
			"\t\tcalls += 1;",
			'\t\tif (calls > 64) throw new Error("runaway: send called " + calls + " times, a budget of 3 was never spent");',
			'\t\treturn "Timeout";',
			"\t};",
			"\tassert.throws(() => sendWithRetry(send, 3), Exhausted);",
			"\tassert.equal(calls, 3);",
			"});",
		),
	},
	prune_clean: {
		"src/prune.mjs": {
			base: L(
				"export function pruneSessions(sessions, maxAge) {",
				"\tconst keep = [];",
				"\tfor (const s of sessions) {",
				"\t\tif (s.ageMs <= maxAge) keep.push(s);",
				"\t}",
				"\treturn keep;",
				"}",
			),
		},
		"test/prune.test.mjs": L(
			'import { test } from "node:test";',
			'import assert from "node:assert/strict";',
			'import { pruneSessions } from "../src/prune.mjs";',
			"",
			'test("stale sessions are dropped and the input is untouched", () => {',
			'\tconst sessions = [{ id: "a", ageMs: 10 }, { id: "b", ageMs: 900 }, { id: "c", ageMs: 500 }];',
			"\tconst kept = pruneSessions(sessions, 500);",
			'\tassert.deepEqual(kept.map((s) => s.id), ["a", "c"]);',
			"\tassert.equal(sessions.length, 3);",
			"});",
		),
	},
	backoff_clean: {
		"src/backoff.mjs": {
			base: L(
				"const BASE_MS = 50;",
				"const CAP_MS = 1600;",
				"",
				"function jitter(seed) {",
				"\tconst x = (seed * 1103515245 + 12345) % 2147483648;",
				"\treturn x / 2147483648;",
				"}",
				"",
				"export function delayFor(attempt, seed) {",
				"\tconst exp = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, attempt));",
				"\treturn Math.round(exp * (0.5 + 0.5 * jitter(seed)));",
				"}",
			),
		},
		"test/backoff.test.mjs": L(
			'import { test } from "node:test";',
			'import assert from "node:assert/strict";',
			'import { delayFor } from "../src/backoff.mjs";',
			"",
			'test("the delay is capped and the jitter stays in [exp/2, exp]", () => {',
			"\tfor (let attempt = 0; attempt <= 12; attempt++) {",
			"\t\tconst exp = Math.min(1600, 50 * 2 ** attempt);",
			"\t\tfor (const seed of [1, 7, 42, 99991]) {",
			"\t\t\tconst d = delayFor(attempt, seed);",
			"\t\t\tassert.ok(d >= Math.round(exp / 2) && d <= exp, `attempt ${attempt} seed ${seed} delay ${d} outside [${Math.round(exp / 2)}, ${exp}]`);",
			"\t\t\tassert.equal(delayFor(attempt, seed), d);",
			"\t\t}",
			"\t}",
			"\tassert.ok(delayFor(30, 5) <= 1600);",
			"});",
		),
	},
	float_tick: {
		"src/tick.mjs": {
			base: L(
				"export function isRoundTrip(price, tick, target) {",
				"\treturn Math.abs(price - target) <= tick / 2 + 1e-9;",
				"}",
			),
			defect: L(
				"export function isRoundTrip(price, tick, target) {",
				"\treturn price === target;",
				"}",
			),
		},
		"test/tick.test.mjs": L(
			'import { test } from "node:test";',
			'import assert from "node:assert/strict";',
			'import { isRoundTrip } from "../src/tick.mjs";',
			"",
			'test("a price within half a tick of the grid target round-trips", () => {',
			"\tconst target = 0.1 * 3; // 0.30000000000000004 on the binary grid",
			"\tassert.equal(isRoundTrip(0.3, 0.1, target), true);",
			"\tassert.equal(isRoundTrip(0.4, 0.1, target), false);",
			"});",
		),
	},
	partial_send: {
		"src/send.mjs": {
			base: L(
				"export function sendAll(sock, bytes) {",
				"\tlet off = 0;",
				"\twhile (off < bytes.length) {",
				"\t\tconst n = sock.send(bytes, off);",
				'\t\tif (n <= 0) throw new Error("socket closed at offset " + off);',
				"\t\toff += n;",
				"\t}",
				"\treturn off;",
				"}",
			),
			defect: L(
				"export function sendAll(sock, bytes) {",
				"\treturn sock.send(bytes, 0);",
				"}",
			),
		},
		"test/send.test.mjs": L(
			'import { test } from "node:test";',
			'import assert from "node:assert/strict";',
			'import { sendAll } from "../src/send.mjs";',
			"",
			'test("partial writes are resumed until every byte is out", () => {',
			"\tconst bytes = new Uint8Array(9);",
			"\tlet written = 0;",
			"\tconst sock = {",
			"\t\tsend(b, off) {",
			"\t\t\tconst n = Math.min(4, b.length - off);",
			"\t\t\twritten += n;",
			"\t\t\treturn n;",
			"\t\t},",
			"\t};",
			"\tassert.equal(sendAll(sock, bytes), 9);",
			"\tassert.equal(written, 9);",
			"});",
		),
	},
	session_window_clean: {
		"src/window.mjs": {
			base: L(
				"const OPEN_UTC_MIN = 570;  // 09:30",
				"const CLOSE_UTC_MIN = 960; // 16:00",
				"",
				"export function minutesOfUtc(tsMs) {",
				"\tconst d = new Date(tsMs);",
				"\treturn d.getUTCHours() * 60 + d.getUTCMinutes();",
				"}",
				"",
				"export function inSession(tsMs) {",
				"\tconst m = minutesOfUtc(tsMs);",
				"\treturn m >= OPEN_UTC_MIN && m < CLOSE_UTC_MIN;",
				"}",
			),
		},
		"test/window.test.mjs": L(
			'import { test } from "node:test";',
			'import assert from "node:assert/strict";',
			'import { inSession } from "../src/window.mjs";',
			"",
			"const at = (h, m) => Date.UTC(2026, 10, 17, h, m, 0);",
			"",
			'test("the session window is 09:30-16:00 UTC", () => {',
			"\tassert.equal(inSession(at(9, 29)), false);",
			"\tassert.equal(inSession(at(9, 30)), true);",
			"\tassert.equal(inSession(at(12, 0)), true);",
			"\tassert.equal(inSession(at(16, 0)), false);",
			"\tassert.equal(inSession(at(3, 0)), false);",
			"});",
		),
	},
	dedup_order: {
		"src/dedup.mjs": {
			base: L(
				"export function dedupFirst(items) {",
				"\tconst seen = new Set();",
				"\tconst out = [];",
				"\tfor (const it of items) {",
				"\t\tif (!seen.has(it.k)) {",
				"\t\t\tseen.add(it.k);",
				"\t\t\tout.push(it);",
				"\t\t}",
				"\t}",
				"\treturn out;",
				"}",
			),
			defect: L(
				"export function dedupFirst(items) {",
				"\tconst out = [];",
				"\tfor (const it of items) {",
				"\t\tconst i = out.findIndex((o) => o.k === it.k);",
				"\t\tif (i === -1) out.push(it);",
				"\t\telse out[i] = it;",
				"\t}",
				"\treturn out;",
				"}",
			),
		},
		"test/dedup.test.mjs": L(
			'import { test } from "node:test";',
			'import assert from "node:assert/strict";',
			'import { dedupFirst } from "../src/dedup.mjs";',
			"",
			'test("the first occurrence wins and input order is preserved", () => {',
			'\tconst items = [{ k: "b", n: 1 }, { k: "a", n: 2 }, { k: "b", n: 3 }];',
			'\tassert.deepEqual(dedupFirst(items), [{ k: "b", n: 1 }, { k: "a", n: 2 }]);',
			'\tassert.deepEqual(dedupFirst([{ k: "x", n: 1 }, { k: "x", n: 2 }, { k: "y", n: 3 }]), [{ k: "x", n: 1 }, { k: "y", n: 3 }]);',
			"});",
		),
	},
};

// ---- fixtures ---------------------------------------------------------------

const git = (cwd, args) => spawnSync("git", ["-c", "safe.directory=*", ...args], { cwd, encoding: "utf8" });

/** Run a shell command in a cwd with a wall cap; returns exit code and captured stdout+stderr. */
function sh(cwd, command, capS = 60) {
	const t0 = Date.now();
	const p = spawnSync("bash", ["-lc", command], { cwd, encoding: "utf8", timeout: capS * 1000, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "" } });
	const out = `${p.stdout ?? ""}${p.stderr ?? ""}`;
	if (p.error && p.error.name === "AbortError") return { exit: 124, out: `${out}\n[timed out after ${capS}s]`, ms: Date.now() - t0, timedOut: true };
	return { exit: p.status ?? (p.signal ? 128 : 127), out, ms: Date.now() - t0, timedOut: false };
}

/** One slice = one real git repo: commit the base, plant the defect in the working tree, self-test it. */
function buildFixture(slice, n) {
	const dir = join(ROOT, `${n}-${slice.slug}`);
	mkdirSync(dir, { recursive: true });
	const table = FILES[slice.slug];
	const planted = slice.gold === "needs_repair";
	for (const [rel, spec] of Object.entries(table)) {
		mkdirSync(join(dir, rel).slice(0, join(dir, rel).lastIndexOf("/")), { recursive: true });
		writeFileSync(join(dir, rel), typeof spec === "string" ? spec : spec.base);
	}
	writeFileSync(join(dir, "check.sh"), checkSh(slice.slug));
	chmodSync(join(dir, "check.sh"), 0o755);
	writeFileSync(join(dir, "slice.json"), `${JSON.stringify({ id: slice.id, objective: slice.objective, acceptance: slice.acceptance, checks: slice.checks, gold: slice.gold }, null, 2)}\n`);
	writeFileSync(join(dir, "README.md"), `# ${slice.id} — ${slice.slug}\n\nVerification target. READ-ONLY: judge the working tree, never edit it.\nRun the checks in the checks list of slice.json, in this cwd.\n`);
	const init = [git(dir, ["init", "-q"]), git(dir, ["config", "user.email", "bench@invalid"]), git(dir, ["config", "user.name", "verifier-bench"]), git(dir, ["add", "-A"]), git(dir, ["commit", "-qm", "base"])];
	for (const g of init) if (g.status !== 0) throw new Error(`git failed in ${dir}: ${g.stderr}`);
	if (planted) for (const [rel, spec] of Object.entries(table)) if (spec.defect) writeFileSync(join(dir, rel), spec.defect);

	const run = sh(dir, "bash check.sh", 60);
	const status = git(dir, ["status", "--porcelain"]).stdout.trim();
	const diffStat = git(dir, ["diff", "--stat"]).stdout.trim();
	const selftest = { checkRc: run.exit, checkOut: run.out.trim().split("\n").slice(-3).join(" | "), dirty: status.split("\n").filter(Boolean), diffStat };
	if (planted && (run.exit === 0 || !status)) throw new Error(`fixture ${slice.id}: planted defect did not fail check.sh (rc=${run.exit}) or left no diff`);
	if (!planted && run.exit !== 0) throw new Error(`fixture ${slice.id}: clean slice failed check.sh (rc=${run.exit})\n${run.out}`);
	return { dir, selftest };
}

// ---- the rubric, verbatim from src/subagent.ts ------------------------------

const RUBRIC = [
	"You are the fade orchestrator's verification lane for ONE batch of one id.",
	"",
	"Rules:",
	"1. Run every check command yourself, in the session cwd, and judge on what it printed. A check",
	"   you did not run cannot be accepted.",
	"2. Inspect the diff for the files the request names: `git status --porcelain`, `git diff`.",
	"3. You are READ-ONLY on the tree. Never edit, write, patch, commit, restart a service, touch the",
	"   basalt router, or start a long-running process. Report the cause; the coder fixes it.",
	"4. Judge ONLY this id. Post exactly one verdict: a single JSON object on your final line —",
	'   {"id":"<id>","accepted":true|false,"notes":"..."} — where accepted=true means "accepted"',
	'   and accepted=false means "needs_repair". In `notes`, name the command and what it printed, or',
	"   the cause the coder must fix. An id you did not judge is a defect, not a pass.",
].join("\n");

/** The task page, in the shape of subagent.ts verifierTaskBody(). */
function taskPage(slice, protocol) {
	const checks = slice.checks.map(([cmd, expected]) => `    - \`${cmd}\` (expected ${expected})`).join("\n");
	return [
		"# Verification batch 1",
		"",
		`Ids to judge: ${slice.id}`,
		"",
		"Requests:",
		`  - ${slice.id} (worker Verify1, task ${slice.slug}): ${slice.objective}`,
		`    acceptance: ${slice.acceptance}`,
		`  checks:\n${checks}`,
		"",
		"The session cwd is the repo you are judging. `slice.json` repeats the id, objective, acceptance,",
		"checks, and holds a `gold` field you MUST ignore (it is the bench's answer key, not evidence).",
		"",
		protocol,
	].join("\n");
}

const PROTOCOL_A = "Run the checks with your shell tool, then reply with ONLY the one JSON object.";
const PROTOCOL_B = [
	"Protocol: you have no shell of your own. To run a command, emit ONE line of the exact form",
	"  RUN: <shell command>",
	"and nothing else on that line. The harness runs it in the session cwd and answers with its output.",
	"Emit one RUN: line per turn (you have at most 4 turns). When the checks you needed have run, reply",
	"with ONLY the one JSON object and no RUN: line.",
].join("\n");

// ---- verdict parsing --------------------------------------------------------

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n[... clipped ${s.length - n} chars]` : s);

/** The last balanced JSON object in the text carrying an `accepted` key. */
function parseVerdict(text) {
	const found = [];
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== "{") continue;
		let depth = 0, inStr = false, esc = false;
		for (let j = i; j < text.length; j++) {
			const ch = text[j];
			if (inStr) {
				if (esc) esc = false;
				else if (ch === "\\") esc = true;
				else if (ch === '"') inStr = false;
				continue;
			}
			if (ch === '"') inStr = true;
			else if (ch === "{") depth += 1;
			else if (ch === "}") {
				depth -= 1;
				if (depth === 0) {
					try {
						const o = JSON.parse(text.slice(i, j + 1));
						if (o && typeof o === "object" && "accepted" in o) found.push(o);
					} catch { /* not JSON, keep scanning */ }
					i = j;
					break;
				}
			}
		}
	}
	const o = found[found.length - 1];
	if (!o) return null;
	const accepted = o.accepted === true || String(o.accepted).trim().toLowerCase() === "true";
	return { id: typeof o.id === "string" ? o.id : "", accepted, notes: typeof o.notes === "string" ? o.notes : "" };
}

/** Normalise a command / notes string for the "notes names a command I ran" test. */
const norm = (s) => String(s).toLowerCase().replace(/["`']/g, "").replace(/[\s,.;:]+/g, " ").trim();

/** The command strings a notes line could be naming: the full command and each of its segments. */
function commandForms(command) {
	const forms = new Set([String(command).trim()]);
	for (const seg of String(command).split(/&&|\|\||;|\|/)) {
		const t = seg.trim();
		if (t) forms.add(t);
		if (t.startsWith("bash ") || t.startsWith("sh ") || t.startsWith("node ")) forms.add(t.replace(/^(bash|sh|node)\s+/, ""));
	}
	return [...forms].filter((f) => norm(f).length >= 4).map(norm);
}

/** Check-compliance: the notes name a command the harness OBSERVED running in that slice. */
function compliant(notes, observed) {
	const n = norm(notes);
	return observed.some((o) => commandForms(o.command).some((f) => n.includes(f)));
}

/** The slice's check commands that a notes line cites. */
function citedChecks(notes, canon) {
	const n = norm(notes);
	return canon.filter((c) => commandForms(c).some((f) => n.includes(f)));
}

/** The stricter reading of the rubric: EVERY check the notes cites must have been observed running. */
function allCitedRun(notes, canon, observed) {
	const cited = citedChecks(notes, canon);
	if (cited.length === 0) return false;
	const forms = new Set(observed.flatMap((o) => commandForms(o.command)));
	return cited.every((c) => commandForms(c).some((f) => forms.has(f)));
}

// ---- executor A: the Grok Build CLI, tools allowed --------------------------

function runA(slice, fixture) {
	const prompt = `${RUBRIC}\n\n${taskPage(slice, PROTOCOL_A)}`;
	const args = ["-p", prompt, "--cwd", fixture.dir, "--output-format", "streaming-json", "--max-turns", String(A_MAX_TURNS), "--no-subagents", "--disable-web-search"];
	const t0 = Date.now();
	const p = spawnSync(GROK_BIN, args, { encoding: "utf8", timeout: A_CAP_S * 1000, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "" } });
	const wall = (Date.now() - t0) / 1000;
	const observed = [];
	let text = "";
	let end = null;
	let usage = null;
	for (const line of String(p.stdout ?? "").split("\n")) {
		let e;
		try { e = JSON.parse(line); } catch { continue; }
		if (e.type === "text") text += e.data ?? "";
		else if (e.type === "usage") usage = e.usage ?? usage;
		else if (e.type === "end") end = e;
		else if (e.type === "tool_call") observed.push({ id: e.toolCallId, command: String(e.rawInput?.command ?? e.title ?? ""), exit: null });
		else if (e.type === "tool_call_update") {
			const ro = e.rawOutput;
			if (ro && typeof ro.command === "string" && Number.isInteger(ro.exit_code)) {
				const rec = observed.find((o) => o.id === e.toolCallId && o.exit === null) ?? (observed.push({ id: e.toolCallId, command: "", exit: null }), observed[observed.length - 1]);
				rec.command = ro.command;
				rec.exit = ro.exit_code;
			}
		}
	}
	const u = end?.usage ?? usage ?? {};
	const ran = observed.filter((o) => o.exit !== null);
	return {
		slice: slice.id, executor: "A", exit: p.status ?? (p.error ? -1 : 0),
		stopReason: end?.stopReason ?? (p.error ? `spawn:${p.error.name}` : "no_end_event"),
		turns: end?.num_turns ?? null, inTok: u.input_tokens ?? null, outTok: u.output_tokens ?? null,
		wall, observed: ran, text: clip(text, 4000),
		verdict: parseVerdict(text),
		error: p.status !== 0 ? clip(`${p.stderr ?? ""}`.trim(), 400) : "",
	};
}

// ---- executor B: the local lane, driven by this bench's ReAct loop -----------

const KEY_CMD = 'source ~/.config/fade/ninfer-backend.env && printf %s "${NINFER_API_KEY:-}"';

function bKey() {
	const primary = spawnSync("bash", ["-lc", KEY_CMD], { encoding: "utf8" }).stdout?.trim() ?? "";
	if (primary) return { key: primary, note: "" };
	const alt = spawnSync("bash", ["-lc", 'source ~/.config/fade/ninfer-backend.env && printf %s "${FADE_NINFER_API_KEY:-}"'], { encoding: "utf8" }).stdout?.trim() ?? "";
	return { key: alt, note: `the specified key command printed 0 bytes (${KEY_CMD}); fell back to FADE_NINFER_API_KEY from the same file (${alt.length ? "found" : "also absent"})` };
}

async function chatB(messages, key) {
	const t0 = Date.now();
	try {
		const res = await fetch(`${B_URL}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
			body: JSON.stringify({ model: B_MODEL, messages, max_tokens: B_MAX_TOKENS, temperature: 0, stream: false }),
			signal: AbortSignal.timeout(120_000),
		});
		const body = await res.text();
		if (!res.ok) return { ok: false, error: `POST ${B_URL}/chat/completions -> HTTP ${res.status}: ${clip(body, 300)}`, wall: (Date.now() - t0) / 1000 };
		const j = JSON.parse(body);
		return {
			ok: true,
			content: j.choices?.[0]?.message?.content ?? "",
			inTok: j.usage?.prompt_tokens ?? null, outTok: j.usage?.completion_tokens ?? null,
			wall: (Date.now() - t0) / 1000,
		};
	} catch (e) {
		return { ok: false, error: `POST ${B_URL}/chat/completions -> ${e.name}: ${e.message}${cause(e)}`, wall: (Date.now() - t0) / 1000 };
	}
}

async function probeB() {
	const { key, note } = bKey();
	const headers = { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
	try {
		const res = await fetch(`${B_URL}/models`, { headers, signal: AbortSignal.timeout(10_000) });
		const body = await res.text();
		if (!res.ok) return { available: false, error: `GET ${B_URL}/models -> HTTP ${res.status}: ${clip(body, 300)}`, keyNote: note };
		let ids = [];
		try { ids = (JSON.parse(body).data ?? []).map((m) => m.id); } catch { /* non-JSON body */ }
		const one = await chatB([{ role: "user", content: "Reply with exactly: OK" }], key);
		if (!one.ok) return { available: false, error: `GET ${B_URL}/models -> HTTP ${res.status} ok, then ${one.error}`, keyNote: note };
		return { available: true, models: ids, probe: clip(one.content.trim(), 80), keyNote: note };
	} catch (e) {
		return { available: false, error: `GET ${B_URL}/models -> ${e.name}: ${e.message}${cause(e)}`, keyNote: note };
	}
}

async function runB(slice, fixture, key) {
	const messages = [{ role: "system", content: RUBRIC }, { role: "user", content: taskPage(slice, PROTOCOL_B) }];
	const observed = [];
	let wall = 0, inTok = 0, outTok = 0, last = "", turns = 0, fail = "";
	const ask = async (extra) => {
		if (extra) messages.push({ role: "user", content: extra });
		const r = await chatB(messages, key);
		wall += r.wall;
		turns += 1;
		if (!r.ok) { fail = r.error; return ""; }
		inTok += r.inTok ?? 0;
		outTok += r.outTok ?? 0;
		messages.push({ role: "assistant", content: r.content });
		last = r.content;
		return r.content;
	};
	for (let turn = 1; turn <= B_RUN_TURNS; turn++) {
		const content = await ask();
		if (fail) break;
		const runs = content.split("\n").map((l) => l.match(/^\s*RUN:\s*(.+)$/)).filter(Boolean).map((m) => m[1].trim());
		if (runs.length === 0) break;
		const outs = [];
		for (const cmd of runs) {
			const res = sh(fixture.dir, cmd, B_CMD_CAP_S);
			wall += res.ms / 1000;
			observed.push({ command: cmd, exit: res.exit });
			outs.push(`$ ${cmd}\n(exit ${res.exit})\n${clip(res.out, 4000)}`);
		}
		await ask(`${outs.join("\n\n")}\n\nReply with the verdict JSON object, or one RUN: line for the next command you need.`);
		if (fail) break;
		if (parseVerdict(last)) break;
	}
	if (!parseVerdict(last)) {
		await ask(`No further commands. Reply with ONLY the one JSON object {"id":"${slice.id}","accepted":true|false,"notes":"name the command you ran and what it printed"}.`);
	}
	return {
		slice: slice.id, executor: "B", exit: fail ? -1 : 0, stopReason: fail ? "request_failed" : "end_turn",
		turns, inTok: inTok || null, outTok: outTok || null, wall, observed,
		text: clip(last, 4000), verdict: parseVerdict(last), error: fail,
	};
}

// ---- scoring ----------------------------------------------------------------

const pct = (x) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
const med = (xs) => (xs.length ? xs[Math.floor(xs.length / 2)] : null);
const fx = (x, d = 1) => (x === null ? "n/a" : x.toFixed(d));
const secs = (x) => (x === null ? "n/a" : `${x.toFixed(1)}s`);
const cause = (e) => (e.cause?.code ? ` (${e.cause.code})` : e.cause?.message ? ` (${e.cause.message})` : "");

function score(rows, goldOf, canonOf) {
	const answered = rows.filter((r) => r.verdict);
	const correct = answered.filter((r) => (r.verdict.accepted ? "accepted" : "needs_repair") === goldOf.get(r.slice)).length;
	const comp = answered.filter((r) => compliant(r.verdict.notes, r.observed)).length;
	const strict = answered.filter((r) => allCitedRun(r.verdict.notes, canonOf.get(r.slice) ?? [], r.observed)).length;
	const walls = rows.map((r) => r.wall).sort((a, b) => a - b);
	const toks = rows.map((r) => (r.inTok ?? 0) + (r.outTok ?? 0)).sort((a, b) => a - b);
	return {
		n: rows.length, answered: answered.length, correct,
		accuracy: answered.length ? correct / answered.length : null,
		comp, compliance: answered.length ? comp / answered.length : null,
		strict, strictRate: answered.length ? strict / answered.length : null,
		noAnswer: rows.length ? (rows.length - answered.length) / rows.length : null,
		medianWall: med(walls), maxWall: walls.length ? walls[walls.length - 1] : null,
		medianTok: med(toks), totalTok: toks.reduce((a, b) => a + b, 0),
	};
}

const TABLE = (rows) => {
	const head = ["executor", "slices", "accuracy", "check-compliance", "all-cited checks run", "no-answer", "median wall", "max wall", "median tok/slice", "total tok"];
	const lines = rows.map((r) => [r.executor, `${r.answered}/${r.n}`, `${pct(r.accuracy)} (${r.correct}/${r.answered})`, `${pct(r.compliance)} (${r.comp}/${r.answered})`, `${pct(r.strictRate)} (${r.strict}/${r.answered})`, `${pct(r.noAnswer)}`, secs(r.medianWall), secs(r.maxWall), fx(r.medianTok, 0), fx(r.totalTok, 0)]);
	const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => String(l[i]).length)));
	const row = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join("  ").trimEnd();
	return [row(head), row(w.map((n) => "-".repeat(n))), ...lines.map(row)].join("\n");
};

const detailBlock = (rows, fixtures, goldOf) => {
	const canonOf = new Map(fixtures.map((f) => [f.slice.id, f.slice.checks.map((c) => c[0])]));
	return fixtures.map((f) => {
	const s = f.slice;
	const lines = [`--- ${s.id} ${s.slug} — gold ${s.gold} (fixture self-test: check.sh rc=${f.selftest.checkRc}, dirty=[${f.selftest.dirty.join(" ")}])`];
	for (const r of rows.filter((r) => r.slice === s.id)) {
		const v = r.verdict;
		const got = v ? (v.accepted ? "accepted" : "needs_repair") : "NO ANSWER";
		lines.push(`  ${r.executor}: ${got} ${got === goldOf.get(s.id) ? "OK" : "MISS"} | compliant=${v ? (compliant(v.notes, r.observed) ? "yes" : "no") : "n/a"} all-cited-run=${v ? (allCitedRun(v.notes, canonOf.get(s.id) ?? [], r.observed) ? "yes" : "no") : "n/a"} (cites ${v ? citedChecks(v.notes, canonOf.get(s.id) ?? []).length : 0}/${(canonOf.get(s.id) ?? []).length} checks) | rc=${r.exit} stop=${r.stopReason} turns=${r.turns ?? "n/a"} wall=${fx(r.wall)}s tok=${(r.inTok ?? 0) + (r.outTok ?? 0)}`);
		lines.push(`    commands observed running: ${r.observed.length ? r.observed.map((o) => `${o.command} -> exit ${o.exit}`).join(" ;; ") : "(none)"}`);
		lines.push(`    notes: ${v ? clip(v.notes, 700).replace(/\n/g, " ") : clip(r.text || r.error, 700).replace(/\n/g, " ")}`);
		if (r.error) lines.push(`    error: ${clip(r.error, 300).replace(/\n/g, " ")}`);
	}
	return lines.join("\n");
	});
};

// ---- run --------------------------------------------------------------------

function cleanup() { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } }
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

const main = async () => {
	mkdirSync(ROOT, { recursive: true });
	const grokVersion = spawnSync(GROK_BIN, ["--version"], { encoding: "utf8" }).stdout?.trim() ?? "grok --version unavailable";
	const fixtures = SLICES.map((s, i) => ({ slice: s, ...buildFixture(s, i + 1) }));
	console.log(`fixtures: ${fixtures.length} repos under ${ROOT} (${SLICES.filter((s) => s.gold === "needs_repair").length} planted defects, ${SLICES.filter((s) => s.gold === "accepted").length} clean) — every one self-tested as designed`);
	for (const f of fixtures) console.log(`  ${f.slice.id} ${f.slice.slug}: gold=${f.slice.gold} check.sh rc=${f.selftest.checkRc} dirty=${f.selftest.dirty.join(",") || "(clean tree)"} | ${clip(f.selftest.checkOut, 160)}`);

	const probe = await probeB();
	console.log(`\nexecutor B probe ${B_URL} model=${B_MODEL}: ${probe.available ? `AVAILABLE (${probe.models.length} models: ${probe.models.join(",")}; 1-token probe "${probe.probe}")` : `UNAVAILABLE — ${probe.error}`}${probe.keyNote ? `\n  key: ${probe.keyNote}` : ""}`);

	const rowsA = [];
	for (const f of fixtures) {
		const r = runA(f.slice, f);
		rowsA.push(r);
		console.log(`  A ${f.slice.id}: rc=${r.exit} stop=${r.stopReason} turns=${r.turns ?? "n/a"} cmds=${r.observed.length} wall=${fx(r.wall)}s verdict=${r.verdict ? (r.verdict.accepted ? "accepted" : "needs_repair") : "NONE"}`);
	}
	const rowsB = [];
	if (probe.available) {
		const { key } = bKey();
		for (const f of fixtures) {
			const r = await runB(f.slice, f, key);
			rowsB.push(r);
			console.log(`  B ${f.slice.id}: cmds=${r.observed.length} turns=${r.turns} wall=${fx(r.wall)}s verdict=${r.verdict ? (r.verdict.accepted ? "accepted" : "needs_repair") : "NONE"}`);
		}
	}

	const goldOf = new Map(SLICES.map((s) => [s.id, s.gold]));
	const canonOf = new Map(SLICES.map((s) => [s.id, s.checks.map((c) => c[0])]));
	const scored = [score(rowsA, goldOf, canonOf)];
	if (rowsB.length) scored.push(score(rowsB, goldOf, canonOf));
	else scored.push({ executor: "B (local lane, UNAVAILABLE)", n: SLICES.length, answered: 0, correct: 0, accuracy: null, comp: 0, compliance: null, strict: 0, strictRate: null, noAnswer: 1, medianWall: null, maxWall: null, medianTok: null, totalTok: 0 });
	scored.forEach((s, i) => { s.executor = i === 0 ? "A grok-cli (tools allowed)" : rowsB.length ? "B local lane (bench ReAct)" : s.executor; });

	const table = TABLE(scored);
	const detail = `${detailBlock(rowsA, fixtures, goldOf)}\n\n${rowsB.length ? detailBlock(rowsB, fixtures, goldOf) : `--- executor B: no per-slice detail — the lane never answered, so no check was run for any id.\n    probe error: ${probe.error}`}`;
	console.log(`\n${table}`);
	console.log(`\nper-slice detail\n${detail}`);

	const wall = (Date.now() - T0) / 1000;
	writeFileSync(RESULTS_MD, [
		"# Verifier-lane fitness",
		"",
		`Measured ${new Date().toISOString()} by \`node bench/verifier_fitness.mjs\` (run wall ${wall.toFixed(1)}s).`,
		"",
		"The rubric under test is the orchestrator's own (`src/subagent.ts` `verifierAgentMd()` /",
		"`verifierTaskBody()`): run every check yourself, read the diff, one verdict per id, `notes` names the",
		"command and what it printed. A check you did not run cannot be accepted — so **check-compliance** here",
		"is measured, not assumed: a verdict counts only when its `notes` names a command the harness observed",
		"running in that slice (executor A: the CLI's own `tool_call`/`tool_call_update` stream events; executor B:",
		"commands the bench itself executed from the model's `RUN:` lines).",
	"",
	"Two readings of the rubric clause are reported. **check-compliance** (the metric as specified): the verdict's",
	"`notes` names at least one command the harness observed running. **all-cited checks run** (the strict reading):",
	"every check command the `notes` cites is in the observed set — a notes line that quotes a check it never",
	"executed fails the strict reading even when it also names a check it did run.",
		"",
		`Executor A: \`${GROK_BIN}\` (${grokVersion}), tools ALLOWED (no \`--permission-mode plan\`, no \`--disallowed-tools\`), \`--max-turns ${A_MAX_TURNS}\`, \`--disable-web-search --no-subagents\`, \`--output-format streaming-json\`, one call per slice in the fixture cwd.`,
		`Executor B: \`${B_MODEL}\` at \`${B_URL}\` (ctx ${B_CTX}, max_tokens ${B_MAX_TOKENS}), driven by the ReAct loop this bench implements: the model emits \`RUN: <cmd>\`, the bench runs it (${B_CMD_CAP_S}s cap) and feeds the output back, ${B_RUN_TURNS} command turns then a forced answer.`,
		"",
		`Fixtures: ${fixtures.length} generated git repos under ${ROOT} (created and removed by the run) — ${SLICES.filter((s) => s.gold === "needs_repair").length} with a planted defect in the working tree, ${SLICES.filter((s) => s.gold === "accepted").length} clean. Deterministic: no randomness, no timing, no wall-clock assertions.`,
		"",
		"## Measured",
		"",
		"```",
		table,
		"```",
		"",
		"## Executor availability, stated honestly",
		"",
		`- A ran ${rowsA.filter((r) => r.verdict).length}/${SLICES.length} slices with a parseable verdict.`,
		probe.available
			? `- B was reachable: \`GET ${B_URL}/models\` answered (${probe.models.join(", ")}) and a 1-token completion printed "${probe.probe}".`
			: `- B is UNAVAILABLE: ${probe.error}. No slice was scored for B and no check was run by it — the five metrics for B are not measured, not zero.`,
		probe.keyNote ? `- Key: ${probe.keyNote}.` : "- Key: the specified key command supplied the bearer token.",
		"- A verdict with a `notes` line that names no observed command is scored non-compliant even when the",
		"  verdict is correct: that is the rubric clause, and it is the metric the snippet bench cannot see.",
		"",
		"## Per-slice detail",
		"",
		"```",
		clip(detail, 60_000),
		"```",
		"",
	].join("\n"));
	console.log(`\nresults written: ${RESULTS_MD}`);
	cleanup();
};

await main();

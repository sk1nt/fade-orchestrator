/**
 * The per-class MoE record (src/taskmoe.ts).
 *
 * The question the run leaves behind: "the CI work runs on the code lane — did that lane come in
 * WARM, from the placement the engine saved, on both cards?" The state file cannot answer it (one
 * slot) and the swap ledger is a flat list, so the closed taxonomy, the warm math and the build
 * fingerprint live here, pure.
 *
 * Pinned: the classification priority (pipeline -> runner -> prose -> code) over the words a real
 * plan writes, and the word boundaries that keep `decide` from reading as CI; `warm` requires the
 * three proven fields together, so a `configured` lane, an older engine's file, a missing profile
 * and a row with no MoE reading are all NOT warm; a class no swap ran reads 0 of 0, never a share;
 * every missing version piece is named.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TASK_CLASSES, classOf, classWarmth, versionLine } from "../.test-build/taskmoe.mjs";

/** A task in the shape core validates. */
const task = (over = {}) => ({
	id: "T1",
	objective: "wire the swap site",
	files: ["src/index.ts"],
	acceptance: "node test/build.mjs exits 0",
	dependencies: [],
	round: 1,
	...over,
});

test("a task that runs in CI is the ci class, by the words its own card uses", () => {
	// The plan's own shipping card, verbatim-shaped: it names the job and `gh run`.
	const ship = task({
		objective: "Ship and verify: rebuild the bundle, commit, push, and check the CI job on the head",
		acceptance: "git rev-list --count @{u}..HEAD prints 0 and gh run list shows the ci job green on that commit",
		files: ["dist/index.js"],
	});
	assert.equal(classOf(ship), "ci", "a card that names CI is CI work");
	assert.equal(classOf(task({ acceptance: "bash build.sh && jq -e . .github/workflows/ci.yml exits 0" })), "ci", "the workflow path alone is CI work");
	assert.equal(classOf(task({ objective: "add a workflow step that proves the bundle", acceptance: "npx --no-install tsc -p tsconfig.json" })), "ci", "the objective naming a workflow outranks the runner in its acceptance");
});

test("the ci word is a word: decide, facility and specific are not CI work", () => {
	const prose = task({ objective: "decide the facility's specific cadence", acceptance: "npx --no-install tsc -p tsconfig.json", files: ["src/router.ts"] });
	assert.equal(classOf(prose), "code", "the substring ci inside ordinary words must not classify as CI");
});

test("a runner in the acceptance, or a .test.mjs file, is the tests class", () => {
	assert.equal(classOf(task({ acceptance: "node test/build.mjs && node --test test/taskmoe.test.mjs exits 0" })), "tests", "node --test is the rig class");
	assert.equal(classOf(task({ acceptance: "npm test exits 0 with every file green" })), "tests", "npm test is the rig class");
	assert.equal(classOf(task({ acceptance: "npm run test:gate exits 0" })), "tests", "npm run test: is the rig class");
	assert.equal(classOf(task({ acceptance: "npm run test:gate exits 0: the gate rig prints all checks pass" })), "tests", "the rig names itself");
	assert.equal(classOf(task({ files: ["src/panel.ts", "test/panel.test.mjs"] })), "tests", "a test file among the task's files");
});

test("prose-only work is the docs class, by its files or its objective", () => {
	assert.equal(classOf(task({ objective: "rewrite the overlay key table", files: ["docs/OVERLAY.md", "README.md"], acceptance: "wc -l README.md exits 0" })), "docs", "every file markdown");
	assert.equal(classOf(task({ objective: "tidy the README's verb list", files: ["src/index.ts"], acceptance: "wc -l README.md exits 0" })), "docs", "the objective names the doc surface");
});

test("everything else is code, including a build-command acceptance", () => {
	assert.equal(classOf(task({ acceptance: "bash build.sh && git diff --exit-code -- dist/index.js exits 0", files: ["src/index.ts", "dist/index.js"] })), "code", "a build check with no runner and no pipeline");
	assert.equal(classOf(task({ objective: "measure the queue", files: [], acceptance: "wc -l src/panel.ts exits 0" })), "code", "an unclassifiable card falls to code, never an invented class");
});

/** A swap row in the shape history.ts writes. */
const row = (over = {}) => ({
	from: "deepseek",
	to: "flash-next",
	elapsed_s: 14.2,
	first_tg: 31,
	steady_tg: 480,
	percent_path: [12, 61],
	at: "2030-01-01T12:10:00.000Z",
	...over,
});

/** The warm reading: live config, a profile that exists, written by THIS engine. */
const warmMoe = { lane: "flash-next", state: "live", profile_path: "/var/basalt-profiles/flash-next.prof", profile_exists: true, written_by_running_engine: true };

test("every class reports in order, and a class no swap ran reads 0 of 0", () => {
	const census = classWarmth([]);
	assert.deepEqual(census.map((c) => c.cls), [...TASK_CLASSES], "the four classes print in the taxonomy's order");
	assert.deepEqual(census.map((c) => [c.swaps, c.warm]), [[0, 0], [0, 0], [0, 0], [0, 0]], "an empty ledger is 0 of 0 for every class, never a share");
	assert.ok(census.every((c) => c.profile === undefined), "no rows, no profile named");
});

test("warm needs all three proofs together, and every other reading is a swap that was not warm", () => {
	const rows = [
		row({ task_class: "ci", moe: warmMoe }),
		row({ task_class: "ci", moe: { ...warmMoe, profile_path: "/var/basalt-profiles/flash-next.prof", written_by_running_engine: false } }),
		row({ task_class: "ci", moe: { ...warmMoe, state: "configured" } }),
		row({ task_class: "ci", moe: { ...warmMoe, profile_exists: false } }),
		row({ task_class: "ci" }),
		row({ task_class: "tests", moe: warmMoe }),
		row({ moe: warmMoe }),
	];
	const byCls = Object.fromEntries(classWarmth(rows).map((c) => [c.cls, c]));
	assert.deepEqual([byCls.ci.swaps, byCls.ci.warm], [5, 1], "five CI swaps, one of them warm: configured, stale, missing-profile and MoE-less rows are not warm");
	assert.deepEqual([byCls.tests.swaps, byCls.tests.warm], [1, 1], "an unrelated class is not charged to CI");
	assert.deepEqual([byCls.docs.swaps, byCls.docs.warm], [0, 0], "the unclassified row belongs to no class");
	assert.equal(byCls.ci.profile, "/var/basalt-profiles/flash-next.prof", "the class names the save path its lane carried");
});

test("the profile named is the newest row's, and a class with rows that carried none names none", () => {
	const rows = [
		row({ task_class: "code", moe: { ...warmMoe, profile_path: "/var/basalt-profiles/newer.prof" } }),
		row({ task_class: "code", moe: { ...warmMoe, profile_path: "/var/basalt-profiles/older.prof" } }),
		row({ task_class: "docs", moe: { lane: "deepseek", state: "unsupported", profile_exists: false } }),
	];
	const byCls = Object.fromEntries(classWarmth(rows).map((c) => [c.cls, c]));
	assert.equal(byCls.code.profile, "/var/basalt-profiles/newer.prof", "the ledger is newest-first, so the first path seen is the newest");
	assert.deepEqual([byCls.docs.swaps, byCls.docs.warm, byCls.docs.profile], [1, 0, undefined], "the verifier pack's unsupported row counts and names no profile");
});

test("the version line names every piece, and names a piece that is missing", () => {
	assert.equal(versionLine("0.4.0", "0.1.0", "deadbeefcafebabe"), "engine 0.4.0 · ext 0.1.0 · bundle deadbeef", "the fingerprint is the digest's leading hex, not the whole thing");
	assert.equal(versionLine(undefined, "0.1.0", "deadbeefcafebabe"), "engine version not reported · ext 0.1.0 · bundle deadbeef", "a router that answers no version is named");
	assert.equal(versionLine("0.4.0", undefined, "deadbeefcafebabe"), "engine 0.4.0 · ext version not read · bundle deadbeef", "a package.json that did not parse is named");
	assert.equal(versionLine("0.4.0", "0.1.0", undefined), "engine 0.4.0 · ext 0.1.0 · bundle not built", "an unbuilt bundle is named, never a zero hash");
	assert.equal(versionLine(undefined, "", undefined), "engine version not reported · ext version not read · bundle not built", "nothing measured reads as three named gaps");
});

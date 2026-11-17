/**
 * The delegation ledger: the census a `task` call produces, the route a churning lane takes, and
 * the agent definition that makes a verification cost zero router swaps.
 *
 * The census decides the desk's `expected` — the number a batch waits for — so the tests that
 * matter are the ones that prove a verification-carrying worker is COUNTED and a plain worker is
 * not: count the plain ones and the batch never closes; miss the verification ones and the batch
 * closes before their requests land.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	VERIFIER_AGENT,
	VERIFIER_MODEL,
	carriesVerification,
	isRouterModel,
	routeFor,
	routeLine,
	taskBatchOf,
	verifierAgentMd,
	verifierAgentPath,
	verifierDirective,
	verifierTaskBody,
	verifierTaskCall,
} from "../.test-build/subagent.mjs";

test("the parallel task call is censused: every worker, and only the verification ones awaited", () => {
	const b = taskBatchOf({
		tasks: [
			{ agent: "scout", task: "Map the crate inventory" },
			{ agent: "task", task: "Add the desk module", acceptance: "run cargo test --release and report what it printed" },
			{ agent: "reviewer", name: "ReviewDesk", task: "# Target\nsrc/desk.ts\n# Acceptance\nverify the batch closes at N registrations" },
		],
	});
	assert.equal(b.count, 3);
	assert.deepEqual(b.agents, ["scout", "task", "reviewer"], "the agent definition names the worker; a `name` is the fallback");
	assert.deepEqual(b.verifyAgents, ["task", "reviewer"]);
	assert.equal(b.carriesVerification, true);
});

test("a call carrying no verification work is not awaited — nothing will register for it", () => {
	const b = taskBatchOf({ tasks: [{ agent: "scout", task: "Read the router client and summarise the flip guard" }, { agent: "sonic", task: "Rename the widget key in the docs" }] });
	assert.equal(b.count, 2);
	assert.equal(b.carriesVerification, false);
	assert.deepEqual(b.verifyAgents, []);
});

test("the single-worker form is one worker, and its own body decides", () => {
	const verify = taskBatchOf({ agent: "task", task: "Verify the gate rig passes" });
	assert.equal(verify.count, 1);
	assert.equal(verify.carriesVerification, true);
	const plain = taskBatchOf({ agent: "task", task: "Write the README section" });
	assert.equal(plain.count, 1);
	assert.equal(plain.carriesVerification, false);
});

test("an unrecognised shape keeps a floor the batch can close on, never an unmeasurable zero", () => {
	const b = taskBatchOf(undefined);
	assert.equal(b.count, 1);
	assert.deepEqual(b.agents, ["task"]);
});

test("verification is recognised by the words the plan writes, not by hope", () => {
	for (const body of ["run cargo test --release", "node --test test/desk.test.mjs", "the acceptance is npm run typecheck", "verify the parity harness prints 0 mismatches", "audit the promotion gate", "score the parity of the two readers"]) {
		assert.equal(carriesVerification(body), true, `must read as verification: ${body}`);
	}
	for (const body of ["rename the pill field", "write the changelog entry", "map the crate inventory"]) {
		assert.equal(carriesVerification(body), false, `must NOT read as verification: ${body}`);
	}
});

test("the route: a quiet window pays one lane load; churn routes to a subagent on a non-router model", () => {
	const quiet = routeFor({ churn: false }, { flips: 0 });
	assert.equal(quiet.route, "swap");
	assert.match(quiet.reason, /one .* load addresses the whole batch/);
	// Churn BEGUN is the trigger the operator named — not waiting for the breaker.
	const churned = routeFor({ churn: false }, { flips: 2 }, { guardAt: 2 });
	assert.equal(churned.route, "subagent");
	assert.match(churned.reason, /lane churn began/);
	assert.match(churned.reason, new RegExp(VERIFIER_MODEL));
	// A declared churn stays declared: the batches of this run answer off the router.
	const declared = routeFor({ churn: true, churn_utc: "2000-01-01T12:00:00.000Z" }, { flips: 0 });
	assert.equal(declared.route, "subagent");
	assert.match(declared.reason, /desk has churn declared/);
	assert.match(routeLine(churned), /zero lane loads/);
	assert.match(routeLine(quiet), /one load/);
});

test("the model pin is the load-bearing line: a router entry is named as the churn it would cause", () => {
	// The project's role aliases resolve to the router's code lane, so the agent
	// definition must carry a model ID, and a router entry must be flagged.
	assert.equal(isRouterModel("strata-flash/flash-next"), true);
	assert.equal(isRouterModel("ninfer-local/coder-gpu1"), false);
	assert.equal(isRouterModel("deepseek"), true);
	const md = verifierAgentMd("ninfer-local/coder-gpu1", "fade-verifier");
	assert.match(md, /^name: fade-verifier$/m);
	assert.match(md, /^model: "ninfer-local\/coder-gpu1"$/m);
	assert.doesNotMatch(md, /WARNING/);
	assert.match(verifierAgentMd("strata-flash/flash-next"), /WARNING: strata-flash\/flash-next IS a basalt ROUTER entry/);
	assert.match(verifierAgentMd("strata-flash/flash-next"), /WARNING: a ROUTER entry/);
	assert.equal(verifierAgentPath("/repo"), ".omp/agents/fade-verifier.md");
});

test("the directive is a command with the call spelled out, and the worker body carries the ids", () => {
	const requests = [
		{ id: "V2.1", agent: "scout", objective: "verify the desk closes at 2", acceptance: "node --test test/desk.test.mjs", checks: [["node --test test/desk.test.mjs", "exit 0"]], batch: 1, session: "s", enqueued_utc: "x", verdict: undefined },
		{ id: "V2.2", agent: "task", task_id: "T3", objective: "verify the rig", checks: [], batch: 1, session: "s", enqueued_utc: "x" },
	];
	const directive = verifierDirective(1, ["V2.1", "V2.2"], "lane churn began: 2 swaps", requests);
	assert.match(directive, /will NOT pay a lane load/);
	assert.match(directive, new RegExp(`"agent": "${VERIFIER_AGENT}"`));
	assert.match(directive, /node --test test\/desk\.test\.mjs/, "the checks ride in the task text: the verifier needs no desk read to begin");
	assert.match(directive, /V2\.1, V2\.2/);
	const body = verifierTaskBody(1, ["V2.1", "V2.2"], requests);
	assert.match(body, /# Verification batch 2/);
	assert.match(body, /fade_verdicts/);
	assert.match(body, /V2\.2 \(worker task, task T3\)/);
	assert.match(verifierTaskCall(1, ["V2.1"], requests), /^task \{ "agent"/);
});

test("the WORKER definition carries fade_verify, because a read-only agent cannot register", async () => {
	const { workerAgentMd, WORKER_AGENT } = await import("../.test-build/subagent.mjs");
	const w = workerAgentMd();
	assert.equal(WORKER_AGENT, "fade-worker");
	assert.match(w, /^name: fade-worker$/m);
	assert.match(w, /^tools: .*fade_verify/m, w.slice(0, 400));
	assert.doesNotMatch(w, /fade_verdicts/, "a worker never posts verdicts");
	assert.match(w, /Quote that id in your final message/, "the id is the handle the verdict comes back on");
});

/**
 * The delegation ledger: what a `task` call carries, and who must answer it.
 *
 * Three questions, answered from the tool's own input, with no model and no network:
 *
 * 1. **How many workers exist?** `taskBatchOf` reads the `task` tool's input in both of its
 *    shapes (one `{agent, task}` call, or `tasks[]` in parallel). The count is the number the
 *    desk's `expected` field needs: a batch of three workers is ONE verification pass, and the
 *    pass cannot be paid before the third worker has registered.
 *
 * 2. **Which of them carries verification work?** `carriesVerification` classifies one task body
 *    over the text the plan already wrote (the `# Acceptance` section, the verb the operator
 *    uses). The desk's `expected` counts ONLY the verification-carrying workers: a batch of five
 *    where two carry verification closes at two registrations. That is the operator's rule
 *    literally — a verification call waits for the OTHER agents that also have a verification
 *    call, not for every worker in the tree.
 *
 * 3. **Who should do the verification?** `routeFor` is the churn answer. The swap is 13-25 s and
 *    52-130 GiB, and the flip guard's window (router.ts) is where a per-arrival verification
 *    turns into LANE THRASH. Once churn is in force, the batch is addressed by a verification
 *    SUBAGENT pinned to a NON-ROUTER model: it costs zero router swaps, and the loop is not
 *    allowed to keep paying swaps into the churn.
 *
 * The verifier agent's own definition ships here as text and is installed by
 * `/orchestrate verifier install`: it is a `.omp/agents/*.md` file, so the host's `task` tool
 * pins the model from the front matter and the orchestrator never has to swap a lane to use it.
 */
import { CODE_LANE, FLIP_MIN_SWAPS, PROVIDER, THINK_LANE, THINKING } from "./router.ts";
import type { VerifyRequest } from "./desk.ts";

/** The agent definition's name, as it is written into `.omp/agents/<name>.md`. */
export const VERIFIER_AGENT = process.env.FADE_ORCHESTRATE_VERIFIER_AGENT ?? "fade-verifier";

/**
 * The model the verification subagent runs on. It MUST NOT be an entry of the router:
 * a router entry means the subagent's first request swaps the resident lane, which is exactly the
 * churn the route exists to escape. The default is NInfer's coder on :8002 (`ninfer-local`,
 * measured a separate server from the basalt router on :18014), so a verification subagent there
 * pays ZERO router swaps. `openai-codex/gpt-5.6-luna` (the project's `@smol` utility lane) is the
 * documented off-GPU alternative; the project config's `@gpu1`/`@slow`/`@task` roles all resolve
 * to `strata-flash/flash-next`, so a ROLE alias is a router entry — pin the id.
 */
export const VERIFIER_MODEL = process.env.FADE_ORCHESTRATE_VERIFIER_MODEL ?? "ninfer-local/coder-gpu1";

/** The router's own two entries: the models that CANNOT host a churn-free verification. */
export const ROUTER_ENTRIES = [CODE_LANE, THINK_LANE, PROVIDER].map((s) => s.toLowerCase());

/** True when a model spec would land on the router and so re-price the swap the route avoids. */
export function isRouterModel(model: string): boolean {
	const m = model.toLowerCase();
	return ROUTER_ENTRIES.some((entry) => m === entry || m.startsWith(`${entry}/`) || m.includes(`/${entry}`) || m.startsWith(`${entry}:`));
}

export interface TaskBatch {
	/** Workers the call carries (1 for the single form). */
	count: number;
	/** Each worker's name: the agent definition, or `task` for the host's default. */
	agents: string[];
	/** Names of the workers whose body carries verification work. */
	verifyAgents: string[];
	/** True when at least one worker carries verification work. */
	carriesVerification: boolean;
	/** The per-worker classes, in call order: what the census is answerable from. */
	kinds: Array<{ agent: string; verification: boolean }>;
}

const textOf = (v: unknown): string => {
	if (typeof v === "string") return v;
	if (Array.isArray(v)) return v.map(textOf).join("\n");
	return "";
};

/**
 * A task body that asks for verification. Closed set, first match wins, over the text the
 * delegating model wrote (the task body, the acceptance section, the target): `verif-`,
 * `acceptance`/`gate`/`audit`, a named runner, then the bare verbs. The names ride in the census
 * so a batch's `expected` is answerable from the ledger alone.
 */
export function carriesVerification(body: string): boolean {
	if (/\bverif(y|ication|ied)\b/i.test(body)) return true;
	if (/\bacceptance\b|\bgate\b|\baudit\b|promotion gate/i.test(body)) return true;
	if (/\b(cargo (test|clippy)|pytest|node --test|npm (run )?test|playwright|tsc|typecheck|lint)\b/i.test(body)) return true;
	return /\bverify\b|\bverify that\b|\bprove\b|\bscore\b|\bparit(?:y|es)\b/i.test(body);
}

/**
 * The `task` tool's input, as a census. `tasks[]` is the parallel form (each item `{agent, task}`
 * or, in the host's native shape, `{task, agent?, name?}`); a bare `{task, agent}` is one worker.
 * A shape this function does not recognize reports `count: 1` with `agents: ["task"]`, so the desk
 * keeps a floor it can close on instead of an unmeasurable `0`.
 */
export function taskBatchOf(input: Record<string, unknown> | undefined): TaskBatch {
	const items: Array<Record<string, unknown>> = [];
	const list = Array.isArray(input?.tasks) ? (input.tasks as unknown[]) : [];
	for (const item of list) {
		const o = item !== null && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : { task: String(item) };
		items.push(o);
	}
	if (items.length === 0) {
		const single = input?.task !== undefined || input?.agent !== undefined;
		if (single) items.push(input as Record<string, unknown>);
	}
	const kinds = items.map((o) => {
		const agent = textOf(o.agent).trim() || textOf(o.name).trim() || "task";
		const body = `${textOf(o.task)}\n${textOf(o.target)}\n${textOf(o.acceptance)}\n${textOf(o.solutionSpace)}`;
		return { agent, verification: carriesVerification(body) };
	});
	const agents = kinds.map((k) => k.agent);
	const verifyAgents = kinds.filter((k) => k.verification).map((k) => k.agent);
	return {
		count: Math.max(1, kinds.length),
		agents: agents.length > 0 ? agents : ["task"],
		verifyAgents,
		carriesVerification: verifyAgents.length > 0,
		kinds: kinds.length > 0 ? kinds : [{ agent: "task", verification: false }],
	};
}

export interface RouteDecision {
	route: "swap" | "subagent";
	/** The named cause, printed in the rejection history and the notify. */
	reason: string;
	/** The flips the guard observed, for the row. */
	flips: number;
}

/**
 * Who addresses this batch.
 *
 * `route: "subagent"` fires in two states, and the second is the operator's rule: the desk has
 * declared churn (a previous flip, and it stays declared until the ledger is reset), OR the flip
 * guard's own threshold has been reached — churn has BEGUN. Routing to a subagent is the
 * remedy; continuing to pay swaps into a churning window is what the rule forbids.
 */
export function routeFor(desk: { churn: boolean; churn_utc?: string }, flip: { flips: number }, opts: { guardAt?: number } = {}): RouteDecision {
	const guardAt = opts.guardAt ?? FLIP_MIN_SWAPS;
	if (desk.churn) return { route: "subagent", reason: `the desk has churn declared${desk.churn_utc ? ` since ${desk.churn_utc}` : ""}: batches are answered by a verification subagent on ${VERIFIER_MODEL}, and no lane load is paid`, flips: flip.flips };
	if (flip.flips >= guardAt) return { route: "subagent", reason: `lane churn began: ${flip.flips} swaps away from the run's lane in the guard window — the verification goes to a subagent on ${VERIFIER_MODEL} (zero router swaps) instead of a lane load`, flips: flip.flips };
	return { route: "swap", reason: THINK_LANE === CODE_LANE ? `no churn: ${THINK_LANE} runs both roles and is resident, so the whole batch is answered at ZERO lane loads` : `no churn: one ${THINK_LANE} load addresses the whole batch`, flips: flip.flips };
}

/**
 * The `task` call the owner is told to make, as text the loop can act on verbatim. The request
 * bodies ride INSIDE the task text: the verifier subagent starts with the ids, the objectives and
 * the commands in hand, so it needs no desk read to begin and cannot wander into another slice.
 */
export function verifierTaskCall(batch: number, ids: string[], requests: VerifyRequest[] = []): string {
	return `task { "agent": "${VERIFIER_AGENT}", "name": "Verify${batch + 1}", "solutionSpace": "one batched verification pass, verdicts posted by id", "task": ${JSON.stringify(verifierTaskBody(batch, ids, requests))} }`;
}

/** The worker body the verifier subagent receives: the batch, by id, with its commands. */
export function verifierTaskBody(batch: number, ids: string[], requests: VerifyRequest[] = []): string {
	const rows = requests.map((r) => {
		const checks = r.checks.map(([cmd, expected]) => `    - \`${cmd}\` (expected ${expected})`).join("\n");
		return [`  - ${r.id} (worker ${r.agent}${r.task_id ? `, task ${r.task_id}` : ""}): ${r.objective}`, r.acceptance ? `    acceptance: ${r.acceptance}` : "", checks ? `  checks:\n${checks}` : ""].filter(Boolean).join("\n");
	});
	return [
		`# Verification batch ${batch + 1}`,
		"",
		"You are the verification lane for this batch. You run on a non-router model, so you cost the",
		"orchestrator ZERO lane swaps. Do NOT touch the basalt router (`/v1/load`, `setModel`), do NOT",
		"edit any file, and do NOT verify anything outside the ids below — every other slice is in",
		"another agent's hands and a second pass over it is the churn this route exists to avoid.",
		"",
		"Rules:",
		"1. Run each check command yourself, in the session cwd, and judge the request on what it",
		"   printed. A check you did not run cannot be accepted.",
		"2. Read the diff (`git status --porcelain`, `git diff`) for the files each id names.",
		"3. Post exactly one verdict per id with the `fade_verdicts` tool: `batch` is the number in",
		`   the heading above (${batch + 1}), and \`verdicts: [{id, accepted, notes}]\`. \`notes\` names the`,
		"   command and what it printed, or the cause the coder must fix. An id you did not judge is a",
		"   defect, not a pass.",
		"4. Report the verdicts verbatim in your final message; the desk is the durable record.",
		"",
		ids.length > 0 ? `Ids to judge: ${ids.join(", ")}` : "Ids to judge: (none — the batch was claimed empty; post nothing and end)",
		rows.length > 0 ? `\nRequests:\n${rows.join("\n")}` : "",
	].join("\n");
}

/**
 * The directive the owner's loop receives when the route is `subagent`. It is a command, not a
 * suggestion, and it carries the exact call: the plugin has no native way to invoke the host's
 * `task` tool from a hook, and the loop is the thing that owns it. The clause naming the cost is
 * what makes the directive legible to the operator reading the transcript.
 */
export function verifierDirective(batch: number, ids: string[], reason: string, requests: VerifyRequest[] = []): string {
	return [
		`Verification batch ${batch + 1} (${ids.length} worker request${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}) is READY, and the loop will NOT pay a lane load for it.`,
		`Reason: ${reason}`,
		"",
		"Do exactly this, once, in this turn:",
		"1. Call the `task` tool with the verifier agent —",
		verifierTaskCall(batch, ids, requests),
		`   (agent definition \`${VERIFIER_AGENT}\`, model \`${VERIFIER_MODEL}\`, off the router: no pack is loaded and no swap is paid).`,
		"2. When it returns, the verdicts are already on the desk (`fade_verdicts` posted them), so the",
		"   waiting workers unblock on their own. Do not re-run the checks in this session.",
		"3. Do not call `fade_phase verification_done` for these ids from the code lane; the batch's",
		"   verdicts are the worker-scoped answer. Act on a `needs_repair` verdict by fixing the cause.",
		"",
		"Do not load the thinking lane for this batch, and do not delegate the same ids twice.",
	].join("\n");
}

/**
 * The agent definition, as the file's whole content. The `model:` line is the load-bearing part:
 * it is what the host pins the subagent to, which is why the definition is GENERATED from
 * `VERIFIER_MODEL` at install time rather than shipped as a static file with a model baked in.
 */
export function verifierAgentMd(model = VERIFIER_MODEL, agent = VERIFIER_AGENT): string {
	// The definition must not claim a property the pinned model does not have: a router entry IS the
	// swap this agent exists to escape, so the description and the in-file warning both read from
	// `isRouterModel(model)` rather than asserting "off the router" for every model.
	const offRouter = !isRouterModel(model);
	const routerWarning = offRouter
		? ""
		: `\n  # WARNING: ${model} IS a basalt ROUTER entry — a subagent on it pays the 13-25 s\n  # pack swap this agent exists to avoid, which is the churn the route was\n  # built to escape. Point FADE_ORCHESTRATE_VERIFIER_MODEL at a non-router\n  # model (e.g. ninfer-local/coder-gpu1) and re-run /orchestrate verifier install.\n`;
	return [
		"---",
		`name: ${agent}`,
		`description: Batched verification lane for the fade orchestrator: judges every request of one verification batch by id and posts the verdicts. Runs on ${model}${offRouter ? ", off the basalt router, so it costs zero lane swaps" : " — WARNING: a ROUTER entry, which pays the pack swap"}.`,
		`model: "${model}"`,
		"tools: read, grep, glob, bash, ls, fade_verdicts",
		"---",
		"",
		`You are the fade orchestrator's **verification lane** for ONE batch.`,
		routerWarning,
		"You are handed a batch of worker requests, each with an id, an objective, an acceptance line",
		"and check commands. Your job is to judge each of them, exactly once, and post the verdicts.",
		"",
		"- Run every check command yourself, in the session cwd, and judge on what it printed. A check",
		"  you did not run cannot be accepted.",
		"- Inspect the diff for the files a request names. `git status --porcelain`, `git diff`.",
		"- You are READ-ONLY on the tree. Never edit, write, patch, commit, restart a service, touch the",
		"  basalt router (`/v1/load`), or start a long-running process. Report the cause; the coder fixes it.",
		"- Judge ONLY the ids in your batch. Verifying another agent's live slice is the churn this lane",
		"  exists to prevent.",
		"- Post exactly one verdict per id with the `fade_verdicts` tool: `{batch, verdicts:[{id,",
		"  accepted, notes}]}`. In `notes`, name the command and what it printed, or the cause the coder",
		"  must fix. Then print the verdicts verbatim as your final message.",
		"- Data files (parquets, duckdb, `data/`) are read-only. Do not query a locked DuckDB writer.",
		"",
	].join("\n");
}

/** Where the definition lands for a run root: the repo's own agent plane. */
export const verifierAgentPath = (repo: string, agent = VERIFIER_AGENT): string => `.omp/agents/${agent}.md`;

/**
 * The WORKER's agent name. A delegated worker registers on the desk through the plugin's
 * `fade_verify` tool, and the host only exposes a tool to a subagent whose definition lists it:
 * measured in a live run, a `scout` (which carries bash/read and inherits extension tools)
 * registered, and a `reviewer` (read-only) ran the checks and NEVER registered — so the batch
 * waited on a worker that could not arrive. This definition is the agent a verification-carrying
 * worker is launched as.
 */
export const WORKER_AGENT = process.env.FADE_ORCHESTRATE_WORKER_AGENT ?? "fade-worker";

/**
 * The worker definition. NO `model:` line on purpose: a worker does the coding slice and inherits
 * the run's code lane; only the verifier pins off the router. Its `tools:` line is the load-bearing
 * part — without `fade_verify` in it the worker cannot register, and a census that counted it makes
 * the batch close on the settle deadline instead of on its request.
 */
export function workerAgentMd(agent = WORKER_AGENT): string {
	return [
		"---",
		`name: ${agent}`,
		"description: A delegated worker of the fade orchestrator: does one slice, then registers its own acceptance on the verification desk and waits for the verdict.",
		"tools: read, grep, glob, bash, ls, write, edit, fade_verify",
		"---",
		"",
		`You are one **worker** of a fade orchestrated run. You own the slice you were handed, and you`,
		"verify your OWN acceptance line — never another worker's slice, and never the whole run.",
		"",
		"- Do the slice, then run the acceptance commands your task names, in the session cwd.",
		"- Call `fade_verify` ONCE with: `objective` (the slice in one line), `acceptance` (the exact",
		"  command and what it must print), `checks` (rows of [command, expected]), `files` (paths you",
		"  touched), and `task_id` when your task names one.",
		"- The tool answers with a request id (`V<batch>.<n>`). **Quote that id in your final message** —",
		"  it is the handle the verdict comes back on. The tool blocks until the verdict is posted, so",
		"  do not answer before it returns; a `deferred` answer says the batch is still open, so report",
		"  the id and the queue position, not a verdict you invented.",
		"- NEVER call `fade_phase`, switch a model, touch the router (`/v1/load`), or post a verdict:",
		"  the owner run claims the batch and answers it. A worker that certifies its own slice is the",
		"  self-certification this desk exists to prevent.",
		"- Data files (parquets, duckdb, `data/`) are read-only.",
		"",
	].join("\n");
}

/** Where the worker definition lands for a run root. */
export const workerAgentPath = (repo: string, agent = WORKER_AGENT): string => `.omp/agents/${agent}.md`;

/** The one-line cost of a route, for the panel and the ledger. With ONE lane running both roles
 *  the verifier is already the resident entry, so the swap route names ZERO loads, never a load. */
export function routeLine(route: RouteDecision): string {
	return route.route === "subagent"
		? `verification → ${VERIFIER_AGENT} on ${VERIFIER_MODEL} · zero lane loads`
		: THINK_LANE === CODE_LANE
			? `verification → ${THINK_LANE} resident lane · zero lane loads (${THINKING.think} thinking)`
			: `verification → ${THINK_LANE} lane · one load (${THINKING.think} thinking)`;
}

/**
 * The IN-PROCESS lane call: one completion the plugin issues itself, that never touches the lane.
 *
 * Why this file exists is a property of the router, not of the model. The router at `ROUTER`
 * carries ONE resident lane, and `POST /v1/load` is a pack swap — flash-next 52.2 GiB, deepseek
 * 242.1 GiB, 13-25 s each — that UNLOADS the resident context. So every thinking act the session
 * takes through the host's model is paid at a lane boundary: `setModel` + the load, then the
 * hand-back. The recorded cost of that pattern is the churn the flip guard exists to bound
 * (`router.ts` FLIP GUARD, 13-25 s per direction, `FADE_ORCHESTRATE_FLIP_BREAKER_AT` halts the
 * loop at 4 swaps in the window).
 *
 * A plugin that wants ONE answer — a plan, a triage summary, a synthesis — does not need the
 * session's model to change. It needs one HTTP completion. This file is that client and nothing
 * else: it resolves a provider out of `~/.omp/agent/models.yml` the same way the claim-time probe
 * does (lane.ts: the scanner, the `!command` key path, the request shape), sends one request to the
 * resolved endpoint, and returns the text. **It never issues a load and never calls `setModel`** —
 * there is no such call in this file, and the plan test greps for it.
 *
 * The one rule that keeps that honest is RESIDENCY. A request to the router naming a model that is
 * NOT resident is not a read: the router swaps the lane to answer it, which is the exact cost this
 * path exists to avoid. So a router-provider spec is served only while its model is the resident
 * entry; anything else is refused as `lane_not_resident` with ZERO bytes sent. An endpoint on its
 * own port (a provider with its own `baseUrl`) is a different server: a request there cannot move
 * the router's lane, so it is always allowed — and on this box the DeepSeek-V4.1 server claims
 * BOTH cards and is `Conflicts=` with the resident lane at systemd level, so "its own port" buys
 * isolation from the router, not coexistence with the other card's pack. That topology fact is
 * printed with the refusal, because the refusal is what an operator sees first.
 */
import { PROVIDER, ROUTER, THINK_LANE, residentLane } from "./router.ts";
import {
	completionRequest,
	probeLane,
	readModelsYml,
	resolveLaneSpec,
	runKeyCommand,
	substituteEnv,
	type LaneSpec,
	type ProbeDeps,
	type ProbeFetch,
	type ProbeResponse,
	type ProbeResult,
} from "./lane.ts";

/** The lane `/orchestrate think` answers from by default: a router entry, so it answers only while
 *  that lane is resident (the refusal is the point — see the header). */
export const THINK_MODEL = process.env.FADE_ORCHESTRATE_THINK_MODEL ?? `${PROVIDER}/${THINK_LANE}`;

/** One in-process request's budget. The thinking lane decodes at 60-90 tok/s at the SSD tier, so a
 *  2 048-token answer is ~30 s; the window is the 13-25 s swap this call replaces, plus slack. */
export const ASK_TIMEOUT_MS = Number(process.env.FADE_ORCHESTRATE_THINK_TIMEOUT_MS ?? 180_000);
export const ASK_MAX_TOKENS = Number(process.env.FADE_ORCHESTRATE_THINK_MAX_TOKENS ?? 2048);
/** The probe cache, shared with lane.ts's window. `0` disables probing, named as such. */
export const THINK_PROBE_CACHE_MS = Number(process.env.FADE_ORCHESTRATE_THINK_PROBE_CACHE_MS ?? 15_000);

/** Every way an in-process call can end, named. A bare `false` is never the answer. */
export type AskClass =
	| "ok"
	| "lane_not_resident"
	| "endpoint_unreachable"
	| "timeout"
	| "http_error"
	| "no_completion"
	| "spec_unresolved";

export interface AskResult {
	ok: boolean;
	/** The completion's text; `""` unless `ok`. Never a placeholder. */
	text: string;
	/** One line, for the operator: the endpoint, the model, the class, the number. */
	detail: string;
	cls: AskClass;
	/** The URL the request went to, or the one it WOULD have gone to (a refusal names it). */
	endpoint: string;
	/** The provider's model id the request names. */
	model: string;
	ms: number;
	at: number;
	/** Reasoning text the lane returned, when it returns any (measured, not requested). */
	reasoning_chars?: number;
}

export interface AskOpts {
	maxTokens?: number;
	temperature?: number;
	/** The lane's thinking level (`high`/`low`), sent as `reasoning_effort` on an OpenAI-compat
	 *  endpoint. Absent means the server's own default — never a silent `low`. */
	thinking?: "high" | "low";
	timeoutMs?: number;
	/** A system line, sent when the API carries one. THE ROLE'S STATIC PREFIX: the KV prefix cache
	 *  is keyed on the bytes ahead of the newest user message, so a system line that changes per
	 *  turn re-prefills the whole prompt. Round numbers, cycle counters, lane status and any other
	 *  telemetry belong in the `prompt` (the latest user leg), never here. */
	system?: string;
	/** The role-scoped conversation key (`role:planner`, `role:coder`, `role:verifier`). Basalt's
	 *  session identity is the body's `session_id` or the `x-session-id` header
	 *  (`serve/handler.py:SESSION_HEADERS`, `_session_id`), and the engine's conversation slot —
	 *  the KV prefix cache in RAM and on disk — follows it. Every turn of ONE role sends the ONE
	 *  key, so each role keeps its own warm prefix and none evicts another's. Deterministic by
	 *  rule: no timestamp, no round, no cycle counter — a key that moves per turn is a key that
	 *  re-prefills per turn. Absent, the key is the lane's own model id, which is stable per role
	 *  for as long as the role is routed to that lane. */
	role?: string;
}

export interface AskDeps extends ProbeDeps {
	/** The resident lane, as a measured reading. `resident` is the value; `lanes` is the READ that
	 *  produces it (the default asks the router's own `/v1/models` listing — a GET, it never writes).
	 *  Both are injectable so the residency rule is testable with no router in the room, which
	 *  matters because `listLanes` uses the host's global fetch, not the seam. */
	resident?: string;
	lanes?: () => Promise<string | undefined>;
}

/** The router's host, `/v1` suffix stripped: the router answers a request naming a model it does
 *  not hold by SWAPPING the lane, so a provider on this host is the one endpoint an in-process call
 *  must gate on residency. */
const isRouterEndpoint = (baseUrl: string): boolean =>
	baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "").toLowerCase() === ROUTER.replace(/\/+$/, "").toLowerCase();

/** One field of a JSON payload, cast at the boundary only. */
const field = (o: unknown, k: string): unknown => (o && typeof o === "object" ? Reflect.get(o as object, k) : undefined);

const textOfContent = (content: unknown): string => {
	if (typeof content === "string") return content;
	// The part-array shape some OpenAI-compat servers answer with: text parts only.
	if (Array.isArray(content)) return content.map((p) => (typeof field(p, "text") === "string" ? (field(p, "text") as string) : "")).join("");
	return "";
};

/**
 * The answer text, from whichever shape the api answers with. `""` means no answer.
 *
 * `finish` is the engine's OWN reason for stopping, and it is load-bearing on a thinking pack:
 * DeepSeek-V4.1 and the Flash-Next thinking lane answer with a NULL `content` plus a populated
 * `reasoning_content` when the token budget is spent inside the thinking channel
 * (`finish_reason: length`, measured on :18014 at 24 tokens). A caller that calls that "no
 * completion" without naming that is a caller that re-runs the same request and gets the same thing.
 */
export function answerText(api: string, payload: unknown): { text: string; reasoning: number; finish?: string } {
	if (api === "anthropic-messages") {
		const parts = field(payload, "content");
		return { text: Array.isArray(parts) ? textOfContent(parts) : "", reasoning: 0 };
	}
	const choices = field(payload, "choices");
	const first = Array.isArray(choices) && choices.length > 0 ? choices[0] : undefined;
	const message = field(first, "message");
	const content = textOfContent(field(message, "content"));
	const reasoning = field(message, "reasoning_content");
	const finish = field(first, "finish_reason");
	return {
		text: content,
		reasoning: typeof reasoning === "string" ? reasoning.length : 0,
		...(typeof finish === "string" ? { finish } : {}),
	};
}

/**
 * Resolve a `provider/model` spec against the host's provider plane. `yml`/`env` are injectable so
 * the rigs resolve a fictional plane; the real path reads `~/.omp/agent/models.yml`.
 *
 * The verifier's env lever is STRIPPED before resolving. `FADE_ORCHESTRATE_VERIFIER_BASE_URL`
 * redirects any lane `resolveLaneSpec` is asked about (lane.ts:202), and the rigs set it: a test
 * that points the ADVISOR at a stub must not silently move the thinking lane's endpoint too. The
 * in-process lane names its lane with `FADE_ORCHESTRATE_THINK_MODEL` and takes its endpoint from
 * the provider plane — one lever per lane, so a reading says which server answered.
 */
export function resolveAskSpec(model: string, deps: AskDeps = {}): { spec: LaneSpec } | { error: string } {
	const env = deps.env ?? process.env;
	const { FADE_ORCHESTRATE_VERIFIER_BASE_URL: _b, FADE_ORCHESTRATE_VERIFIER_API: _a, FADE_ORCHESTRATE_VERIFIER_API_KEY: _k, ...rest } = env;
	return resolveLaneSpec(model, deps.yml !== undefined ? deps.yml : readModelsYml(env), rest);
}

/** The auth headers, built the way the probe builds them: a `!command` key is RUN, never sent. */
async function authHeaders(spec: LaneSpec, env: NodeJS.ProcessEnv, deps: AskDeps): Promise<{ headers: Record<string, string>; note: string }> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (spec.apiKeyCommand) {
		const k = await runKeyCommand(spec.apiKeyCommand, deps.runShell, 8_000);
		if (!k.key) return { headers: {}, note: `the lane's key command refused: ${k.detail}` };
		if (spec.authHeader) headers.authorization = `Bearer ${k.key}`;
		else headers["x-api-key"] = k.key;
	} else if (spec.apiKey) {
		if (spec.authHeader) headers.authorization = `Bearer ${spec.apiKey}`;
		else headers["x-api-key"] = spec.apiKey;
	}
	const dropped: string[] = [];
	for (const [name, decl] of Object.entries(spec.headers)) {
		const v = substituteEnv(decl, env);
		if (v === undefined) dropped.push(`${name}: ${decl}`);
		else headers[name] = v;
	}
	return { headers, note: dropped.length > 0 ? `; sent without ${dropped.join(", ")}` : "" };
}

/**
 * One completion, in process. The residency rule runs FIRST, so a request that would move the
 * router's lane never reaches the network.
 */
export async function askLane(model: string, prompt: string, opts: AskOpts = {}, deps: AskDeps = {}): Promise<AskResult> {
	const env = deps.env ?? process.env;
	const fetchImpl: ProbeFetch = deps.fetchImpl ?? (globalThis.fetch as unknown as ProbeFetch);
	const now = deps.now ?? Date.now;
	const t0 = now();
	const timeoutMs = opts.timeoutMs ?? ASK_TIMEOUT_MS;
	const finish = (r: Omit<AskResult, "ms" | "at">): AskResult => ({ ...r, ms: now() - t0, at: t0 });

	const resolved = resolveAskSpec(model, deps);
	if ("error" in resolved) {
		return finish({ ok: false, text: "", cls: "spec_unresolved", endpoint: "", model, detail: resolved.error });
	}
	const spec = resolved.spec;
	const endpoint = `${spec.baseUrl}${completionRequest(spec.api, spec.model).path}`;

	// THE RESIDENCY RULE. The router answers a request naming a model it does not hold by swapping
	// to it — 13-25 s of 52-242 GiB, and the interactive lane goes with it. A call that would pay
	// that is refused here, with ZERO bytes sent, so no load and no swap can follow.
	if (isRouterEndpoint(spec.baseUrl)) {
		const resident = deps.resident !== undefined ? deps.resident : await (deps.lanes ?? residentLane)();
		if (resident !== spec.model) {
			return finish({
				ok: false,
				text: "",
				cls: "lane_not_resident",
				endpoint,
				model: spec.model,
				detail: `${spec.model} is NOT the resident lane on the router (${ROUTER}; resident ${resident ?? "unknown"}) — the router answers a request naming a non-resident model by SWAPPING the lane, so this in-process call sends zero bytes. Point FADE_ORCHESTRATE_THINK_MODEL at the resident entry, at a provider on its own port, or take the swap route the authorized loop pays.`,
			});
		}
	}

	const { headers, note } = await authHeaders(spec, env, deps);
	if (spec.apiKeyCommand && !headers.authorization && !headers["x-api-key"]) {
		return finish({ ok: false, text: "", cls: "endpoint_unreachable", endpoint, model: spec.model, detail: `${note.replace(/^; /, "")} — no request sent to ${endpoint}` });
	}

	// ROLE-SCOPED SESSION AFFINITY: one deterministic key per role, on both surfaces basalt reads
	// (the body's `session_id`, the `x-session-id` header). The probes in lane.ts stay UNKEYED: a
	// probe is one request, and a key per probe would open a cache slot per probe.
	const session = opts.role && opts.role !== "" ? opts.role : `role:${spec.model}`;
	headers["x-session-id"] = session;

	const base = completionRequest(spec.api, spec.model).body as Record<string, unknown>;
	const messages: { role: string; content: string }[] = [];
	if (opts.system) messages.push({ role: "system", content: opts.system });
	messages.push({ role: "user", content: prompt });
	const body: Record<string, unknown> = {
		...base,
		model: spec.model,
		session_id: session,
		max_tokens: opts.maxTokens ?? ASK_MAX_TOKENS,
		messages,
	};
	if (spec.api === "anthropic-messages") {
		if (opts.system) body.system = opts.system;
	} else {
		body.temperature = opts.temperature ?? 0;
		body.stream = false;
		if (opts.thinking) body.reasoning_effort = opts.thinking;
	}

	let res: ProbeResponse;
	try {
		res = await fetchImpl(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
	} catch (e) {
		const name = e instanceof Error ? e.name : "";
		const line = e instanceof Error ? e.message : String(e);
		if (name === "TimeoutError" || name === "AbortError") {
			return finish({ ok: false, text: "", cls: "timeout", endpoint, model: spec.model, detail: `${endpoint} answered no completion in ${Math.round(timeoutMs / 1000)}s — the lane is busy, loading, or wedged; no load and no swap was issued` });
		}
		return finish({ ok: false, text: "", cls: "endpoint_unreachable", endpoint, model: spec.model, detail: `${endpoint} refused: ${line} — an endpoint on its own port does not move the router's lane; nothing was loaded${note}` });
	}

	const payload = await res.json().catch(() => null);
	if (!res.ok) {
		const shown = payload !== null ? JSON.stringify(payload).slice(0, 200) : await res.text().then((t) => t.slice(0, 200)).catch(() => "");
		return finish({ ok: false, text: "", cls: "http_error", endpoint, model: spec.model, detail: `${endpoint} → http ${res.status} for model ${spec.model}: ${shown}${note}` });
	}
	const { text, reasoning, finish: stop } = answerText(spec.api, payload);
	if (text.trim() === "") {
		const why = reasoning > 0
			? `: ${reasoning} chars of REASONING and NO answer text — the budget was spent inside the thinking channel${stop === "length" ? " (finish_reason length)" : ""}; raise max_tokens (FADE_ORCHESTRATE_THINK_MAX_TOKENS) for this lane`
			: `: ${payload !== null ? JSON.stringify(payload).slice(0, 200) : "no json"}`;
		return finish({ ok: false, text: "", cls: "no_completion", endpoint, model: spec.model, detail: `${endpoint} → http 200 with NO completion text for model ${spec.model}${stop ? ` (finish_reason ${stop})` : ""}${why}${note}` });
	}
	// The advertised-id check stays ADVISORY (the probe's own rule): a server that hides `/models`
	// is not disqualified, and a call already answered is not a failure.
	return finish({
		ok: true,
		text,
		cls: "ok",
		endpoint,
		model: spec.model,
		detail: `${endpoint} answered model ${spec.model}: ${text.length} chars${reasoning > 0 ? ` (+${reasoning} reasoning)` : ""}${stop === "length" ? " · TRUNCATED at the token budget (finish_reason length) — raise max_tokens" : ""}${note}`,
		...(reasoning > 0 ? { reasoning_chars: reasoning } : {}),
	});
}

/** The run's configured thinking lane, in process. */
export const askThink = (prompt: string, opts: AskOpts = {}, deps: AskDeps = {}): Promise<AskResult> => askLane(THINK_MODEL, prompt, opts, deps);

const probeCache = new Map<string, ProbeResult>();

/**
 * Prove an in-process lane BEFORE anything depends on it: the same completion probe lane.ts uses,
 * with the residency rule applied first — a router entry that is not resident is REFUSED without
 * probing, because proving it would pay the swap the call exists to avoid.
 */
export async function probeThink(model: string = THINK_MODEL, deps: AskDeps = {}): Promise<ProbeResult> {
	const env = deps.env ?? process.env;
	const now = deps.now ?? Date.now;
	const ttl = Number(env.FADE_ORCHESTRATE_THINK_PROBE_CACHE_MS ?? THINK_PROBE_CACHE_MS);
	if (ttl <= 0) return { ok: true, skipped: true, detail: "probing disabled (FADE_ORCHESTRATE_THINK_PROBE_CACHE_MS=0)", at: now(), ms: 0 };
	const hit = probeCache.get(model);
	if (hit && now() - hit.at < ttl) return hit;
	const resolved = resolveAskSpec(model, deps);
	if ("error" in resolved) {
		const miss: ProbeResult = { ok: false, detail: resolved.error, at: now(), ms: 0 };
		probeCache.set(model, miss);
		return miss;
	}
	const spec = resolved.spec;
	if (isRouterEndpoint(spec.baseUrl)) {
		const resident = deps.resident !== undefined ? deps.resident : await (deps.lanes ?? residentLane)();
		if (resident !== spec.model) {
			const miss: ProbeResult = {
				ok: false,
				detail: `${spec.model} is NOT the resident lane on the router (${resident ?? "unknown"} is): proving it with a completion would make the router swap the lane, so the in-process call is refused with zero bytes sent`,
				at: now(),
				ms: 0,
			};
			probeCache.set(model, miss);
			return miss;
		}
	}
	const r = await probeLane(spec, { ...deps, env });
	probeCache.set(model, r);
	return r;
}

/** One line, for `status` and the panel: what was called, what answered, how long it took. */
export function askLabel(r: AskResult): string {
	return `${r.model} ${r.ok ? `answered ${r.text.length} chars in ${(r.ms / 1000).toFixed(1)}s` : `REFUSED ${r.cls}`} · ${r.endpoint || "no endpoint resolved"}`;
}

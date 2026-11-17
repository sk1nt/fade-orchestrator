/**
 * The verification lane's liveness, proved BEFORE the desk claims a batch.
 *
 * Why this file exists is a property of the desk, not of any model: **a claimed batch has no
 * reclaim path.** `claimBatch` stamps `claimed_batch` on every live request (`desk.ts:264`),
 * `openRequests` filters stamped requests out of the live set (`desk.ts:214`), and nothing in
 * `desk.ts` ever clears the stamp. So once a batch has been addressed, nothing re-opens it: a batch
 * handed to a verifier lane that cannot answer is permanently **owed**. Every worker in it exits
 * `fade_verify` at `DESK_WAIT_MS` with "the batch is owed its verification pass — report your
 * result and end, do not re-register" (`desk.ts:449`), and a worker that ignores that instruction
 * and re-registers gets a FRESH request, because `enqueueRequest` dedupes only against UNCLAIMED
 * requests (`desk.ts:285`). The owed count therefore grows monotonically across a run, each
 * duplicate priced at its own verification pass, and the run completes reading unverified slices as
 * reported. There is no poll-time recovery: the desk prints `N awaiting verdict` and moves on.
 *
 * So the guard is a CLAIM-TIME guard: before `dispatchDeskBatch` claims a batch for the zero-swap
 * `subagent` route, the lane the batch is being handed to must be shown to answer a completion.
 *
 * The probe is a COMPLETION, not a `GET`. The `ninfer-local` provider authenticates through a
 * command (`apiKey: "!bash -lc 'source ~/.config/fade/ninfer-backend.env && …'"`, `authHeader:
 * true`), so a reachable port and a 200 on `/v1/models` can coexist with a generate-time 401: a
 * read-only probe would clear the gate, claim the batch, and produce exactly the unrecoverable owed
 * state this file exists to prevent. `/v1/models` is consulted only to catch the opposite failure —
 * a pinned id the server does not advertise, which the host would report as a model that does not
 * exist.
 *
 * The probe is cheap and CACHED. A batch dispatch runs on the host's turn boundary, and the
 * verification swap it is avoiding costs 13-25 s, so a probe that costs a second per batch would
 * eat a tenth of the thing it protects.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { isRouterModel } from "./subagent.ts";

const execFileAsync = promisify(execFile);

/** One provider entry, as `~/.omp/agent/models.yml` declares it. */
export interface ProviderBlock {
	id: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	authHeader?: boolean;
	headers: Record<string, string>;
	models: string[];
}

/** Everything a probe needs, resolved. */
export interface LaneSpec {
	/** The spec as the agent file pins it, e.g. `ninfer-local/coder-gpu1`. */
	spec: string;
	provider: string;
	model: string;
	baseUrl: string;
	api: string;
	/** A literal key, sent as-is. */
	apiKey?: string;
	/** A `!command` key: RUN at probe time, through the lane's own env path. Never sent. */
	apiKeyCommand?: string;
	authHeader: boolean;
	/** Header name -> declared value, `${VAR}` form included; env-resolved at probe time. */
	headers: Record<string, string>;
	/** Where the spec came from, for the operator line. */
	source: "env" | "models.yml";
}

export interface ProbeResult {
	ok: boolean;
	/** One line: what was asked and what came back. Never a fabricated pass. */
	detail: string;
	/** Unix ms of the measurement (a cache hit carries the ORIGINAL time). */
	at: number;
	ms: number;
	/** True when probing is switched off, so a caller never reads it as a pass. */
	skipped?: boolean;
}

export const PROBE_TIMEOUT_MS = Number(process.env.FADE_ORCHESTRATE_LANE_PROBE_TIMEOUT_MS ?? 8000);
/** The cache window; `0` disables probing entirely (the rigs stub the router, not this lane). */
export const PROBE_CACHE_MS = Number(process.env.FADE_ORCHESTRATE_LANE_PROBE_CACHE_MS ?? 15_000);

/** The fetch seam: a test answers these fields, the host's global satisfies it. */
export interface ProbeResponse {
	status: number;
	ok: boolean;
	json(): Promise<unknown>;
	text(): Promise<string>;
}

export interface ProbeInit {
	method: string;
	headers: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}

export type ProbeFetch = (url: string, init: ProbeInit) => Promise<ProbeResponse>;

export interface ProbeDeps {
	fetchImpl?: ProbeFetch;
	runShell?: (command: string, timeoutMs: number) => Promise<{ code: number; out: string }>;
	now?: () => number;
	env?: NodeJS.ProcessEnv;
	yml?: string | null;
}

const strip = (v: string): string => {
	const t = v.trim();
	if (t.startsWith('"') && t.endsWith('"') && t.length > 1) return t.slice(1, -1).replace(/\\"/g, '"');
	if (t.startsWith("'") && t.endsWith("'") && t.length > 1) return t.slice(1, -1);
	return t;
};

const unquoteKey = (k: string): string => k.replace(/^["']|["']$/g, "");

/**
 * Scan `providers:` out of a models.yml, indentation-based, comment-tolerant. This is a scanner for
 * the fields a probe needs, not a YAML implementation: omp owns the file's semantics, and a scan
 * that disagrees with omp shows up as a refused lane (loud, priced at one swap), never as a
 * silently-proved one.
 */
export function parseProviderBlocks(yml: string): ProviderBlock[] {
	const lines = yml.split("\n");
	const start = lines.findIndex((l) => /^providers:\s*$/.test(l));
	if (start < 0) return [];
	const blocks: ProviderBlock[] = [];
	let current: ProviderBlock | undefined;
	let entryIndent = -1;
	// Inside a provider entry: the open sub-block (`models` / `headers`), by its own indent.
	let sub: { name: string; indent: number } | undefined;
	for (let i = start + 1; i < lines.length; i++) {
		const raw = lines[i];
		if (/^\s*#/.test(raw) || raw.trim() === "") continue;
		const indent = raw.length - raw.trimStart().length;
		if (indent === 0) break; // the next top-level key of the file
		const body = raw.trim();
		const dash = /^-\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(body);
		const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(body);
		// `- id: coder-gpu` and the bare `- coder-gpu` are both model entries; a `- name:`-style line
		// deeper in a model entry is a FIELD of it, not an advertised id.
		const bare = /^-\s*(.+)$/.exec(body);
		const key = dash ? dash[1] : kv ? kv[1] : "";
		const value = strip(dash ? (dash[2] ?? "") : kv ? (kv[2] ?? "") : bare ? bare[1] : "");
		// A provider ENTRY, in EITHER form: a `- id: x` sequence item, or a `ninfer-local:` mapping
		// key with no value. The operator's file is the mapping form, omp accepts both, and a scan
		// that reads only sequences reports every provider as missing — a false refusal that prices
		// a swap on every churn batch. An empty-value key DEEPER than the entry is a sub-block.
		const opensProvider =
			(kv && value === "" && key !== "models" && key !== "headers" && key !== "compat" && (entryIndent < 0 || indent <= entryIndent)) ||
			(dash && key === "id" && value !== "" && (entryIndent < 0 || indent <= entryIndent));
		if (opensProvider) {
			entryIndent = indent;
			current = { id: unquoteKey(dash ? value : key), api: "openai-completions", headers: {}, models: [] };
			blocks.push(current);
			sub = undefined;
			continue;
		}
		if (!current) continue;
		if (sub && indent > sub.indent) {
			if (sub.name === "models") {
				if (bare) {
					const id = unquoteKey(strip(/^-\s*(?:id:\s*)?(.+)$/.exec(body)?.[1] ?? ""));
					if (id && id !== "[]") current.models.push(id);
				}
			} else {
				const hk = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(body.replace(/^-\s*/, ""));
				if (hk) current.headers[unquoteKey(hk[1])] = strip(hk[2] ?? "");
			}
			continue;
		}
		if (!kv) continue;
		sub = undefined;
		if (value === "") {
			// A key with no value opens a sub-block, if the lines under it sit deeper.
			const next = lines.slice(i + 1).find((l) => l.trim() !== "" && !/^\s*#/.test(l));
			const nextIndent = next ? next.length - next.trimStart().length : -1;
			if (nextIndent > indent && (key === "models" || key === "headers")) sub = { name: key, indent };
			continue;
		}
		if (key === "baseUrl") current.baseUrl = value;
		else if (key === "api") current.api = value;
		else if (key === "apiKey") current.apiKey = value;
		else if (key === "authHeader") current.authHeader = value === "true";
	}
	return blocks;
}

/** Split `provider/model`; a bare id has no provider. */
export function splitSpec(spec: string): { provider: string; model: string } {
	const i = spec.indexOf("/");
	return i < 0 ? { provider: "", model: spec } : { provider: spec.slice(0, i), model: spec.slice(i + 1) };
}

/**
 * Resolve one model spec to a probeable endpoint. The env override wins, so a rig — or a host with
 * no `~/.omp/agent/models.yml` — can point the probe at a stub. An unresolvable spec is an ERROR,
 * not a pass: the host will fail to launch the subagent on it, and the batch will be owed.
 */
export function resolveLaneSpec(spec: string, yml: string | null, env: NodeJS.ProcessEnv): { spec: LaneSpec } | { error: string } {
	const { provider, model } = splitSpec(spec);
	const fromEnv = env.FADE_ORCHESTRATE_VERIFIER_BASE_URL?.trim();
	if (fromEnv) {
		return {
			spec: {
				spec, provider, model, baseUrl: fromEnv.replace(/\/$/, ""),
				api: env.FADE_ORCHESTRATE_VERIFIER_API?.trim() || "openai-completions",
				apiKey: env.FADE_ORCHESTRATE_VERIFIER_API_KEY?.trim() || undefined,
				authHeader: true, headers: {}, source: "env",
			},
		};
	}
	if (!yml) return { error: `${spec}: no baseUrl and no ~/.omp/agent/models.yml, so the verifier lane cannot be resolved, let alone proved live (set FADE_ORCHESTRATE_VERIFIER_BASE_URL to a real server)` };
	const want = provider || undefined;
	const blocks = parseProviderBlocks(yml);
	const block = blocks.find((b) => (want ? b.id === want : b.models.includes(model)));
	if (!block) return { error: `${spec}: provider ${want ?? "(any)"} is not in models.yml` };
	if (!block.baseUrl) return { error: `${spec}: provider ${block.id} declares no baseUrl` };
	if (block.models.length > 0 && !block.models.includes(model)) {
		return { error: `${spec}: provider ${block.id} advertises ${block.models.slice(0, 6).join(", ")}${block.models.length > 6 ? ", …" : ""}, not ${model}` };
	}
	const key = block.apiKey ?? "";
	const isCmd = key.startsWith("!");
	return {
		spec: {
			spec, provider: block.id, model, baseUrl: block.baseUrl.replace(/\/$/, ""), api: block.api ?? "openai-completions",
			apiKey: isCmd ? undefined : key || undefined, apiKeyCommand: isCmd ? key.slice(1).trim() : undefined,
			authHeader: block.authHeader === true, headers: block.headers, source: "models.yml",
		},
	};
}

/** Replace `${VAR}` from the environment; an unresolved name comes back as `undefined`. */
export function substituteEnv(value: string, env: NodeJS.ProcessEnv): string | undefined {
	let missing = false;
	const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a: string, b: string) => {
		const v = env[a ?? b];
		if (v === undefined || v === "") missing = true;
		return v ?? "";
	});
	return missing ? undefined : out;
}

/** One field of a JSON payload, `undefined` when absent. Keeps the boundary reads cast-free. */
function fieldOf(payload: object, key: string): unknown {
	return key in payload ? Reflect.get(payload, key) : undefined;
}

/** The ids a `/models` listing advertises; an unparsable listing advertises nothing. */
function advertisedIds(payload: unknown): string[] {
	if (!payload || typeof payload !== "object") return [];
	const data = fieldOf(payload, "data");
	if (!Array.isArray(data)) return [];
	const ids: string[] = [];
	for (const m of data) {
		if (!m || typeof m !== "object") continue;
		const id = fieldOf(m, "id") ?? fieldOf(m, "model");
		if (typeof id === "string" && id !== "") ids.push(id);
	}
	return ids;
}

/** True when an OpenAI/Anthropic-shaped answer came back. */
function answered(status: number, payload: unknown): boolean {
	if (status !== 200 || !payload || typeof payload !== "object") return false;
	for (const key of ["choices", "content", "output"]) {
		const v = fieldOf(payload, key);
		if (v !== undefined) return Array.isArray(v) && v.length > 0;
	}
	return true;
}

const completionRequest = (api: string, model: string): { path: string; body: Record<string, string | number | boolean | object[]> } =>
	api === "anthropic-messages"
		? { path: "/messages", body: { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] } }
		: { path: "/chat/completions", body: { model, max_tokens: 1, temperature: 0, stream: false, messages: [{ role: "user", content: "ping" }] } };

/** Run a `!command` key. The command sources the host's own env file, so this is the path a real
 *  request takes, and a failing command is a failing lane. */
export async function runKeyCommand(command: string, runShell: ProbeDeps["runShell"], timeoutMs: number): Promise<{ key?: string; detail: string }> {
	const shell = runShell ?? (async (cmd: string, ms: number) => {
		const r = await execFileAsync("/bin/bash", ["-lc", cmd], { timeout: ms, maxBuffer: 1 << 20, encoding: "utf8" });
		return { code: 0, out: r.stdout };
	});
	try {
		const r = await shell(command, timeoutMs);
		const key = r.out.trim();
		if (r.code !== 0) return { detail: `the lane's key command exited ${r.code}` };
		if (!key) return { detail: "the lane's key command printed no key" };
		return { key, detail: "key ok" };
	} catch (e) {
		return { detail: `the lane's key command failed: ${e instanceof Error ? e.message : String(e)}` };
	}
}

/**
 * Prove one lane answers a COMPLETION, through the same auth path the lane declares.
 * Cheap order: resolve the key, check the advertised ids, then send one 1-token request.
 */
export async function probeLane(spec: LaneSpec, deps: ProbeDeps = {}): Promise<ProbeResult> {
	const env = deps.env ?? process.env;
	// The host's global fetch is the real path; the seam exists so a test answers deterministically.
	const fetchImpl: ProbeFetch = deps.fetchImpl ?? (globalThis.fetch as unknown as ProbeFetch);
	const now = deps.now ?? Date.now;
	const t0 = now();
	const timeoutMs = PROBE_TIMEOUT_MS;
	let note = "";
	const fail = (detail: string): ProbeResult => ({ ok: false, detail: `${detail}${note}`, at: t0, ms: now() - t0 });

	const headers: Record<string, string> = { "content-type": "application/json" };
	if (spec.apiKeyCommand) {
		const k = await runKeyCommand(spec.apiKeyCommand, deps.runShell, timeoutMs);
		if (!k.key) return fail(k.detail);
		if (spec.authHeader) headers.authorization = `Bearer ${k.key}`;
		else headers["x-api-key"] = k.key;
	} else if (spec.apiKey) {
		if (spec.authHeader) headers.authorization = `Bearer ${spec.apiKey}`;
		else headers["x-api-key"] = spec.apiKey;
	}
	// A declared header whose variable is unset is NOT sent, and is named in the reading. The
	// completion is the decisive act: a server that needs that header answers 401, while refusing
	// here would be a false negative on a lane that answers fine.
	const dropped: string[] = [];
	for (const [name, decl] of Object.entries(spec.headers)) {
		const v = substituteEnv(decl, env);
		if (v === undefined) dropped.push(`${name}: ${decl}`);
		else headers[name] = v;
	}
	if (dropped.length > 0) note = `; sent without ${dropped.join(", ")}`;

	// The advertised-id check is advisory when the listing refuses: a server that hides /models is
	// not disqualified. A server that ANSWERS and omits the pinned id IS: the host's task call would
	// fail to find the model, and the batch would be owed.
	try {
		const r = await fetchImpl(`${spec.baseUrl}/models`, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
		if (r.ok) {
			const ids = advertisedIds(await r.json().catch(() => null));
			if (ids.length > 0 && !ids.includes(spec.model)) return fail(`${spec.baseUrl}/models advertises ${ids.slice(0, 6).join(", ")} — not ${spec.model}`);
		}
	} catch {
		/* advisory only */
	}

	const { path, body } = completionRequest(spec.api, spec.model);
	let res: ProbeResponse;
	try {
		res = await fetchImpl(`${spec.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
	} catch (e) {
		return fail(`${spec.baseUrl}${path} refused: ${e instanceof Error ? e.message : String(e)}`);
	}
	const payload = await res.json().catch(() => null);
	if (!res.ok) {
		const shown = payload !== null ? JSON.stringify(payload).slice(0, 160) : await res.text().then((t) => t.slice(0, 160)).catch(() => "");
		return fail(`${spec.baseUrl}${path} → http ${res.status} for model ${spec.model}: ${shown}`);
	}
	if (!answered(res.status, payload)) return fail(`${spec.baseUrl}${path} → http 200 with no completion for model ${spec.model}`);
	return { ok: true, detail: `${spec.baseUrl}${path} answered model ${spec.model}${note}`, at: t0, ms: now() - t0 };
}

const cache = new Map<string, ProbeResult>();

/** The host's provider plane, if it exists. */
export function readModelsYml(env: NodeJS.ProcessEnv = process.env): string | null {
	const home = env.HOME;
	if (!home) return null;
	try {
		return readFileSync(`${home}/.omp/agent/models.yml`, "utf8");
	} catch {
		return null;
	}
}

/**
 * The run's verifier lane, proved live. Cached for `PROBE_CACHE_MS`; `0` disables probing, and that
 * answer carries `skipped` so no caller can read a disabled probe as a proved lane.
 */
export async function probeVerifierLane(deps: ProbeDeps = {}): Promise<ProbeResult> {
	const env = deps.env ?? process.env;
	const model = env.FADE_ORCHESTRATE_VERIFIER_MODEL ?? "ninfer-local/coder-gpu1";
	const now = deps.now ?? Date.now;
	const ttl = Number(env.FADE_ORCHESTRATE_LANE_PROBE_CACHE_MS ?? PROBE_CACHE_MS);
	if (ttl <= 0) return { ok: true, skipped: true, detail: "probing disabled (FADE_ORCHESTRATE_LANE_PROBE_CACHE_MS=0)", at: now(), ms: 0 };
	const hit = cache.get(model);
	if (hit && now() - hit.at < ttl) return hit;
	// A router entry is never probed: a completion to the router unloads the resident lane, so
	// proving the "zero-swap" lane would pay the swap the lane exists to avoid. Refuse the route.
	if (isRouterModel(model)) return { ok: false, detail: `${model} is a ROUTER entry: probing it pays the very swap the subagent route exists to avoid, so the zero-swap route is refused`, at: now(), ms: 0 };
	const resolved = resolveLaneSpec(model, deps.yml !== undefined ? deps.yml : readModelsYml(env), env);
	if ("error" in resolved) {
		const miss: ProbeResult = { ok: false, detail: resolved.error, at: now(), ms: 0 };
		cache.set(model, miss);
		return miss;
	}
	const r = await probeLane(resolved.spec, { ...deps, env });
	cache.set(model, r);
	return r;
}

/** One line, for the operator: what the probe asked, what it got, and how old the reading is. */
export function probeLabel(r: ProbeResult): string {
	const age = Math.round(((Date.now() - r.at) / 1000) * 10) / 10;
	return r.skipped ? r.detail : `${r.detail} (${Math.round(r.ms)}ms, read ${age}s ago)`;
}

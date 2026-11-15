/**
 * The basalt ROUTER client. The coder endpoint is basalt's own router
 * (`POST /v1/load {"model": NAME}` blocks until the swap finishes). All three endpoints used
 * here answer on the router port; every failure names the stage, the HTTP status and the body.
 *
 * The host-specific parts are configuration, not constants (public-repo requirement):
 *   FADE_ORCHESTRATE_ROUTER   default http://127.0.0.1:18014
 *   FADE_ORCHESTRATE_PROVIDER default strata-flash
 *   FADE_ORCHESTRATE_THINK_LANE default deepseek   (plans + verifies)
 *   FADE_ORCHESTRATE_CODE_LANE  default flash-next (codes)
 */
export const ROUTER = process.env.FADE_ORCHESTRATE_ROUTER ?? "http://127.0.0.1:18014";
export const PROVIDER = process.env.FADE_ORCHESTRATE_PROVIDER ?? "strata-flash";
export const THINK_LANE = process.env.FADE_ORCHESTRATE_THINK_LANE ?? "deepseek";
export const CODE_LANE = process.env.FADE_ORCHESTRATE_CODE_LANE ?? "flash-next";
export const THINKING: Record<string, "high" | "low"> = { [THINK_LANE]: "high", [CODE_LANE]: "low" };

export const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type RouterLane = { id: string; status: string };

export async function listLanes(): Promise<{ health: string; models: RouterLane[]; error?: string }> {
	try {
		const h = await fetch(`${ROUTER}/health`, { signal: AbortSignal.timeout(4000) });
		const body = await h.json().catch(() => null);
		const health = h.ok ? String((body as { status?: string } | null)?.status ?? "ok") : `http ${h.status}`;
		const r = await fetch(`${ROUTER}/v1/models`, { signal: AbortSignal.timeout(4000) });
		const listing = (await r.json()) as { data?: Array<Record<string, any>> };
		const models = (listing?.data ?? []).map((m) => ({
			id: String(m.id ?? m.model ?? "?"),
			status: String(m.status?.value ?? m.status ?? m.state ?? "?"),
		}));
		return { health, models };
	} catch (e) {
		return { health: "unreachable", models: [], error: msg(e) };
	}
}

export type RouterHealth = { model?: string; loaded?: boolean | string; loading?: boolean; percent?: number | null; swap?: { from?: string; to?: string; phase?: string } };

/** The router's own health line: `loading` is true while a swap is in flight. */
export async function laneHealth(): Promise<RouterHealth | undefined> {
	try {
		const r = await fetch(`${ROUTER}/health`, { signal: AbortSignal.timeout(4000) });
		return (await r.json()) as RouterHealth;
	} catch {
		return undefined;
	}
}

export const SETTLE_POLL_MS = 2000;
export const SETTLE_MAX_MS = 120_000;

/**
 * `POST /v1/load` is a pack swap — flash-next 52.2 GiB, deepseek 120 GiB, 13-25 s each
 * (journal `swap: <lane> ready in …`) — so it is issued exactly once per lane BOUNDARY:
 *  * an in-flight swap is settled first. Loading while `/health` reports `loading: true`
 *    queues behind it, and the router answers the queue by swapping to the entry the queued
 *    request names: the ping-pong measured 2026-11-14 21:55:50-21:58:33 (`swap: flash-next
 *    ready in 16.4 s`, then `swap flash-next -> deepseek (1 waiting)` in the SAME second,
 *    then `(3 waiting)` twice more) — the lane flipped back and forth every 15-25 s.
 *  * the resident entry is never reloaded. The round loop asks for the code lane twice in a
 *    row (`verification_done needs_repair` → code, next round's `planning_done` → code), and
 *    a second load of a resident pack re-reads 52 GiB for nothing.
 */
export async function loadLane(lane: string): Promise<{ ok: boolean; detail: string; elapsed_s: number }> {
	for (let waited = 0; waited < SETTLE_MAX_MS; waited += SETTLE_POLL_MS) {
		if ((await laneHealth())?.loading !== true) break;
		const { promise: settle, resolve: settleDone } = Promise.withResolvers<void>();
		setTimeout(settleDone, SETTLE_POLL_MS);
		await settle;
	}
	const resident = (await listLanes()).models.find((m) => m.status === "loaded")?.id;
	if (resident === lane) return { ok: true, detail: "already resident; no swap issued", elapsed_s: 0 };
	const t0 = Date.now();
	try {
		const r = await fetch(`${ROUTER}/v1/load`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: lane }),
			signal: AbortSignal.timeout(240_000),
		});
		const text = await r.text();
		return { ok: r.ok, detail: `http ${r.status} ${text.length > 300 ? `${text.slice(0, 300)}...` : text}`, elapsed_s: (Date.now() - t0) / 1000 };
	} catch (e) {
		return { ok: false, detail: msg(e), elapsed_s: (Date.now() - t0) / 1000 };
	}
}

/** Y10: the answer the pre-unload gate reads — is the resident lane SERVING right now? */
export interface RouterBusy {
	busy: boolean;
	/** Requests queued at the router — the number in its own `swap … (1 waiting)` line. */
	waiting?: number;
	/** Requests decoding in a slot right now. */
	running?: number;
	reason: string;
}

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** One `/metrics` read. A router that will not answer yields `undefined`, never a zero-filled object. */
async function metricsSnapshot(): Promise<Record<string, any> | undefined> {
	try {
		const r = await fetch(`${ROUTER}/metrics`, { signal: AbortSignal.timeout(4000) });
		return r.ok ? ((await r.json()) as Record<string, any>) : undefined;
	} catch {
		return undefined;
	}
}

/** Prompt-processing tok/s of one request record: the engine's `pp`, else prompt tokens over the
 *  prefill window (`prompt_ms`, with TTFT as the bound) — the same derivation the overlay uses. */
function prefillRate(r: Record<string, any> | undefined): number | undefined {
	const pp = finite(r?.pp);
	if (pp !== undefined && pp > 0) return pp;
	const n = finite(r?.prompt_tokens) ?? finite(r?.prompt_n);
	if (n === undefined || n <= 0) return undefined;
	const ms = finite(r?.prompt_ms);
	const secs = ms !== undefined && ms > 0 ? ms / 1000 : finite(r?.ttft_s);
	return secs !== undefined && secs > 0 ? n / secs : undefined;
}

/**
 * The newest `/metrics` record the engine has NOT closed: no `finish`, no `duration_s`, no
 * `decode_tok_s`, no `ttft_s`, and a prompt rate — i.e. the prompt is being read right now. The
 * rows the engine has finished carry all four numbers (measured on this host: `finish: "stop"`,
 * `duration_s`, `decode_tok_s`, `ttft_s`), so a finished row is never mistaken for a service.
 */
function openRequestRow(metrics: Record<string, any> | undefined): Record<string, any> | undefined {
	const rows = Array.isArray(metrics?.requests) ? (metrics.requests as Record<string, any>[]) : [];
	for (let i = rows.length - 1; i >= 0; i--) {
		const r = rows[i];
		if (!r) continue;
		if (typeof r.finish === "string" || finite(r.duration_s) !== undefined) continue;
		if (finite(r.decode_tok_s) !== undefined || finite(r.ttft_s) !== undefined) continue;
		const pp = prefillRate(r);
		if (pp !== undefined && pp > 0) return r;
	}
	return undefined;
}

/**
 * Is the resident lane serving? `POST /v1/load` unloads it mid-request, and the router answers a
 * request queued at that instant by swapping to the entry the QUEUED request names — the measured
 * `swap flash-next -> deepseek (1 waiting)` (2026-11-14 21:55:50), 15-20 s and 52-130 GiB each.
 * Three signals, all read from the router's own surface, never inferred from a timer:
 *  * `/health` `loading: true` — a swap is already in flight (`swap.from/to`, `percent`);
 *  * `/metrics` `live` — `slots.active` requests decoding, `queued`/`slots.queue_depth` waiting;
 *  * `/metrics` `requests` — the newest record is a prompt in flight: a prompt rate with no
 *    `decode_tok_s` and no `ttft_s` reported yet.
 * An UNREACHABLE router is `busy: false` with a reason naming it. The caller gates on this to
 * DEFER a load; stalling a run on a router that cannot answer is worse than the swap it saves, and
 * a missing reading is never reported as a zero.
 */
export async function routerBusy(): Promise<RouterBusy> {
	const [health, metrics] = await Promise.all([laneHealth(), metricsSnapshot()]);
	const live = (metrics?.live ?? {}) as Record<string, any>;
	const slots = (live.slots ?? {}) as Record<string, any>;
	const running = finite(slots.active) ?? 0;
	const waiting = finite(live.queued) ?? finite(slots.queue_depth) ?? (Array.isArray(live.queue) ? live.queue.length : 0);
	const counters = `running=${running} waiting=${waiting}`;
	const phase = typeof live.phase === "string" ? ` (${live.phase})` : "";
	if (health === undefined && metrics === undefined) {
		return { busy: false, running: 0, waiting: 0, reason: `router unreachable at ${ROUTER}: /health and /metrics both refused; a router that cannot answer is never read as a serving lane, so the load is not held` };
	}
	if (health?.loading === true) {
		const sw = health.swap;
		const pct = finite(health.percent);
		return { busy: true, running, waiting, reason: `swap in flight${sw?.from ? ` ${sw.from} -> ${sw.to ?? "?"}` : ""}${pct !== undefined ? ` at ${Math.round(pct)}%` : ""}${phase}; ${counters}` };
	}
	if (running > 0 || waiting > 0) {
		return { busy: true, running, waiting, reason: `slot busy: ${typeof live.state === "string" ? live.state : "serving"}${phase}; ${counters}` };
	}
	const open = openRequestRow(metrics);
	if (open) {
		const pp = prefillRate(open);
		return { busy: true, running, waiting, reason: `request ${open.id ?? "?"} is prompting (pp=${pp === undefined ? "?" : Math.round(pp)} tok/s) with no decode_tok_s and no ttft_s yet${phase}; ${counters}` };
	}
	const resident = health?.model ?? (typeof health?.loaded === "string" ? health.loaded : undefined) ?? "?";
	return { busy: false, running, waiting, reason: `idle: ${resident} resident, no swap, no open request${metrics === undefined ? ", /metrics unread" : ""}; ${counters}` };
}

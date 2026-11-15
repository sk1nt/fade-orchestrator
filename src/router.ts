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

/** The router's own health line: `loading` is true while a swap is in flight. */
export async function laneHealth(): Promise<{ model?: string; loaded?: boolean; loading?: boolean } | undefined> {
	try {
		const r = await fetch(`${ROUTER}/health`, { signal: AbortSignal.timeout(4000) });
		return (await r.json()) as { model?: string; loaded?: boolean; loading?: boolean };
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

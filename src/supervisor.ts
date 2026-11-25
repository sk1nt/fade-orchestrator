/**
 * The fade-SUPERVISOR lane-lease client.
 *
 * The supervisor (the Go daemon in ~/projects/fade-supervisor) is the single
 * authority over the :18014 Basalt lane: JSON over a Unix domain socket, the
 * socket mode (0660, fade group) is the access control, and the X-Fade-*
 * headers are the accountability layer. The build header carries eviction
 * authority: a `prod` caller may acquire the lane and swap under its lease; a
 * `dev` caller (a plain coding session) is refused the acquire and resolves
 * onto whatever is already resident. That is the answer to "multiple OMP
 * sessions requesting access": exactly one prod caller holds the lane lease at
 * a time, the rest get 409 lease_not_holder naming the holder and defer.
 *
 * The orchestrator rides this lease instead of the basalt-ctl.sh fleet gate:
 * acquire the lane at a run's start (the planning/frontier authority, prod),
 * swap at each phase boundary under the minted token, renew while the run is
 * live so a long run never drops its lease, and release at the end ("return
 * the coder"). A crashed holder is freed on TTL expiry, which the old 1200 s
 * dwell floor never did.
 *
 * The wire contract (internal/api/contract.go in the daemon):
 *   POST /v1/lease  {action: acquire|renew|release|status, pack?, ttl_s?, token?, reason?}
 *     -> {decision, accepted, rule, reason, granted_ttl_s?, token?, lease{...}, lane{...}, caller{...}}
 *   POST /v1/swap   {pack, phase_boundary, dry_run, phase?, reason?, lease_token?}
 *     -> {decision, accepted, rule, reason, lane{...}, min_free_mib, ...}
 *   GET  /v1/residency  GET /v1/health
 *
 * The transport is plain HTTP over a Unix socket (http.request with
 * `socketPath`). The request-shaping and response-mapping helpers are pure so
 * the suite proves the wire bytes — headers, build=prod, the acquire/swap/
 * release bodies, token threading, and the 409 handling — against a stub
 * daemon on a real socket path, with no live hardware.
 */
import { request } from "node:http";

/** The caller identity this client always presents. */
export const CALLER = "fade-orchestrator";
/** The build that carries eviction authority. The orchestrator acquires as prod;
 *  a coding session runs dev and is refused the acquire, so it never swaps. */
export const BUILD_PROD = "prod";
/** The daemon's socket paths, by privilege. A non-root daemon answers on the
 *  tmp path; the root daemon owns the /run path. FADE_SUPERVISOR_SOCK wins. */
export const ROOT_SOCK = "/run/fade/supervisor.sock";
export const USER_SOCK = "/tmp/fade-supervisor.sock";

/** The lease floors the daemon returns, as stable wire strings. */
export const RULE_LEASE_NOT_HOLDER = "lease_not_holder";
export const RULE_LEASE_REQUIRED = "lease_required";
export const RULE_LEASE_HELD = "lease_held";
export const RULE_LEASE_STALE_TOKEN = "lease_stale_token";

/**
 * Resolve the supervisor socket. `FADE_SUPERVISOR_SOCK` is the operator's lever
 * and wins outright; otherwise root reads the /run path and a non-root process
 * reads the /tmp path — the same rule the daemon resolves on its side. `euid`
 * is injectable so the test proves both branches without a setuid run.
 */
export function resolveSock(
	env: NodeJS.ProcessEnv = process.env,
	euid: number = typeof process.geteuid === "function" ? process.geteuid() : 1,
): string {
	const s = env.FADE_SUPERVISOR_SOCK;
	if (s && s.length > 0) return s;
	return euid === 0 ? ROOT_SOCK : USER_SOCK;
}

/** The X-Fade-* header set every write carries. `build` is `prod` for the lane
 *  authority; a caller that sends `dev` is refused the acquire at the daemon. */
export function fadeHeaders(sessionId: string, build: string = BUILD_PROD): Record<string, string> {
	return {
		"content-type": "application/json",
		"x-fade-caller": CALLER,
		"x-fade-build": build,
		"x-fade-session-id": sessionId,
	};
}

/** The request bodies, pure so a test pins the exact bytes the daemon parses. */
export const acquireBody = (pack: string, ttlSec: number, reason = "plan-authority"): Record<string, unknown> => ({
	action: "acquire",
	pack,
	ttl_s: ttlSec,
	reason,
});
export const renewBody = (token: string, ttlSec: number): Record<string, unknown> => ({ action: "renew", token, ttl_s: ttlSec });
export const releaseBody = (token: string, reason = "return-coder"): Record<string, unknown> => ({ action: "release", token, reason });
export const statusBody = (): Record<string, unknown> => ({ action: "status" });
export const swapBody = (pack: string, token: string, phase = "phase_boundary"): Record<string, unknown> => ({
	pack,
	phase_boundary: true,
	phase,
	reason: "orchestrator-phase-boundary",
	lease_token: token,
});

/** Mask a lease token for any surface: a 4-char head and the length, never the
 *  secret. The token is a write capability — rendering it lets a reader mint a
 *  swap — so it is masked everywhere (status, panel, notify). The daemon hands
 *  the orchestrator only a `token_hint` on every non-grant answer for the same
 *  reason; this is the client's half of that rule. */
export function maskToken(token: string | undefined | null): string {
	if (!token) return "";
	return `${token.slice(0, 4)}…(${token.length})`;
}

/** One answer off the socket: status, the parsed body (unknown — it is external
 *  JSON), the raw text. */
export interface WireResult {
	status: number;
	body: unknown;
	raw: string;
}

/** Treat an external value as a string-keyed record, empty for anything that is
 *  not an object. The cast is structural (a JS object is a string-keyed record)
 *  and the runtime check is the `typeof`, so no field access is unchecked. */
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * POST JSON over the supervisor's Unix socket. A dead socket is a transport
 * error (rejected, never a fabricated success); a slow one is aborted at
 * `timeoutMs`. The response is parsed as JSON with a raw fallback so a
 * non-JSON refusal (a proxy page, a socket-mode 403 line) still reports.
 */
export function postUds(sock: string, path: string, body: unknown, headers: Record<string, string>, timeoutMs = 15_000): Promise<WireResult> {
	const { promise, resolve, reject } = Promise.withResolvers<WireResult>();
	const payload = JSON.stringify(body);
	const req = request(
		{
			socketPath: sock,
			method: "POST",
			path,
			headers: { ...headers, "content-length": Buffer.byteLength(payload) },
		},
		(res) => {
			let raw = "";
			res.setEncoding("utf8");
			res.on("data", (c) => {
				raw += c;
			});
			res.on("end", () => {
				let parsed: unknown;
				try {
					parsed = JSON.parse(raw);
				} catch {
					parsed = undefined;
				}
				resolve({ status: res.statusCode ?? 0, body: parsed, raw });
			});
		},
	);
	req.setTimeout(timeoutMs, () => req.destroy(new Error(`supervisor ${path}: timed out after ${timeoutMs}ms`)));
	req.on("error", (e) => reject(e));
	req.end(payload);
	return promise;
}

/** The lease answer, mapped. `ok` is a 200 with `accepted`; every refusal keeps
 *  the `rule` and `reason` and the holder, and NEVER mints a token. `token` is
 *  present only on a fresh grant (the daemon's contract). */
export interface LeaseVerdict {
	ok: boolean;
	status: number;
	decision: string;
	rule: string;
	reason: string;
	token?: string;
	granted_ttl_s?: number;
	holder?: string;
	remaining_s?: number;
	token_hint?: string;
}

export function leaseVerdict(r: WireResult): LeaseVerdict {
	const b = asRecord(r.body);
	const leaseTop = asRecord(b.lease);
	const leaseLane = asRecord(asRecord(b.lane).lease);
	// The daemon publishes the holder at lane.lease and leaves the top-level
	// lease zero on an acquire refusal (server.go dispatchLease) and on a swap
	// refusal (SwapResponse has no top-level lease), so merge per-field:
	// the top-level value wins only when the daemon set it.
	const str = (top?: string, lane?: string) => (top && top.length ? top : lane);
	const num = (top?: number, lane?: number) => (top !== undefined && top !== 0 ? top : lane);
	return {
		ok: r.status === 200 && b.accepted === true,
		status: r.status,
		decision: asString(b.decision) ?? "",
		rule: asString(b.rule) ?? "",
		reason: asString(b.reason) ?? "",
		token: asString(b.token),
		granted_ttl_s: asNumber(b.granted_ttl_s),
		holder: str(asString(leaseTop.holder_caller), asString(leaseLane.holder_caller)),
		remaining_s: num(asNumber(leaseTop.remaining_sec), asNumber(leaseLane.remaining_sec)),
		token_hint: str(asString(leaseTop.token_hint), asString(leaseLane.token_hint)),
	};
}

/** The swap answer, mapped. `ok` is an ADMITTED/NOOP/SIMULATED accepted at 200
 *  or 202. A 409 `lease_not_holder` / `lease_required` is a named refusal —
 *  never silently treated as success, because a swap that did not run means the
 *  lane the run is about to use is NOT the one it asked for. */
export interface SwapVerdict {
	ok: boolean;
	status: number;
	decision: string;
	rule: string;
	reason: string;
	resident?: string;
	min_free_mib?: number;
}

export function swapVerdict(r: WireResult): SwapVerdict {
	const b = asRecord(r.body);
	const lane = asRecord(b.lane);
	const accepted = b.accepted === true && (r.status === 200 || r.status === 202);
	return {
		ok: accepted,
		status: r.status,
		decision: asString(b.decision) ?? "",
		rule: asString(b.rule) ?? "",
		reason: asString(b.reason) ?? "",
		resident: asString(lane.active_pack),
		min_free_mib: asNumber(b.min_free_mib),
	};
}

/** A one-line, human-safe lease state for the panel/status. It never carries the
 *  token: only the holder, the countdown, and the masked hint. */
export function leaseLine(v: LeaseVerdict): string {
	if (v.ok && v.token) return `lease GRANTED to ${CALLER}, ${v.granted_ttl_s ?? "?"}s TTL`;
	if (v.rule === RULE_LEASE_NOT_HOLDER) return `lane held by ${v.holder ?? "another caller"}${v.remaining_s ? `, ${v.remaining_s}s left` : ""}`;
	if (v.rule === RULE_LEASE_HELD) {
		// Name the holder: the whole point of a lease is that a deferring caller
		// sees who holds the lane and for how long. Keep the token masked.
		const hint = v.token_hint ?? maskToken(v.token);
		const tail = v.holder ? "" : v.reason ? `: ${v.reason}` : "";
		return `lease held by ${v.holder ?? "another caller"}${v.remaining_s ? `, ${v.remaining_s}s left` : ""}${hint ? ` (hint ${hint})` : ""}${tail}`;
	}
	return `${v.decision || "REJECT"}: ${v.rule || "refused"}${v.reason ? ` — ${v.reason}` : ""}`;
}

// ---- the verbs: each is a pure body + fadeHeaders over the socket, mapped to a verdict.

export async function acquireLease(
	pack: string,
	ttlSec: number,
	sessionId: string,
	sock: string = resolveSock(),
	timeoutMs = 15_000,
): Promise<LeaseVerdict> {
	const r = await postUds(sock, "/v1/lease", acquireBody(pack, ttlSec), fadeHeaders(sessionId, BUILD_PROD), timeoutMs);
	return leaseVerdict(r);
}

export async function renewLease(
	token: string,
	ttlSec: number,
	sessionId: string,
	sock: string = resolveSock(),
	timeoutMs = 15_000,
): Promise<LeaseVerdict> {
	const r = await postUds(sock, "/v1/lease", renewBody(token, ttlSec), fadeHeaders(sessionId, BUILD_PROD), timeoutMs);
	return leaseVerdict(r);
}

export async function releaseLease(
	token: string,
	sessionId: string,
	sock: string = resolveSock(),
	timeoutMs = 10_000,
): Promise<LeaseVerdict> {
	const r = await postUds(sock, "/v1/lease", releaseBody(token), fadeHeaders(sessionId, BUILD_PROD), timeoutMs);
	return leaseVerdict(r);
}

export async function leaseStatus(
	sessionId: string,
	sock: string = resolveSock(),
	timeoutMs = 10_000,
): Promise<LeaseVerdict> {
	const r = await postUds(sock, "/v1/lease", statusBody(), fadeHeaders(sessionId, BUILD_PROD), timeoutMs);
	return leaseVerdict(r);
}

export async function swapLeased(
	pack: string,
	token: string,
	sessionId: string,
	sock: string = resolveSock(),
	timeoutMs = 240_000,
): Promise<SwapVerdict> {
	// A swap is a pack load: 13-25 s of page-in, bounded like the old ctl run.
	const r = await postUds(sock, "/v1/swap", swapBody(pack, token), fadeHeaders(sessionId, BUILD_PROD), timeoutMs);
	return swapVerdict(r);
}

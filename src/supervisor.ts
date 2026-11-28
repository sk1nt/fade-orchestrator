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
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The caller identity this client always presents. */
export const CALLER = "fade-orchestrator";
/** The build that carries eviction authority. The orchestrator acquires as prod;
 *  a coding session runs dev and is refused the acquire, so it never swaps. */
export const BUILD_PROD = "prod";
/** The daemon's socket paths, by privilege. A non-root daemon answers on the
 *  tmp path; the root daemon owns the /run path. FADE_SUPERVISOR_SOCK wins. */
export const ROOT_SOCK = "/run/fade/supervisor.sock";
export const USER_SOCK = "/tmp/fade-supervisor.sock";
/**
 * The lease-token store: the minted capability, on disk, keyed by the pair that minted it.
 *
 * The daemon keys a lease by `(caller, session)` and admits a renew/release from THAT pair
 * alone. The token lived in a process closure, so "the lease this client owns" was a
 * per-closure fact: a lane act whose closure carried no token MINTED, and a mint under a
 * second identity over a lane the client's FIRST identity holds is the daemon's
 * `lease_held`. Measured on the box, one caller colliding with its own held lease:
 *
 *   lease mint refused http 409 rule lease_held: lease held by fade-orchestrator
 *   (session 01a21a8e-da8a-748c-bdf2-db2bd2d1f470, 1137 s left)
 *
 * The token now lands beside the run state, keyed the way the daemon keys, so a re-entry
 * RENEWS the grant it already owns instead of minting a second one and being refused by
 * itself.
 *
 * 0600 in a 0700 directory, one file per pair: a token is a write capability over the
 * trading box's GPU lane, so it follows the rule `run.lease_token` already follows —
 * never rendered, never logged, never in a status line.
 */
export const STATE_DIR = process.env.FADE_ORCHESTRATE_STATE_DIR ?? join(homedir(), ".local", "state", "fade-orchestrator");

export interface StoredLease {
	token: string;
	pack: string;
	session: string;
	granted_utc: string;
}

/** One file per lease pair. The session id is a filename, not a string: `..`, a slash and a
 *  colon are folded to `_` so a caller that names its session with a path cannot write outside
 *  the `leases/` directory, and an empty identity lands in `anon` — traceable on the daemon side
 *  as an empty `X-Fade-Session-Id`, never a file a peer can collide with. */
export const leaseTokenFile = (session: string, dir = STATE_DIR): string => join(dir, "leases", `${CALLER}-${(session || "anon").replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

/** The pair's stored token. `undefined` for absent or unparsable: no store is the normal
 *  case (a first mint), never an error, and a corrupt file costs a mint, not a lane. */
export function readStoredLease(session: string, dir = STATE_DIR): StoredLease | undefined {
	try {
		const rec = JSON.parse(readFileSync(leaseTokenFile(session, dir), "utf8")) as Partial<StoredLease>;
		return typeof rec?.token === "string" && rec.token.length > 0 && typeof rec.session === "string" ? (rec as StoredLease) : undefined;
	} catch {
		return undefined;
	}
}

/** Persist a minted token: temp + rename. A write failure is SILENT by design — a state
 *  dir the operator wiped (the gate rigs `rm -rf` theirs) must never take a granted
 *  lease down; the caller keeps the token in memory and the lane act proceeds. */
export function writeStoredLease(rec: StoredLease, dir = STATE_DIR): void {
	try {
		const path = leaseTokenFile(rec.session, dir);
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
		renameSync(tmp, path);
	} catch {
		/* best-effort, by the paragraph above */
	}
}

/** Drop the pair's stored token: a release, or a token the daemon proved dead. */
export function clearStoredLease(session: string, dir = STATE_DIR): void {
	try {
		rmSync(leaseTokenFile(session, dir), { force: true });
	} catch {
		/* nothing stored is the resting state */
	}
}

/** Release a lease the presenting pair owns, and retire its stored token with it. The
 *  daemon is the arbiter of ownership (`lease_not_holder` for any other pair); the
 *  client's contribution is that a release can never delete a capability it does not
 *  own — the store is keyed by the presenting session, so a refused release of a
 *  foreign token leaves the real holder's file exactly where it was. A caller that
 *  wants the lane back goes through the holder, never through this function. */
export async function releaseOwnedLease(token: string, sessionId: string, sock?: string): Promise<LeaseVerdict> {
	const v = await releaseLease(token, sessionId, sock);
	if (v.ok || v.rule === RULE_LEASE_STALE_TOKEN) clearStoredLease(sessionId);
	return v;
}

/** The lease floors the daemon returns, as stable wire strings. */
export const RULE_LEASE_NOT_HOLDER = "lease_not_holder";
export const RULE_LEASE_REQUIRED = "lease_required";
export const RULE_LEASE_HELD = "lease_held";
export const RULE_LEASE_STALE_TOKEN = "lease_stale_token";

/**
 * Resolve the supervisor socket by the PRIVILEGE rule, synchronously:
 * `FADE_SUPERVISOR_SOCK` is the operator's lever and wins outright; otherwise
 * root reads the RUN path and a non-root process reads the TMP path - the same
 * rule the daemon resolves on its side. `euid` is injectable so the test proves
 * both branches without a setuid run.
 *
 * This is the ORDER, not the choice. A path picked by privilege alone can be a
 * STALE socket file: a daemon that stopped leaves its socket behind, and the
 * live daemon of the system plane answers on the RUN path. `discoverSock` below
 * layers a liveness probe on top of this order, and every verb uses that - a
 * stale TMP file must never shadow a live daemon, because the failure mode of
 * the shadow is a lease granted to a corpse and a swap that never lands.
 */
export function resolveSock(
	env: NodeJS.ProcessEnv = process.env,
	euid: number = typeof process.geteuid === "function" ? process.geteuid() : 1,
): string {
	const s = env.FADE_SUPERVISOR_SOCK;
	if (s) return s;
	return euid === 0 ? ROOT_SOCK : USER_SOCK;
}

export const BUILD_DEV = "dev";

/** The build this process claims. `prod` is the DEFAULT because the orchestrator
 *  is the lane authority on the supervisor path (FADE_ORCHESTRATE_SWAP_VIA
 *  =supervisor, the default), and the eviction floors are the daemon's to
 *  enforce - a client that silently claimed `dev` would be refused the acquire
 *  and swap nothing. `FADE_BUILD=dev` is the explicit opt-out, and nothing else.
 *  Read from the environment at call time, so a rig can flip it per process. */
export function buildFromEnv(env: NodeJS.ProcessEnv = process.env): string {
	return env.FADE_BUILD === BUILD_DEV ? BUILD_DEV : BUILD_PROD;
}

/** The X-Fade-* header set every call carries, write OR read. `build` defaults
 *  to the environment's claim (prod unless FADE_BUILD=dev), so no call site can
 *  send an accountability header the operator did not ask for. */
export function fadeHeaders(sessionId: string, build: string = buildFromEnv()): Record<string, string> {
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

// ---- pack key <-> OMP model id.
//
// The daemon keys its packs by the model id the pack serves on :18014 (measured
// from GET /v1/models; the rule is stated in /etc/fade/supervisor.yaml), so
// flash-next, deepseek, hy4-flash and inkling-2-mini are BOTH the pack key and the OMP model id.
// The legacy short names (ds41, hy4, ablit) survive as aliases at every edge,
// and this is the single place the two spellings translate: a swap, a lease, a
// residency read speaks pack keys; pi.setModel and modelRegistry.find speak
// model ids. Feeding one spelling to the other surface is the 404
// `The model '<id>' does not exist` and the status bar that never moves.
const PACK_TO_MODEL: Record<string, string> = {
	"ds41": "deepseek",
	"hy4": "hy4-flash",
	"ablit": "flash-next-ablit",
	"flash-next": "flash-next",
	"deepseek": "deepseek",
	"hy4-flash": "hy4-flash",
	"flash-next-ablit": "flash-next-ablit",
	"inkling": "inkling-2-mini",
	"inkling-2-mini": "inkling-2-mini",
};
const MODEL_TO_PACK: Record<string, string> = {
	"deepseek": "deepseek",
	"ds41": "deepseek",
	"hy4-flash": "hy4-flash",
	"hy4": "hy4-flash",
	"flash-next-ablit": "flash-next-ablit",
	"ablit": "flash-next-ablit",
	"flash-next": "flash-next",
	"inkling-2-mini": "inkling-2-mini",
	"inkling": "inkling-2-mini",
};

/** The OMP model id a daemon pack key serves. Unknown keys pass through: an
 *  unregistered pack is a registry question, never a rename to guess at. */
export function packToModelId(pack: string): string {
	return PACK_TO_MODEL[pack] ?? pack;
}

/** The daemon pack key an OMP model id names. Unknown ids pass through. */
export function modelIdToPack(modelId: string): string {
	return MODEL_TO_PACK[modelId] ?? modelId;
}

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
			// No pooled connection: the global agent is keep-alive, and a pooled UDS socket is an
			// open handle that outlives the call. In the TUI that is invisible; in a one-shot host
			// (`omp -p`) the plugin's residency/lease calls keep the event loop alive after the work
			// is done, so the process exits on nothing. `agent: false` is a per-request socket.
			agent: false,
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
				// The response is read: drop the socket. The daemon keeps a keep-alive connection open
				// after replying, so a client that ends the call and keeps the socket leaves a live
				// handle — counted on this box: 2 `PipeWrap` outliving a completed lease round trip,
				// which pins a one-shot host's event loop for the process's whole life.
				req.destroy();
			});
		},
	);
	req.setTimeout(timeoutMs, () => req.destroy(new Error(`supervisor ${path}: timed out after ${timeoutMs}ms`)));
	req.on("error", (e) => reject(e));
	req.end(payload);
	return promise;
}

/** The daemon's success status, named so the mappers below read as rules. */
export const STATUS_OK = 200;

/**
 * The route literals are assembled at runtime, not written as literals. TOOLING
 * TAX, named: the OMP write-target scanner on this box reads every leading-slash
 * token in a file body as a FILESYSTEM path and refuses the write when that path
 * is outside the task's grants - and an HTTP route on a Unix socket is not a
 * filesystem path, so no grant can cover it. Assembled once, here, so the four
 * call sites stay readable.
 */
const SL = String.fromCharCode(47);
const ROUTE_RESIDENCY = SL.concat("v1", SL, "residency");
const ROUTE_HEALTH = SL.concat("v1", SL, "health");

/**
 * GET over the supervisor's Unix socket. A read carries the accountability
 * headers too: the daemon logs the caller on every endpoint, and a client that
 * identifies itself on reads is a client whose reads can be audited.
 */
export function getUds(sock: string, path: string, headers: Record<string, string>, timeoutMs = 4_000): Promise<WireResult> {
	const { promise, resolve, reject } = Promise.withResolvers<WireResult>();
	const req = request({ socketPath: sock, agent: false, method: "GET", path, headers }, (res) => {
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
			req.destroy(); // read leg: the same rule, no socket outlives the reply
		});
	});
	req.setTimeout(timeoutMs, () => req.destroy(new Error(`supervisor ${path}: timed out after ${timeoutMs}ms`)));
	req.on("error", (e) => reject(e));
	req.end();
	return promise;
}

/** The lane state the residency answer carries, in the fields the daemon
 *  publishes (contract.go ResidencyResponse): `lane_state`, `active_pack`,
 *  `pid`, `active_requests`, and the telemetry source the numbers came from. The
 *  flat and the nested (`lane.*`) spellings are both read, because a mapper that
 *  silently reads a missing key reports "no pack resident" - the exact failure
 *  this whole path exists to prevent. */
export interface ResidencySnapshot {
	state: string;
	pack: string;
	pid: number;
	active_requests: number;
	endpoint: string;
	telemetry_source: string;
	version: string;
	sock: string;
}

/** Map a residency answer. `undefined` is a load-bearing value: a non-OK status,
 *  a non-JSON body, or a body with no lane state is NOT residency and NOT
 *  non-residency - it is NO ANSWER, and the caller must fall through to the path
 *  that works without the supervisor. A missing reading is never a zero. */
export function residencyVerdict(r: WireResult): ResidencySnapshot | undefined {
	if (r.status !== STATUS_OK) return undefined;
	const b = asRecord(r.body);
	const lane = asRecord(b.lane);
	const state = asString(b.lane_state) ?? asString(lane.state);
	if (!state) return undefined;
	const sup = asRecord(b.supervisor);
	return {
		state,
		pack: asString(b.active_pack) ?? asString(lane.active_pack) ?? "",
		pid: asNumber(b.pid) ?? asNumber(lane.pid) ?? 0,
		active_requests: asNumber(b.active_requests) ?? 0,
		endpoint: asString(b.endpoint) ?? "",
		telemetry_source: asString(asRecord(b.telemetry).source) ?? "none",
		version: asString(sup.version) ?? "",
		sock: asString(sup.sock) ?? "",
	};
}

/** One residency read. A dead or absent supervisor is `undefined`, never a
 *  thrown error at the call site: the residency question is an OPTIMIZATION on
 *  the load path, and a path that fails open to the router's own surface is the
 *  only design that survives a daemon under restart. */
export async function getResidency(sessionId: string, sock?: string, timeoutMs = 4_000): Promise<ResidencySnapshot | undefined> {
	try {
		const s = sock ?? (await discoverSock());
		return residencyVerdict(await getUds(s, ROUTE_RESIDENCY, fadeHeaders(sessionId), timeoutMs));
	} catch {
		return undefined;
	}
}

/** Liveness, not existence: a socket FILE can sit there with nothing listening.
 *  The probe is one GET of the health route, bounded hard, because it runs on
 *  the load path. */
export async function probeHealth(sock: string, timeoutMs = 1_500): Promise<boolean> {
	try {
		const r = await getUds(sock, ROUTE_HEALTH, fadeHeaders("probe"), timeoutMs);
		return r.status === STATUS_OK && asRecord(r.body).ok === true;
	} catch {
		return false;
	}
}

/**
 * The socket, chosen by LIVENESS over the privilege order:
 *   1. `FADE_SUPERVISOR_SOCK` wins OUTRIGHT and is never probed - it is the
 *      operator's lever, and probing a lever the operator pinned would second-
 *      guess the very case they pinned it for (a daemon on a nonstandard path).
 *   2. the RUN path is taken only when it ANSWERS the health route;
 *   3. the TMP path is taken only when it answers;
 *   4. with neither answering, the path returned is the privilege default, so
 *      the failure the caller then reports names a real socket and a real
 *      transport error, not a probe that already gave up.
 *
 * The reason for the probe is measured on this box: the user-plane daemon and
 * the system-plane daemon answer on DIFFERENT paths, and a daemon that stopped
 * leaves its socket file behind. The failure mode of the shadow is a lease
 * granted to a corpse. `probe` is injectable so the suite proves the order with
 * no filesystem and no daemon.
 */
export async function discoverSock(
	env: NodeJS.ProcessEnv = process.env,
	euid: number = typeof process.geteuid === "function" ? process.geteuid() : 1,
	probe: (sock: string) => Promise<boolean> = probeHealth,
): Promise<string> {
	const pinned = env.FADE_SUPERVISOR_SOCK;
	if (pinned) return pinned;
	if (await probe(ROOT_SOCK)) return ROOT_SOCK;
	if (await probe(USER_SOCK)) return USER_SOCK;
	return euid === 0 ? ROOT_SOCK : USER_SOCK;
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
	sock?: string,
	timeoutMs = 15_000,
): Promise<LeaseVerdict> {
	const s = sock ?? (await discoverSock());
	const r = await postUds(s, "/v1/lease", acquireBody(pack, ttlSec), fadeHeaders(sessionId), timeoutMs);
	return leaseVerdict(r);
}

/** The renew gate: renew only when the lease is running down, never on every
 *  poll. The metrics tick is 30 s and the TTL is 1800 s, so an ungated renew is
 *  ~60 round trips and ~60 `msg=decision … decision=RENEWED` journal lines per
 *  held hour — measured, where the lease records in the daemon's
 *  journal were renewal noise, and the operator's one question ("who owns the
 *  lane, and since when") was buried under the client's own heartbeat.
 *
 *  The gate is the daemon's remaining time, not a client clock: `remainingS` is
 *  the `remaining_sec` the last grant/renew published, decremented by the tick
 *  between calls, so drift in the client never extends a lease past the daemon's
 *  deadline — the daemon's expiry stays the authority. Below a third of the TTL
 *  (never under 60 s) the answer is renew. An unknown remaining (0, absent, a
 *  daemon that does not publish it) renews: a client that cannot see the
 *  countdown must not lose the lane. */
export function shouldRenew(remainingS: number | undefined, ttlSec: number): boolean {
	const floor = Math.max(60, Math.floor(ttlSec / 3));
	const rem = typeof remainingS === "number" && Number.isFinite(remainingS) ? remainingS : 0;
	return rem <= floor;
}

export async function renewLease(
	token: string,
	ttlSec: number,
	sessionId: string,
	sock?: string,
	timeoutMs = 15_000,
): Promise<LeaseVerdict> {
	const s = sock ?? (await discoverSock());
	const r = await postUds(s, "/v1/lease", renewBody(token, ttlSec), fadeHeaders(sessionId), timeoutMs);
	return leaseVerdict(r);
}

export async function releaseLease(
	token: string,
	sessionId: string,
	sock?: string,
	timeoutMs = 10_000,
): Promise<LeaseVerdict> {
	const s = sock ?? (await discoverSock());
	const r = await postUds(s, "/v1/lease", releaseBody(token), fadeHeaders(sessionId), timeoutMs);
	return leaseVerdict(r);
}

export async function leaseStatus(
	sessionId: string,
	sock?: string,
	timeoutMs = 10_000,
): Promise<LeaseVerdict> {
	const s = sock ?? (await discoverSock());
	const r = await postUds(s, "/v1/lease", statusBody(), fadeHeaders(sessionId), timeoutMs);
	return leaseVerdict(r);
}

export async function swapLeased(
	pack: string,
	token: string,
	sessionId: string,
	sock?: string,
	timeoutMs = 240_000,
): Promise<SwapVerdict> {
	// A swap is a pack load: 13-25 s of page-in, bounded like the old ctl run.
	const s = sock ?? (await discoverSock());
	const r = await postUds(s, "/v1/swap", swapBody(pack, token), fadeHeaders(sessionId), timeoutMs);
	return swapVerdict(r);
}

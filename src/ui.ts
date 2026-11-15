/**
 * The compact pill and the Ctrl+O overlay.
 *
 * Main pane: ONE status line in the footer block, carrying the FULL lane name —
 * `⚡ <lane>:<state> · R<round>/<max> · T<passed>/<total> · [Ctrl+O]` — and NOTHING multi-line
 * above the editor while a run is live (the monolith painted a 6+ line task dump there; during
 * long coding runs that dump ate the transcript).
 *
 * Footer placement (operator order 2026-11-15: "put this text up where DeepSeek-v4.1 … is, it
 * should fit fine"): the built-in footer renders `pwd`, then the stats row whose RIGHT side is
 * the model identifier, then ONE line of extension statuses (`footer.js`: `getExtensionStatuses()`
 * joined and truncated to the terminal width). `ctx.ui.setStatus` writes that extension line — it
 * is the footer row the extension owns, immediately under the model identifier, and it is full
 * terminal width, so the FULL lane name goes there and the 2-character tag survives only as the
 * narrow-terminal fallback (`pillCompact`).
 *
 * Overlay: `ctx.ui.custom(..., {overlay:true})` with keyboard focus. Keys: s skip, v verify,
 * r reset, h halt, c code, esc/q close. Outside interactive mode (RPC/print, `ctx.hasUI` false)
 * the SAME lines go to a widget, which is what the headless rig asserts.
 */
import { hostname, userInfo } from "node:os";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RunState } from "./core.ts";
import type { SwapRow } from "./history.ts";

export interface TierRow {
	label: string;
	value: string;
}

export interface OverlayData {
	run: RunState;
	swaps: SwapRow[];
	tiers: TierRow[];
	/** The previous round's verifier critique (notes + failing checks), verbatim. */
	critique?: string;
}

export const OVERLAY_WIDGET_KEY = "fade-overlay";

/**
 * `FADE_ORCHESTRATE_REDACT=1` makes the bar safe to screenshot: no username, no home path, no
 * hostname, no repo path. Read at call time, so the operator can flip it per run and the headless
 * rig can assert both branches. Display-only: `state.json`, `metrics.jsonl` and
 * `swap_history.json` are written by other modules, and the on-disk record stays verbatim.
 */
export function redactOn(): boolean {
	return process.env.FADE_ORCHESTRATE_REDACT === "1";
}

/** `/home/<someone>` and a leading `~`: the home forms that survive a username miss. */
const HOME_PATH = /\/home\/[^\s/]+/g;
const HOME_TILDE = /~(?=\/|$)/g;

/** The OS account: `$USER` first, the passwd entry as the fallback. Empty when neither answers. */
function account(): string {
	const env = process.env.USER;
	if (env && env.length > 1) return env;
	try {
		const u = userInfo().username;
		return u && u.length > 1 ? u : "";
	} catch {
		return ""; // No passwd entry (a squashed container image); the env var is all there is.
	}
}

function machine(): string {
	try {
		return hostname().length > 1 ? hostname() : "";
	} catch {
		return "";
	}
}

/**
 * Replace the identity carried by a display string with fixed markers: the run's repo path and the
 * `/home/<user>` / `~/` prefixes become `<path>`, the hostname becomes `<host>`, the OS account
 * becomes `<user>`. Every other byte is untouched, and `on === false` returns the input unchanged.
 *
 * The literals go longest-first: the repo path sits under the home directory, so masking the home
 * prefix first would leave `/projects/<repo>` — the repo name — on screen. Only the render
 * boundary (`pill`, `statusTag`, `overlayLines`, and the widget they feed) calls this, which is
 * what keeps the operator's durable record lossless.
 */
export function redact(text: string, on: boolean, repo?: string): string {
	if (!on) return text;
	let out = text;
	if (repo && repo.length > 1) out = out.split(repo).join("<path>");
	const host = machine();
	if (host) out = out.split(host).join("<host>");
	const user = account();
	if (user) out = out.split(user).join("<user>");
	// A path naming some OTHER account (an operator's `~`, a copied fixture) has to go too.
	return out.replace(HOME_PATH, "<path>").replace(HOME_TILDE, "<path>");
}

/** The single place the render boundary applies the switch. */
function shown(text: string, run: RunState): string {
	return redact(text, redactOn(), run.repo);
}

/**
 * The footer status line: lane, state, round, task tally, the overlay key, the protocol-stall
 * badge when the Tier-1 gate is counting, and the tok/s suffix last.
 */
export function pill(run: RunState, suffix?: string): string {
	return shown(renderPill(`${run.lane}:${SHORT_STATE[run.state] ?? run.state}`, run, suffix), run);
}

/** Narrow-terminal fallback: 2-character lane tag, short state (`⚡ de:code · R1/6 …`). */
export function pillCompact(run: RunState, suffix?: string): string {
	return shown(renderPill(`${laneTag(run.lane)}:${SHORT_STATE[run.state] ?? run.state}`, run, suffix), run);
}

function renderPill(tag: string, run: RunState, suffix?: string): string {
	const total = run.tasks.length;
	const passed = run.tasks.filter((t) => t.status === "passed").length;
	const stall = (run.stall_count ?? 0) > 0 ? ` · protocol ${run.stall_count}/3` : "";
	const paused = run.paused === true ? " · paused" : "";
	return `⚡ ${tag} · R${run.round}/${run.max_rounds} · T${passed}/${total} · [Ctrl+O]${stall}${paused}${suffix ? ` · ${suffix}` : ""}`;
}

/**
 * Short lane name, used only by `pillCompact`/`statusTagCompact`: "flash-next" -> "fn",
 * "deepseek" -> "de". The host truncates the status row at the terminal width, so on a narrow
 * terminal the full lane name would be cut with "…" and the tally with it; the tag keeps the line
 * readable there. `/orchestrate status` and the overlay print the FULL name, always.
 */
export function laneTag(lane: string): string {
	const m = /^(.*?)-(.*?)(?:-|$)/.exec(lane);
	if (m) return `${m[1]![0]}${m[2]![0]}`;
	return lane.length > 4 ? lane.slice(0, 2) : lane;
}

/** The state machine's name in ≤5 characters; a stall must stay visible (Tier-1 gate). */
const SHORT_STATE: Record<string, string> = {
	planning: "plan",
	coding: "code",
	verifying: "ver",
	repair: "fix",
	complete: "done",
	failed: "fail",
	stopped: "stop",
	stalled_protocol_error: "stall",
};

/**
 * The footer tag with the FULL lane name (`deepseek:code`) — the row has the room, and the model
 * identifier above it is longer. An unknown future state passes through untruncated rather than
 * being masked.
 */
export function statusTag(run: RunState): string {
	return shown(`${run.lane}:${SHORT_STATE[run.state] ?? run.state}`, run);
}

/** The narrow-terminal tag (`de:code`). */
export function statusTagCompact(run: RunState): string {
	return shown(`${laneTag(run.lane)}:${SHORT_STATE[run.state] ?? run.state}`, run);
}

/** The overlay body, untruncated: full objectives, acceptances, results, swap rows, tiers. Each line is redacted on the way out. */
export function overlayLines(d: OverlayData): string[] {
	const { run } = d;
	const out: string[] = [];
	out.push(`fade-orchestrator ${run.run_id} · ${run.state} · lane ${run.lane} · round ${run.round}/${run.max_rounds}${run.tier ? ` · tier ${run.tier}` : ""}`);
	out.push(`goal: ${run.goal}`);
	if (run.paused === true) out.push(`paused: the loop is stopped for manual edits${run.operator_note ? ` · operator note: ${run.operator_note}` : ""}`);
	if ((run.protocol_retries ?? 0) > 0) {
		out.push(`protocol: ${run.protocol_retries} turn(s) ended without fade_phase · consecutive stalls ${run.stall_count ?? 0}/3${run.synthesized ? ` · auto-synthesized ${run.synthesized.phase} at round ${run.synthesized.round}` : ""}`);
	}
	if (run.state === "stalled_protocol_error") {
		out.push(`PROTOCOL STALL (Tier-3 circuit breaker): the lane ended ${run.stall_count ?? 3} turns in a row without a fade_phase call, so the run is halted and NO lane was loaded.`);
		out.push("  acts: [c] resume on the code lane · [r] reset the round · [p] pause for a manual edit · /orchestrate status reads state.json");
	}
	out.push("");
	out.push("tasks (untruncated):");
	const pool = run.repair_tasks.length > 0 ? run.repair_tasks : run.tasks;
	for (const t of run.tasks) {
		const inRepair = pool.some((r) => r.id === t.id);
		out.push(`  ${t.id} [${t.status ?? "pending"}]${inRepair ? " (in repair)" : ""}  ${t.objective}`);
		out.push(`      files: ${t.files.join(", ")} · deps: ${t.dependencies.length ? t.dependencies.join(",") : "-"} · round ${t.round}`);
		out.push(`      acceptance: ${t.acceptance}`);
		if (t.result) out.push(`      result: ${t.result}`);
		if (run.checkpoints?.[t.id]) out.push(`      tag: ${run.checkpoints[t.id]}`);
	}
	out.push("");
	out.push("basalt swap latency (newest first):");
	if (d.swaps.length === 0) out.push("  (no swaps recorded yet)");
	for (const s of d.swaps) {
		const moe = s.moe ? (s.moe.state === "unsupported" ? " · MoE relearned" : s.moe.profile_exists ? " · MoE warm start" : " · MoE cold start") : "";
		const ramp = s.ramp === "map_restored" ? " · MoE Map: Restored" : s.ramp === "hot_steady" ? ` · MoE: Hot Steady State (${Math.round(s.steady_tg)} tok/s)` : s.ramp === "cold_ramp" ? " · MoE: Cold Ramp" : "";
		out.push(`  ${s.from} -> ${s.to}  ${s.elapsed_s.toFixed(1)} s · first tg ${Math.round(s.first_tg)} -> steady ${Math.round(s.steady_tg)}${ramp}${moe} · ${s.at}`);
	}
	out.push("");
	out.push("memory / engine tiers:");
	for (const t of d.tiers) out.push(`  ${t.label}: ${t.value}`);
	out.push("");
	out.push("last verifier critique:");
	out.push(...(d.critique ? d.critique.split("\n").map((l) => `  ${l}`) : ["  (none this round)"]));
	const rej = (run.rejection_history ?? []).slice(-5);
	if (rej.length > 0) {
		out.push("");
		out.push("recent rejections (do not repeat):");
		for (const r of rej) out.push(`  round ${r.round} [${r.kind}]${r.task_id ? ` ${r.task_id}:` : ""} ${r.reason}`);
	}
	out.push("");
	out.push("[s] skip task  [v] verify now  [r] reset round  [p] pause/resume  [c] code  [h] halt  [esc] close");
	return out.map((l) => shown(l, run));
}

/**
 * Open the overlay. `onAction` receives the key pressed (s/v/r/p/c/h) so the caller applies the
 * keymap directive. In non-UI modes the lines go to a widget (visible in RPC frames) and no
 * action is awaited.
 */
export async function openOverlay(ctx: ExtensionContext, data: OverlayData, onAction?: (key: string) => void, widgetOnly = false): Promise<void> {
	if (widgetOnly || ctx.hasUI !== true) {
		ctx.ui.setWidget(OVERLAY_WIDGET_KEY, overlayLines(data));
		return;
	}
	try {
		const action = await ctx.ui.custom<string>((_tui, theme, _kb, done) => new OverlayComponent(data, theme, done), {
			overlay: true,
			overlayOptions: { width: "80%", maxHeight: "80%" },
		});
		if (action && onAction) onAction(action);
	} catch {
		// No overlay backend (older host): the same content as a widget, then closed keys.
		ctx.ui.setWidget(OVERLAY_WIDGET_KEY, overlayLines(data));
	}
}

/** Minimal pi-tui Component: plain lines (no theme math), one-key actions, esc closes. */
class OverlayComponent {
	private body: string[];
	private done: (result: string) => void;
	private themeFiller: unknown;

	constructor(data: OverlayData, theme: unknown, done: (result: string) => void) {
		this.body = overlayLines(data);
		this.themeFiller = theme;
		this.done = done;
	}
	invalidate(): void {
		// Plain string lines: nothing cached to drop. The host calls this before re-render.
	}

	render(width: number): string[] {
		void this.themeFiller;
		return this.body.map((l) => (l.length > width ? l.slice(0, width - 1) + "…" : l));
	}

	handleInput(data: string): void {
		if (data === "\x1b" || data === "q") return this.done("close");
		if (data === "s" || data === "v" || data === "r" || data === "p" || data === "c" || data === "h") return this.done(data);
	}
}

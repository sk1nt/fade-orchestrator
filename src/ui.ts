/**
 * The compact pill and the Ctrl+O overlay.
 *
 * Main pane: ONE status line — `⚡ <lane>:<state> · R<round>/<max> · T<passed>/<total> · [Ctrl+O]`
 * (2-char lane tag + short state tag: the footer is a shared row) — and NOTHING multi-line above
 * the editor while a run is live (the monolith painted a 6+ line task dump there; during long
 * coding runs that dump ate the transcript).
 *
 * Overlay: `ctx.ui.custom(..., {overlay:true})` with keyboard focus. Keys: s skip, v verify,
 * r reset, h halt, c code, esc/q close. Outside interactive mode (RPC/print, `ctx.hasUI` false)
 * the SAME lines go to a widget, which is what the headless rig asserts.
 */
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

/** One line, built for the footer: lane, round, task tally, the key that opens the overlay. */
export function pill(run: RunState, suffix?: string): string {
	const total = run.tasks.length;
	const passed = run.tasks.filter((t) => t.status === "passed").length;
	const st = statusTag(run);
	return `⚡ ${st} · R${run.round}/${run.max_rounds} · T${passed}/${total} · [Ctrl+O]${suffix ? ` · ${suffix}` : ""}`;
}

/**
 * Short lane name for the footer: "flash-next" -> "fn", "flash-ornith" -> "fo", "deepseek" -> "de".
 * The pill is one line in a shared terminal row, so a 10-character model name plus round, tally,
 * the key hint and the tok/s suffix overflowed it; 2 characters keep the whole line readable and
 * still unambiguous (`/orchestrate status` and the overlay print the FULL name, always).
 */
export function laneTag(lane: string): string {
	const m = /^(.*?)-(.*?)(?:-|$)/.exec(lane);
	if (m) return `${m[1]![0]}${m[2]![0]}`;
	return lane.length > 4 ? lane.slice(0, 2) : lane;
}

/**
 * Short state tag: the state machine's name, never the phase prose. A stalled protocol error is
 * the one state the pill must not hide (Tier-1 failure gate), so it stays readable as `stall`.
 */
export function statusTag(run: RunState): string {
	const short: Record<string, string> = {
		planning: "plan",
		coding: "code",
		verifying: "ver",
		repair: "fix",
		complete: "done",
		failed: "fail",
		stopped: "stop",
		stalled_protocol_error: "stall",
	};
	return `${laneTag(run.lane)}:${short[run.state] ?? run.state}`;
}

/** The overlay body, untruncated: full objectives, acceptances, results, swap rows, tiers. */
export function overlayLines(d: OverlayData): string[] {
	const { run } = d;
	const out: string[] = [];
	out.push(`fade-orchestrator ${run.run_id} · ${run.state} · lane ${run.lane} · round ${run.round}/${run.max_rounds}${run.tier ? ` · tier ${run.tier}` : ""}`);
	out.push(`goal: ${run.goal}`);
	out.push("");
	out.push("tasks (untruncated):");
	const pool = run.repair_tasks.length > 0 ? run.repair_tasks : run.tasks;
	for (const t of run.tasks) {
		const inRepair = pool.some((r) => r.id === t.id);
		out.push(`  ${t.id} [${t.status ?? "pending"}]${inRepair ? " (in repair)" : ""}  ${t.objective}`);
		out.push(`      files: ${t.files.join(", ")} · deps: ${t.dependencies.length ? t.dependencies.join(",") : "-"} · round ${t.round}`);
		out.push(`      acceptance: ${t.acceptance}`);
		if (t.result) out.push(`      result: ${t.result}`);
	}
	out.push("");
	out.push("basalt swap latency (newest first):");
	if (d.swaps.length === 0) out.push("  (no swaps recorded yet)");
	for (const s of d.swaps) {
		const moe = s.moe ? (s.moe.state === "unsupported" ? " · MoE relearned" : s.moe.profile_exists ? " · MoE warm start" : " · MoE cold start") : "";
		out.push(`  ${s.from} -> ${s.to}  ${s.elapsed_s.toFixed(1)} s · first tg ${Math.round(s.first_tg)} -> steady ${Math.round(s.steady_tg)}${moe} · ${s.at}`);
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
	out.push("[s] skip task  [v] verify now  [r] reset round  [c] code  [h] halt  [esc] close");
	return out;
}

/**
 * Open the overlay. `onAction` receives the key pressed (s/v/r/c/h) so the caller applies the
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
		if (data === "s" || data === "v" || data === "r" || data === "c" || data === "h") return this.done(data);
	}
}

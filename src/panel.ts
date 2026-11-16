/**
 * The Alt+F screen: the orchestration's whole state on one live panel, in the shape the host's
 * own agents panel uses — a header, a selectable list, a metrics column, a key bar.
 *
 * The chord is `alt+f`, claimed at the RAW-INPUT layer: the host's own table binds `alt+f`
 * (`tui.editor.cursorWordRight`), so `registerShortcut` is refused and `onTerminalInput` consumes
 * the two bytes (`ESC f`) ahead of the host's binding — proved against the real binary by
 * `test/pty_rig.mjs`. `/orchestrate overlay` and `FADE_ORCHESTRATE_FALLBACK_KEY` (default
 * `alt+shift+i`) stay the fallbacks, and a configured CONTROL chord (`ctrl+o`) stays the host's:
 * the raw listener's family is ESC + a byte, never a control code.
 *
 * Closing is a parse, not a byte: the accepted ESC encodings are listed on `isEscape` below.
 *
 * Live by construction: the panel is given a `provider` and a bounded refresh tick, re-reads the
 * screen and calls `tui.requestRender()` — the numbers move while you watch, which is the whole
 * point of opening it during a round. `dispose()` clears the tick: an overlay closed with `esc`
 * must not keep polling the router.
 *
 * Width is a contract, not a hope: `render(width)` returns lines whose VISIBLE width never exceeds
 * `width` (colors are ANSI, so the fit function strips them), and the panel scrolls to keep the
 * selected task in view at any terminal size between 60 and 220 columns.
 *
 * Every rendered line passes `redact` (ui.ts), so a screenshot of the screen is safe.
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { OVERLAY_WIDGET_KEY, redact, redactOn, shortState } from "./ui.ts";
import { compactNumber, formatElapsed, gateRows, swapRows, swapSummaryRow, turnRows, clockOf, type MetricRow, type ScreenData } from "./screendata.ts";

/** The panel's refresh tick. The router's /metrics is a local request; 2 s keeps it honest and cheap. */
export const PANEL_REFRESH_MS = Math.max(500, Number(process.env.FADE_ORCHESTRATE_PANEL_REFRESH_MS ?? 2000));
/** The widget width used in headless mode (RPC/print), where the same lines are the assertion target. */
export const WIDGET_WIDTH = 110;

/** The narrowest terminal the two-column layout renders on; below it the metrics stack under the list. */
export const TWO_COLUMN_MIN_WIDTH = 100;

/** A minimal view of the host's Theme, so the renderer has no import of the host's theme module. */
export interface PanelTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface PanelView {
	/** Selected task index, clamped by the renderer. */
	sel: number;
}

export interface PanelRender {
	lines: string[];
	/** Line index of each task's header row, for the auto-scroll. */
	taskRows: number[];
}

const STATUS_GLYPH: Record<string, string> = {
	passed: "✓",
	failed: "✗",
	blocked: "⊘",
	pending: "·",
	started: "…",
};

const TONE: Record<string, string> = { ok: "success", warn: "warning", bad: "error", dim: "dim" };

/** Visible width: ANSI escapes and the cursor marker cost nothing on screen. */
export function visibleWidth(s: string): number {
	return [...s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\]8;;[^\x07\x1b]*(\x07|\x1b\\)/g, "")].length;
}

/** Truncate to a visible width, with an ellipsis when the text was cut. */
export function fit(s: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(s) <= width) return s;
	const plain = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
	return `${[...plain].slice(0, Math.max(0, width - 1)).join("")}…`;
}

/** Pad to a visible width (the columns are joined on the same row). */
function pad(s: string, width: number): string {
	const w = visibleWidth(s);
	return w >= width ? s : `${s}${" ".repeat(width - w)}`;
}

/** The keys the panel owns, in the order the operator reads them. */
export const KEY_BAR = ["[↑↓/j-k] select", "[PgUp/PgDn] scroll", "[s] skip selected", "[v] verify", "[r] reset", "[p] pause", "[c] code", "[h] halt", "[esc] close"];

/**
 * The key bar, packed per line. Each item stays whole: prose-wrapping cuts a key mid-token and a
 * single long line loses the tail of the bar, so an item wider than the panel is clipped, never
 * split.
 */
export function keyBarLines(width: number): string[] {
	if (width <= 1) return [""];
	const lines: string[] = [];
	let line = "";
	for (const item of KEY_BAR) {
		const candidate = line.length === 0 ? item : `${line}  ${item}`;
		if (visibleWidth(candidate) > width) {
			if (line.length > 0) lines.push(line);
			line = visibleWidth(item) > width ? fit(item, width) : item;
		} else {
			line = candidate;
		}
	}
	if (line.length > 0) lines.push(line);
	return lines.length > 0 ? lines : [""];
}

function label(theme: PanelTheme | undefined, text: string, color = "accent"): string {
	return theme ? theme.fg(color, theme.bold ? theme.bold(text) : text) : text;
}

/**
 * One `label  value` row per metric, the label column padded so the values line up.
 *
 * `maxLabel` is per block, not global: the metric rows carry ≤12-character labels, while a swap
 * row's label is a lane PAIR ("deepseek → flash-next", 21 columns). A cap sized for metric labels
 * clips that pair and loses the lane the swap went TO.
 */
function metricLines(rows: MetricRow[], theme: PanelTheme | undefined, width: number, maxLabel = 18): string[] {
	const labelW = Math.min(maxLabel, Math.max(6, Math.max(...rows.map((r) => visibleWidth(r.label)), 1) + 1));
	return rows.map((r) => {
		const value = fit(r.value, Math.max(4, width - labelW));
		const l = theme && r.tone ? theme.fg(TONE[r.tone] ?? "text", r.label) : r.label;
		return `  ${pad(fit(l, labelW - 1), labelW)} ${value}`;
	});
}

/**
 * A run state arrives from disk, and a JSON file can be MISSING an array the type declares: a
 * state written mid-plan has no `phases`, a hand-seeded state can have no `repair_tasks`, a
 * planning run has no `tasks`. `RunState` types them required, so TypeScript cannot see the gap,
 * and `run.phases.length` / `run.repair_tasks.length` each throw `undefined is not an object` on
 * such a state — the panel arrives as an error notify. The screen reads an absent array as empty:
 * a screen must never die on a shape it did not predict.
 */
const arr = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);

/** The task rows: a selectable line per task, plus the detail lines of the SELECTED one. */
function taskBlock(d: ScreenData, view: PanelView, theme: PanelTheme | undefined, width: number): { lines: string[]; taskRows: number[] } {
	const run = d.run;
	// The repair queue is a QUEUE, so it is only named when it has entries. A pool of
	// `repair_tasks.length ? repair_tasks : tasks` makes EVERY row read "(repair)" on a normal
	// round — a label that says the round is in repair when it is not.
	const tasks = arr(run.tasks);
	const repair = arr(run.repair_tasks);
	const repairing = repair.length > 0;
	const lines: string[] = [];
	const taskRows: number[] = [];
	const total = tasks.length;
	const passed = tasks.filter((t) => t.status === "passed").length;
	lines.push(label(theme, `TASKS ${passed}/${total} passed${repairing ? " · repair queue active" : ""}`));
	tasks.forEach((t, i) => {
		const sel = i === view.sel;
		const glyph = STATUS_GLYPH[t.status ?? "pending"] ?? "·";
		const inRepair = repairing && repair.some((r) => r.id === t.id);
		const head = `${sel ? "▶" : " "} ${glyph} ${t.id}${inRepair ? " (repair)" : ""}`;
		const tone = t.status === "passed" ? "success" : t.status === "failed" || t.status === "blocked" ? "error" : inRepair ? "warning" : "text";
		const row = `${pad(fit(head, 18), 18)} ${fit(t.objective, Math.max(4, width - 19))}`;
		taskRows[i] = lines.length;
		lines.push(theme ? theme.fg(tone, row) : row);
		if (!sel) return;
		const meta = `files: ${(t.files ?? []).join(", ") || "-"} · deps: ${(t.dependencies ?? []).length ? (t.dependencies ?? []).join(",") : "-"} · round ${t.round ?? 1}`;
		lines.push(`    ${fit(meta, Math.max(4, width - 4))}`);
		lines.push(`    acceptance: ${fit(t.acceptance, Math.max(4, width - 16))}`);
		if (t.result) lines.push(`    result: ${fit(t.result, Math.max(4, width - 11))}`);
		const tag = run.checkpoints?.[t.id];
		if (tag) lines.push(`    tag: ${tag}`);
	});
	if (tasks.length === 0) lines.push("  (no plan yet: the loop is still planning)");
	return { lines, taskRows };
}

/** The phase rail: the newest phases, with the lane that produced each. */
function phaseBlock(d: ScreenData, theme: PanelTheme | undefined, width: number): string[] {
	const phases = arr(d.run.phases).slice(-6);
	const lines = [label(theme, "PHASES")];
	if (phases.length === 0) return [...lines, "  (none accepted yet)"];
	for (const p of phases) {
		const row = `  R${p.round} ${p.phase}${p.accepted ? "" : " REFUSED"}  ${p.lane}  ${clockOf(p.at)}`;
		lines.push(fit(row, width));
	}
	return lines;
}

/** The metrics column: what the loop is paying, measured by the engine itself. */
function metricBlock(d: ScreenData, theme: PanelTheme | undefined, width: number): string[] {
	const rows: MetricRow[] = [...d.tiers, ...d.moe, ...(d.classes ?? [])];
	if (d.context) rows.push({ label: "context", value: `${compactNumber(d.context.tokens)} / ${compactNumber(d.context.window)} (${d.context.percent.toFixed(1)}%)` });
	rows.push(...gateRows(d.gate));
	rows.push(...turnRows(d.turns));
	return [label(theme, "ENGINE / ROUTER"), ...metricLines(rows, theme, width)];
}

/** The swap table: every pack swap the loop drove, with the cost it measured. */
function swapBlock(d: ScreenData, theme: PanelTheme | undefined, width: number): string[] {
	const rows = swapRows(d.swaps);
	const lines = [label(theme, "LANE SWAPS")];
	// The run's own cost, FIRST: the table below is the plane's last swaps, which answers a
	// different question. Its label is metric-length, so it takes the metric cap (18), while the
	// lane pairs below keep the 22-column cap that a lane pair needs.
	const summary = metricLines([swapSummaryRow(d.swaps, d.run.run_id)], theme, width);
	if (rows.length === 0) return [...lines, ...summary, "  (no swaps recorded yet)"];
	return [...lines, ...summary, ...metricLines(rows, theme, width, 22)];
}

function tailBlocks(d: ScreenData, theme: PanelTheme | undefined, width: number): string[] {
	const lines: string[] = [];
	lines.push(label(theme, "LAST VERIFIER CRITIQUE"));
	lines.push(...(d.critique ? d.critique.split("\n").map((l) => `  ${fit(l, Math.max(4, width - 2))}`) : ["  (none this round)"]));
	const rej = (d.run.rejection_history ?? []).slice(-5);
	if (rej.length > 0) {
		lines.push(label(theme, "RECENT REJECTIONS (do not repeat)", "warning"));
		for (const r of rej) lines.push(fit(`  R${r.round} [${r.kind}]${r.task_id ? ` ${r.task_id}:` : ""} ${r.reason}`, width));
	}
	if (d.flip && d.flip.flips > 0) {
		lines.push(label(theme, "LANE FLIP (not the loop's)", "warning"));
		lines.push(fit(`  ${d.flip.flips} swaps in ${d.flip.window_s}s — requests naming ${d.flip.competing.join(", ") || "the other lane"}`, width));
	}
	if (d.missing.length > 0) {
		lines.push(label(theme, "NOT MEASURED", "dim"));
		for (const m of d.missing) lines.push(fit(`  ${m}`, width));
	}
	return lines;
}

function headerBlock(d: ScreenData, theme: PanelTheme | undefined, width: number): string[] {
	const run = d.run;
	const resident = d.lanes.find((l) => l.resident);
	const head = `fade-orchestrator ${run.run_id} · ${shortState(run.state)} · round ${run.round}/${run.max_rounds}${run.tier ? ` · tier ${run.tier}` : ""}${d.elapsed_s !== undefined ? ` · ${formatElapsed(d.elapsed_s)}` : ""} · ${d.refreshed_utc.slice(11, 19)}Z`;
	const lines = [label(theme, fit(head, width))];
	lines.push(fit(`goal: ${run.goal}`, width));
	if (run.paused === true) {
		lines.push(theme ? theme.fg("warning", fit(`paused: the loop is stopped for manual edits${run.operator_note ? ` · note: ${run.operator_note}` : ""}`, width)) : fit(`paused: the loop is stopped for manual edits${run.operator_note ? ` · note: ${run.operator_note}` : ""}`, width));
	}
	if (run.state === "stalled_protocol_error") {
		lines.push(theme ? theme.fg("error", fit(`PROTOCOL STALL: the lane ended ${run.stall_count ?? 3} turns in a row without a fade_phase call; the run is halted and NO lane was loaded — [c] resume on the code lane, [r] reset the round`, width)) : fit(`PROTOCOL STALL: the lane ended ${run.stall_count ?? 3} turns in a row without a fade_phase call; the run is halted and NO lane was loaded — [c] resume on the code lane, [r] reset the round`, width));
	}
	const laneRow = d.lanes.map((l) => `${l.model}=${l.role}${l.resident ? " ◆resident" : ""}`).join(" · ");
	lines.push(fit(`lanes: ${laneRow}`, width));
	if ((run.protocol_retries ?? 0) > 0) {
		lines.push(fit(`protocol: ${run.protocol_retries} turn(s) ended without fade_phase · consecutive stalls ${run.stall_count ?? 0}/3${run.synthesized ? ` · auto-synthesized ${run.synthesized.phase} at round ${run.synthesized.round}` : ""}`, width));
	}
	return lines;
}

/**
 * The whole screen at one width, unscrolled. The two-column split puts the task list and the phase
 * rail on the left and the engine's numbers on the right; under `TWO_COLUMN_MIN_WIDTH` the metrics
 * stack below, because a 40-column metrics column is unreadable.
 */
export function panelLines(d: ScreenData, width: number, view: PanelView = { sel: 0 }, theme?: PanelTheme): PanelRender {
	const w = Math.max(40, Math.floor(width));
	const inner = w - 4;
	const header = headerBlock(d, theme, inner);
	const tasks = taskBlock(d, { sel: Math.max(0, Math.min(view.sel, Math.max(0, arr(d.run.tasks).length - 1))) }, theme, inner);
	const phases = phaseBlock(d, theme, inner);
	const metrics = metricBlock(d, theme, inner);
	const swaps = swapBlock(d, theme, inner);
	const tail = tailBlocks(d, theme, inner);

	const left = [...tasks.lines, "", ...phases];
	const lines: string[] = [];
	// Every content row is PADDED to the inner width: an unpadded row leaves the right border
	// ragged — the header's `│` sits right behind the text while the rows below reach the full
	// width — which reads as a broken box in a real terminal.
	const row = (text: string) => `│ ${pad(fit(text, inner), inner)} │`;
	lines.push(`┌${"─".repeat(w - 2)}┐`);
	for (const h of header) lines.push(row(h));
	lines.push(`├${"─".repeat(w - 2)}┤`);

	const taskRowOffset = lines.length;
	if (w >= TWO_COLUMN_MIN_WIDTH) {
		const leftW = Math.max(40, Math.floor((w - 4) * 0.56));
		const rightW = w - 4 - leftW - 2;
		const right = metrics;
		const rows = Math.max(left.length, right.length);
		for (let i = 0; i < rows; i++) {
			const l = pad(fit(left[i] ?? "", leftW), leftW);
			const r = fit(right[i] ?? "", rightW);
			lines.push(`│ ${l}  ${r}${" ".repeat(Math.max(0, rightW - visibleWidth(r)))} │`);
		}
	} else {
		for (const l of left) lines.push(row(l));
		lines.push(row(""));
		for (const m of metrics) lines.push(row(m));
	}

	lines.push(`├${"─".repeat(w - 2)}┤`);
	for (const s of swaps) lines.push(row(s));
	for (const t of tail) lines.push(row(t));
	lines.push(`├${"─".repeat(w - 2)}┤`);
	for (const k of keyBarLines(inner)) lines.push(row(k));
	lines.push(`└${"─".repeat(w - 2)}┘`);

	const taskRows = tasks.taskRows.map((i) => taskRowOffset + i);
	const out = lines.map((l) => redact(l, redactOn(), d.run.repo));
	return { lines: out, taskRows };
}

export type PanelAction = { key: string; taskId?: string };

/**
 * ESC, in EVERY encoding the host's own parser recognizes — the single place the ESC-encoding
 * list lives. The focused component gets RAW bytes, and the host's escape matcher accepts three
 * forms: the legacy byte, the Kitty keyboard-protocol CSI-u sequence (`\x1b[27u`, `\x1b[27;<mod>u`),
 * and xterm's modifyOtherKeys (`\x1b[27;<mod>;27~`). Comparing only "\x1b" is dead on any terminal
 * that enables the Kitty protocol (kitty, wezterm, ghostty, foot), where the ESC key sends the
 * CSI-u form; a legacy-byte terminal (tmux's `screen`) hides that miss from a pty rig. The Kitty
 * RELEASE form (`...:3u`) is excluded so one press is exactly one close, matching the host, which
 * filters releases unless a component asks for them.
 */
const KITTY_CSI_U = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;
const MODIFY_OTHER_KEYS = /^\x1b\[27;(\d+);(\d+)~$/;

export function isEscape(data: string): boolean {
	if (data === "\x1b") return true;
	const kitty = KITTY_CSI_U.exec(data);
	if (kitty) {
		// groups: 1 codepoint, 2 shifted, 3 base-layout, 4 modifier (1 = none), 5 event (1 press, 2 repeat, 3 release)
		return Number(kitty[1]) === 27 && (kitty[4] === undefined ? 1 : Number(kitty[4])) === 1 && (kitty[5] === undefined ? 1 : Number(kitty[5])) !== 3;
	}
	const mok = MODIFY_OTHER_KEYS.exec(data);
	if (mok) return Number(mok[2]) === 27 && Number(mok[1]) === 1;
	return false;
}

/** Keys the panel owns: the loop controls and the plain-byte closes; ESC is `isEscape`, not a byte. */
const CLOSE_KEYS: Record<string, true> = { q: true, "\x03": true };
const ACTION_KEYS: Record<string, true> = { s: true, v: true, r: true, p: true, c: true, h: true };

/** Minimal view of the host's TUI: the panel needs the height and the render kick, nothing else. */
export interface PanelTui {
	terminal: { rows: number; columns: number };
	requestRender(force?: boolean): void;
}

/**
 * The live panel component. `provider` is re-read on the refresh tick; the selection and the scroll
 * offset are the operator's, and every refresh keeps them.
 */
export class PanelComponent {
	private data: ScreenData;
	private readonly provider: () => Promise<ScreenData>;
	private readonly theme: PanelTheme | undefined;
	private readonly tui: PanelTui;
	private readonly done: (result: string) => void;
	private sel = 0;
	private offset = 0;
	private timer: NodeJS.Timeout | undefined;
	private rendering = false;
	private body: string[] = [];
	private taskRows: number[] = [];
	/** The next render must bring the SELECTED task on screen (j/k and a refresh set it; g/G/PgUp/PgDn clear it). */
	private follow = true;

	constructor(data: ScreenData, provider: () => Promise<ScreenData>, theme: PanelTheme | undefined, tui: PanelTui, done: (result: string) => void, refreshMs = PANEL_REFRESH_MS) {
		this.data = data;
		this.provider = provider;
		this.theme = theme;
		this.tui = tui;
		this.done = done;
		// unref: the poll must never hold the process open. An open overlay's timer keeps the host
		// (and `node --test`, which is how the panel is proved) alive after every test finishes.
		this.timer = setInterval(() => void this.refresh(), refreshMs);
		this.timer.unref?.();
	}

	/** The provider is the router read; never let a slow tick overlap the next one. */
	private async refresh(): Promise<void> {
		if (this.rendering) return;
		this.rendering = true;
		try {
			const next = await this.provider();
			if (next.run.run_id === this.data.run.run_id) this.data = next;
			this.follow = true;
			this.tui.requestRender();
		} catch {
			/* a provider failure keeps the last screen on display; the next tick retries */
		} finally {
			this.rendering = false;
		}
	}

	invalidate(): void {
		this.body = [];
	}

	getHeight(): number {
		return Math.max(8, (this.tui.terminal.rows || 24) - 2);
	}

	render(width: number): string[] {
		const r = panelLines(this.data, width, { sel: this.sel }, this.theme);
		this.body = r.lines;
		this.taskRows = r.taskRows;
		const h = this.getHeight();
		// The scroll follows the SELECTION, and only the selection: j/k and a refresh ask the view
		// to bring the selected task on screen, while g/G/PgUp/PgDn are the operator moving the
		// view themselves. Scrolling to the selection on every frame makes `g` (jump to top)
		// unreachable — the render snaps back to the selected row.
		const row = this.taskRows[this.sel];
		if (this.follow && row !== undefined) {
			if (row < this.offset) this.offset = row;
			else if (row >= this.offset + h) this.offset = row - h + 1;
		}
		this.follow = false;
		const maxOffset = Math.max(0, this.body.length - h);
		if (this.offset > maxOffset) this.offset = maxOffset;
		return this.body.slice(this.offset, this.offset + h);
	}

	handleInput(data: string): void {
		const all = arr(this.data.run.tasks);
		const tasks = all.length;
		const h = this.getHeight();
		if (isEscape(data) || CLOSE_KEYS[data] === true) return this.done(JSON.stringify({ key: "close" } satisfies PanelAction));
		if (ACTION_KEYS[data] === true) {
			const t = all[this.sel];
			return this.done(JSON.stringify({ key: data, ...(t ? { taskId: t.id } : {}) } satisfies PanelAction));
		}
		if (data === "j" || data === "\x1b[B") {
			this.sel = Math.min(Math.max(0, tasks - 1), this.sel + 1);
			this.follow = true;
			return;
		}
		if (data === "k" || data === "\x1b[A") {
			this.sel = Math.max(0, this.sel - 1);
			this.follow = true;
			return;
		}
		if (data === "\x1b[6~") this.offset = Math.min(Math.max(0, this.body.length - h), this.offset + h);
		else if (data === "\x1b[5~") this.offset = Math.max(0, this.offset - h);
		else if (data === "G") this.offset = Math.max(0, this.body.length - h);
		else if (data === "g") this.offset = 0;
	}

	dispose(): void {
		if (this.timer !== undefined) clearInterval(this.timer);
		this.timer = undefined;
	}
}

/**
 * Open the screen. In interactive mode it is a near-full-screen overlay with keyboard focus, in
 * the host's agents-panel shape; in RPC/print mode the SAME lines go to the widget, which is what
 * the headless rigs assert. The component is built from the host's TUI and Theme:
 * `PanelTui`/`PanelTheme` are the two members the panel actually uses, so the tests drive it
 * without a terminal.
 */
export async function openPanel(ctx: ExtensionContext, provider: () => Promise<ScreenData>, onAction?: (a: PanelAction) => void, headless = process.env.FADE_ORCHESTRATE_HEADLESS === "1"): Promise<void> {
	const initial = await provider();
	if (ctx.hasUI !== true || headless) {
		ctx.ui.setWidget(OVERLAY_WIDGET_KEY, panelLines(initial, WIDGET_WIDTH, { sel: 0 }).lines, { placement: "aboveEditor" });
		return;
	}
	const raw = await ctx.ui.custom<string>(
		(tui, theme, _kb, done) => new PanelComponent(initial, provider, theme, tui, done),
		{
			overlay: true,
			// Near-full-screen, like the host's own panels; a function so a resize re-resolves.
			overlayOptions: () => ({ width: "96%", maxHeight: "94%", anchor: "top-center", margin: { top: 1, left: 1, right: 1, bottom: 1 } }),
		},
	);
	if (!raw) return;
	let action: PanelAction | undefined;
	try {
		action = JSON.parse(raw) as PanelAction;
	} catch {
		action = undefined;
	}
	if (action && action.key !== "close" && onAction) onAction(action);
}

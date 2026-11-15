/**
 * The status row and the redaction boundary.
 *
 * Main pane: ONE status line at the TOP, docked above the editor, in the operator's own words
 * (2026-11-15: "use a nerdfont … and just say Orchestrator: plan R1/6 T0/0"):
 *   󰚩 Orchestrator: plan R1/6 · T0/0 · [Alt+F]
 * and NOTHING multi-line above the editor while a run is live (the monolith painted a 6+ line task
 * dump there; during long coding runs that dump ate the transcript).
 *
 * Placement. The row lives in `ctx.ui.setWidget(TOP_WIDGET_KEY, …)`. The host's status BAR cannot
 * carry it where the operator first asked — immediately after the model name — measured in the
 * host's own renderer: `setStatus` text is printed in the `status` segment at the position the
 * USER's `statusLine.leftSegments`/`rightSegments` put it (on this box: the right side, after
 * `context_pct`), and an extension has no API to add a status-line segment or to move one. So the
 * top row is the delivered surface, and `FADE_ORCHESTRATE_SURFACE=status` opts into
 * `ctx.ui.setStatus(ORCH_STATUS_KEY, …)` for a config that placed the `status` segment after
 * `model`. The footer extension-status row is otherwise never written ("no footer for now").
 *
 * The row is written ONLY while a run is in use: `statusLines` answers `undefined` for no run, for
 * a terminal state (`complete`/`failed`/`stopped`, including a run adopted from disk at
 * session_start) and for a run this session does not own, and the caller clears the surface in
 * every one of those cases.
 *
 * `chordBytes` maps the configured key to the raw byte the raw-input listener consumes: the host
 * reserves `ctrl+o` in its shortcut table (measured: a reserved chord is logged and skipped by
 * `getShortcuts()`), so the panel is delivered by intercepting the keystroke, never by registering it.
 */
import { hostname, userInfo } from "node:os";
import type { RunState } from "./core.ts";
import { TERMINAL } from "./core.ts";

export interface TierRow {
	label: string;
	value: string;
}

export const OVERLAY_WIDGET_KEY = "fade-overlay";

/** The top-of-editor status widget. `TOP_WIDGET_KEY` is the surface the status row is drawn on. */
export const TOP_WIDGET_KEY = "fade-top";

/** The status-bar key for the opt-in `FADE_ORCHESTRATE_SURFACE=status` placement. */
export const ORCH_STATUS_KEY = "fade-orch";

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
 * The leading glyph. A Nerd Font private-use codepoint by default, overridable for a terminal
 * without one (`FADE_ORCHESTRATE_GLYPH="⚡"`); an empty value drops the glyph and the space.
 */
export function orchGlyph(): string {
	return process.env.FADE_ORCHESTRATE_GLYPH ?? "󰚩";
}

/**
 * The byte form a chord produces, which is what a raw-input listener compares against.
 *
 *  - `ctrl+<letter>` is a control code: `ctrl+o` -> 0x0f.
 *  - `alt+<letter>` is ESC + the letter: `alt+f` -> `\x1bf`.
 *  - `alt+shift+<letter>` is ESC + the uppercase letter, so it is byte-distinct from `alt+<letter>`
 *    — and this is the family the panel lives in: the host's runtime reports `alt+f` bound to
 *    `tui.editor.cursorWordRight` and `alt+shift+f` FREE (measured through its own conflict probe).
 *
 * `ctrl+shift+<letter>` is deliberately NOT here: on a TTY, shift is invisible inside a control
 * code, and that is measured, not inferred — in the pty rig a `ctrl+shift+t` keystroke arrived as
 * `ctrl+t` and ran the host's ctrl+t action, and the pane answered "Thinking blocks: visible".
 * A chord that must be distinct from a control code has to be an `alt+…` chord.
 */
export function chordBytes(key: string): string | undefined {
	const k = key.trim().toLowerCase();
	const ctrl = /^ctrl\+([a-z])$/.exec(k);
	if (ctrl) return String.fromCharCode((ctrl[1] as string).charCodeAt(0) - 96);
	const altShift = /^alt\+shift\+([a-z])$/.exec(k);
	if (altShift) return `\x1b${(altShift[1] as string).toUpperCase()}`;
	const alt = /^alt\+([a-z])$/.exec(k);
	if (alt) return `\x1b${alt[1] as string}`;
	return undefined;
}

/** The chord as a row labels it: `ctrl+o` → `Ctrl+O`, `alt+shift+f` → `Alt+Shift+F`. Never bare lowercase. */
export function keyLabel(key: string): string {
	return key
		.trim()
		.toLowerCase()
		.split("+")
		.map((part) => (part === "ctrl" ? "Ctrl" : part === "alt" ? "Alt" : part === "shift" ? "Shift" : part.toUpperCase()))
		.join("+");
}

/**
 * The model segment, abbreviated to the operator's form of 2026-11-15:
 *   "flash-next (Swift Flash Next IQ3_S, dual RTX 5090)"                        -> "flash-next (IQ3_S, dual)"
 *   "deepseek (Basalt DeepSeek-V4.1-Flash UD-IQ1_M, dual RTX 5090, 122 GiB SSD)" -> "deepseek (IQ1_M, dual)"
 * The quant and the GPU count are the two facts that change the loop's economics; the version, the
 * family word and the RAM tier are noise on a 100-column row. A name carrying neither passes its
 * base segment through, so an unknown model is never masked.
 */
export function modelLabel(name: string): string {
	const paren = name.indexOf("(");
	// A bare model id (no display-name parenthetical) is already the operator's form: pass it through.
	if (paren < 0) return name.trim();
	const base = name.slice(0, paren).trim();
	if (base === "") return name.trim();
	const quant = /(IQ\d+[A-Za-z0-9_]*|Q[0-8]_[A-Za-z0-9]+)/i.exec(name);
	const hw = /\b(dual|tri|quad|single)\b/i.exec(name);
	const bits = [quant ? quant[1] : "", hw ? hw[1].toLowerCase() : ""].filter(Boolean);
	return bits.length > 0 ? `${base} (${bits.join(", ")})` : base;
}

/**
 * A per-character hue ramp. The row that names a lane switch is colored by design (operator order
 * 2026-11-15: "when actively switching, it should be a multicolored text"), and the percent drives
 * the phase, so each repaint visibly moves the ramp: the row is a progress bar the eye can catch in
 * the corner of the screen. A steady run prints NO escape codes at all — the color means "working".
 */
export function ramp(text: string, phase = 0): string {
	const chars = [...text];
	if (chars.length === 0) return text;
	const hslRgb = (h: number, s: number, l: number): [number, number, number] => {
		const k = (n: number) => (n + h / 30) % 12;
		const a = s * Math.min(l, 1 - l);
		const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
		return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
	};
	return chars
		.map((c, i) => {
			const [r, g, b] = hslRgb(((i / Math.max(1, chars.length)) * 300 + phase * 12) % 360, 0.85, 0.62);
			return `\x1b[38;2;${r};${g};${b}m${c}\x1b[0m`;
		})
		.join("");
}

/** What the router is loading right now, as the row renders it. Built by the wiring layer. */
export interface SwapPill {
	from: string;
	to: string;
	percent?: number;
}

/**
 * The live status row, and the single place the "only when in use" rule lives.
 *
 * `undefined` — the caller must CLEAR the surface — when there is no run, when the run is terminal
 * (`complete`/`failed`/`stopped`, including a run adopted from disk at session_start: a finished run
 * never advertises), and when this session does not own the run. A live run yields one line:
 *   `<glyph> Orchestrator: <state> R<round>/<max> · T<passed>/<total> · [<key>]`
 * with the protocol-stall badge, the paused marker and the tok/s suffix riding behind it, plus a
 * second line naming the competing entries while the flip guard is firing. The steady line carries
 * no model name (operator order 2026-11-15): the host's model segment is the model's surface, and
 * printing it here would name the model a second time.
 *
 * While a lane is loading the line REPLACES its state segment with the switch, multicolored, and
 * the model name appears exactly once — the abbreviated label of the lane coming in.
 */
export function statusLines(
	run: RunState | undefined,
	opts: { suffix?: string; flip?: FlipBadge; owned?: boolean; swap?: SwapPill; key?: string } = {},
): string[] | undefined {
	if (!run) return undefined;
	if (TERMINAL[run.state] === true) return undefined;
	if (opts.owned === false) return undefined;
	// A state read off disk can lack the arrays (the class measured in the rpc rig); the row is the
	// one surface painted on every tick, so a missing `tasks` must not throw inside a host callback.
	const tasks = Array.isArray(run.tasks) ? run.tasks : [];
	const total = tasks.length;
	const passed = tasks.filter((t) => t.status === "passed").length;
	const stall = (run.stall_count ?? 0) > 0 ? ` · protocol ${run.stall_count}/3` : "";
	const paused = run.paused === true ? " · paused" : "";
	const glyph = orchGlyph();
	const head = glyph === "" ? "" : `${glyph} `;
	// The key hint is the configured chord's label, passed in by the caller: the row and the key can
	// never disagree. The default is the delivered chord — `Alt+F`, claimed at the raw-input layer:
	// the host's table binds `alt+f` (`tui.editor.cursorWordRight`) so its SHORTCUT is refused, and
	// the byte is what opens the screen. `Ctrl+O` is the chord this extension never binds, so a row
	// defaulting to it would advertise a dead key.
	const hint = `[${opts.key ?? "Alt+F"}]`;
	if (opts.swap) {
		const pct = opts.swap.percent != null ? ` ${Math.round(opts.swap.percent)}%` : "";
		const line = `${head}Orchestrator: switching ${opts.swap.from}→${opts.swap.to}${pct} · ${hint}${stall}${paused}`;
		return [shown(ramp(line, opts.swap.percent ?? 0), run)];
	}
	const line = `${head}Orchestrator: ${shortState(run.state)} R${run.round}/${run.max_rounds} · T${passed}/${total} · ${hint}${stall}${paused}${opts.suffix ? ` · ${opts.suffix}` : ""}`;
	if (!opts.flip || opts.flip.flips < 1) return [shown(line, run)];
	const who = opts.flip.competing.length > 0 ? opts.flip.competing.join(", ") : "the other lane";
	return [shown(line, run), shown(`  lane flip: ${opts.flip.flips} swaps in ${opts.flip.window_s}s — requests naming ${who} (not ${run.lane})`, run)];
}

/**
 * Y21: the lane churn the guard saw, as the surface renders it. Produced from the router client's
 * `FlipState` by the wiring layer; kept as a plain shape here so the renderer has no transport
 * dependency and the rig can drive it directly.
 */
export interface FlipBadge {
	flips: number;
	window_s: number;
	competing: string[];
}

/**
 * Short lane name, used by the panel's compact rows: "flash-next" -> "fn", "deepseek" -> "de".
 * `/orchestrate status` and the panel's header print the FULL name, always.
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
 * The state machine's short name (`planning` -> `plan`), exported for the panel's rows. An unknown
 * future state passes through untruncated rather than being masked.
 */
export function shortState(state: string): string {
	return SHORT_STATE[state] ?? state;
}


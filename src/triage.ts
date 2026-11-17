/**
 * Red-gate TRIAGE: one bounded, tool-less model call that names the probable cause of a red
 * pre-swap gate, so the coding lane starts its repair with a hypothesis instead of a re-read.
 *
 * The gate is the cheap answer to a red tree: the verifier swap costs a 13-25 s pack load, and the
 * gate's exit codes already say WHAT failed. What the lane spends its next turn discovering is WHY.
 * This file supplies that, from the tails the gate already captured.
 *
 * Three boundaries make it safe to bolt onto a phase boundary:
 *
 * 1. **ZERO authority.** The gate's verdict is the checks' exit codes (`core.ts` `runGate`) and
 *    stays that way. This text is advisory: it is appended to the briefing and the tool's answer,
 *    and it never blocks, approves, changes state, loads a lane, or touches a task status. A
 *    triage that names the wrong cause costs the coder one wasted turn; a triage cannot make a red
 *    gate green, because the next `coding_done` re-runs the checks.
 * 2. **NO tools.** `--disallowed-tools '*'`: the prompt carries the failing commands, the expected
 *    lines, and the captured tails, so the answer needs no filesystem, and an advisory agent with
 *    write tools editing the tree the coder is repairing is a defect waiting to happen.
 * 3. **BOUNDED and silent on failure.** One call, one wall-clock cap. A timeout, a missing binary,
 *    a non-JSON answer or a cancelled turn returns an empty note with the reason — the gate briefing
 *    ships without the line, exactly as it did before this feature existed.
 */
import { spawn } from "node:child_process";

export interface GateRow {
	cmd: string;
	expected: string;
	ok: boolean;
	tail: string;
	want?: "exit0" | "nonzero" | "quiet";
	invalid?: boolean;
	budget?: boolean;
}

export interface TriageResult {
	/** The advisory line, `""` when there is nothing to say. */
	note: string;
	ms: number;
	/** Why there is no note; never present when a note was produced. */
	why?: string;
	/** True when triage is switched off, so a caller never reads an empty note as a failed call. */
	skipped?: boolean;
}

export const TRIAGE_BIN = process.env.FADE_ORCHESTRATE_GATE_TRIAGE_BIN ?? "grok";
export const TRIAGE_TIMEOUT_MS = Number(process.env.FADE_ORCHESTRATE_GATE_TRIAGE_TIMEOUT_MS ?? 45_000);
/** `0` turns the feature off; the gate then behaves exactly as it did before it. */
export const triageEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.FADE_ORCHESTRATE_GATE_TRIAGE !== "0";

const TAIL_CHARS = 900;

/** The prompt: the gate's own rows, nothing invented, and an answer shaped for a briefing line. */
export function triagePrompt(failing: GateRow[]): string {
	const rows = failing.map((r, i) => {
		const want = r.want && r.want !== "exit0" ? ` (declared: ${r.want})` : "";
		const tail = (r.tail ?? "").slice(0, TAIL_CHARS);
		return `${i + 1}. cmd: ${r.cmd}\n   expected: ${r.expected}${want}\n   tail:\n${tail}`;
	});
	return [
		`A pre-swap verification gate is RED. These are its failing rows — the command, the plan's expectation, and the captured tail. Nothing here is invented and you have no tools: answer from this text alone.`,
		``,
		rows.join("\n\n"),
		``,
		`Answer in AT MOST two sentences, plain text, no markdown, no plan, no code block:`,
		`- the single most probable ROOT CAUSE, named concretely (the file/symbol/flag/config the tail points at), and`,
		`- the ONE command the coder should run first to confirm it.`,
		`If the tails do not identify a cause, say exactly: "cause not determinable from the tails". Do not guess.`,
	].join("\n");
}

export interface TriageDeps {
	/** The spawn seam: a test answers with a canned envelope, the host runs the real CLI. */
	runCli?: (args: string[], cwd: string, timeoutMs: number) => Promise<{ code: number; out: string }>;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
}

/** Decode the CLI's JSON envelope past any banner, then take its `text`. */
export function decodeAnswer(out: string): { text?: string; stopReason?: string; why?: string } {
	const s = out.trim();
	if (s === "") return { why: "the CLI printed nothing" };
	let env: unknown;
	try {
		env = JSON.parse(s);
	} catch {
		const i = s.indexOf("{");
		if (i < 0) return { why: "the CLI did not answer JSON" };
		try {
			env = JSON.parse(s.slice(i)) as unknown;
		} catch {
			return { why: "the CLI did not answer JSON" };
		}
	}
	if (!env || typeof env !== "object") return { why: "the CLI did not answer JSON" };
	const stop = "stopReason" in env ? Reflect.get(env, "stopReason") : undefined;
	const text = "text" in env ? Reflect.get(env, "text") : undefined;
	if (typeof stop === "string" && stop !== "end_turn") return { stopReason: stop, why: `the CLI turn ended with stopReason ${stop}` };
	if (typeof text !== "string" || text.trim() === "") return { stopReason: typeof stop === "string" ? stop : undefined, why: "the CLI's answer carried no text" };
	return { text: text.trim().replace(/\s+/g, " ").slice(0, 400) };
}

async function defaultRunCli(args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ code: number; out: string }>();
	const child = spawn(args[0], args.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
	let out = "";
	const kill = setTimeout(() => {
		child.kill("SIGKILL");
		reject(new Error(`the triage call exceeded its ${Math.round(timeoutMs / 1000)} s cap`));
	}, timeoutMs);
	child.stdout.on("data", (b) => (out += String(b)));
	child.stderr.on("data", () => undefined); // the CLI's progress lines are not the answer
	child.on("error", (e) => {
		clearTimeout(kill);
		reject(e);
	});
	child.on("close", (code) => {
		clearTimeout(kill);
		resolve({ code: code ?? 1, out });
	});
	return promise;
}

/**
 * One advisory cause line for a red gate. Never throws: every failure path returns an empty note
 * with the reason, because the gate briefing must ship with or without it.
 */
export async function gateTriage(failing: GateRow[], repo: string, deps: TriageDeps = {}): Promise<TriageResult> {
	const env = deps.env ?? process.env;
	const now = deps.now ?? Date.now;
	const t0 = now();
	const timeoutMs = Number(env.FADE_ORCHESTRATE_GATE_TRIAGE_TIMEOUT_MS ?? TRIAGE_TIMEOUT_MS);
	const bin = env.FADE_ORCHESTRATE_GATE_TRIAGE_BIN ?? TRIAGE_BIN;
	if (!triageEnabled(env)) return { note: "", ms: 0, skipped: true, why: "triage disabled (FADE_ORCHESTRATE_GATE_TRIAGE=0)" };
	if (failing.length === 0) return { note: "", ms: now() - t0, why: "no failing rows" };
	const args = [
		"-p", triagePrompt(failing),
		"--cwd", repo,
		"--output-format", "json",
		"--max-turns", "1",
		"--no-subagents",
		"--disable-web-search",
		"--disallowed-tools", "*",
	];
	try {
		const r = await (deps.runCli ?? defaultRunCli)([bin, ...args], repo, timeoutMs);
		const d = decodeAnswer(r.out);
		if (!d.text) return { note: "", ms: now() - t0, why: d.why ?? `the CLI exited ${r.code} with no answer` };
		return { note: d.text, ms: now() - t0 };
	} catch (e) {
		return { note: "", ms: now() - t0, why: e instanceof Error ? e.message : String(e) };
	}
}

/** The one line the briefing and the operator see. Empty when there is nothing to say. */
export function triageLine(r: TriageResult): string {
	if (r.note === "") return "";
	return `probable cause (advisory, ${Math.round(r.ms / 100) / 10}s, no authority — the gate's exit codes decide): ${r.note}`;
}

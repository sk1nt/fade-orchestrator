/**
 * Which MoE placement a CLASS of work needs, and the version that produced it.
 *
 * The engine learns an expert placement per pack and — for a save-capable alias — writes it to a
 * profile (`expert-profile-save`, every `expert-profile-save-every` minutes). One pack, one
 * profile: the placement is shared by every kind of work the session does, so what the operator
 * can ACT on is which class of work lands on which lane, and whether that lane came in warm.
 * `state.json` answers neither: it is one slot, and the swap ledger is a flat list. This module is
 * the closed record — a task classifies into one of four classes, and the ledger rows stamped
 * with that class say how often the class's lane started from a saved placement.
 *
 * The live plane makes the mapping concrete: CI work runs on the CODE lane (`flash-next`), the
 * only save-capable alias in the running serve config (`expert-profile-save` ->
 * `var/basalt-profiles/flash-next.prof`, every 10 minutes, `gpu: "0,1"`). The verifier pack
 * (DeepSeek-V4.1) has NO save path in this engine release (moe.ts), so a `verify`-class swap can
 * never read warm: that is a state, named, not a zero.
 *
 * Classification is a CLOSED set with a stated priority, over text the run already carries
 * (objective, acceptance, files) — no model, no network, no file read. It is a heuristic in the
 * one place a heuristic is cheap: a class label on a ledger row. The warm math reads only
 * measured fields, and a class with no rows reads `0 of 0`, never a share.
 */
import type { Task } from "./core.ts";
import type { SwapRow } from "./history.ts";

/** The closed taxonomy. The order is the print order of the verb and the panel. */
export const TASK_CLASSES = ["ci", "tests", "docs", "code"] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];

/** The pipeline surface: the work runs in CI, so its lane should be warm before the job starts.
 *  `\bci\b` on purpose — `decide`, `facility` and `specific` are not a CI task. */
const PIPELINE = /\bci\b|\bworkflows?\b|pipeline|\bgh run\b|\.github\/workflows/i;
/** A runner named in the acceptance, or a test file among the task's: the rig class.
 *  `\brig\b` for the same reason — `rigorous` is not the gate rig. */
const RUNNER = /node --test|\bnpm (?:--no-install )?(?:run )?test\b|\brig\b|node test\//i;
/** Prose-only work: every file is markdown, or the objective names the doc surface. */
const PROSE = /\bREADME\b|\bdocs?\b|documentation/i;

/**
 * The class of ONE task, first match wins: pipeline -> runner -> prose -> code. The text it reads
 * is what the plan already wrote, so the class of a swap stays answerable from the ledger alone.
 */
export function classOf(task: Task): TaskClass {
	const files = Array.isArray(task.files) ? task.files : [];
	const text = `${task.objective ?? ""} ${task.acceptance ?? ""} ${files.join(" ")}`;
	if (PIPELINE.test(text)) return "ci";
	if (RUNNER.test(task.acceptance ?? "") || files.some((f) => f.endsWith(".test.mjs"))) return "tests";
	if ((files.length > 0 && files.every((f) => f.endsWith(".md"))) || PROSE.test(task.objective ?? "")) return "docs";
	return "code";
}

/** One class's warm-start record, read off the ledger. */
export interface ClassWarmth {
	cls: TaskClass;
	/** Swaps the run paid for this class. */
	swaps: number;
	/** Of those, the ones that landed on a lane whose placement was LIVE and WRITTEN by the
	 *  running engine: a start from a saved map, not a relearn. */
	warm: number;
	/** The newest such row's save path, when the lane carried one. */
	profile?: string;
}

/**
 * The per-class warm-start census, one row per `TASK_CLASSES` entry IN ORDER.
 *
 * `warm` counts only rows whose `moe` reading proves all three: `state === "live"` (the running
 * router serves the config carrying the save flag), `written_by_running_engine === true` (the
 * profile postdates this engine's start, so the map is THIS engine's) and `profile_exists === true`
 * (there is a map to place from). A `configured` lane, an older engine's file, a missing profile
 * and a row with no `moe` at all are swaps that did NOT start warm — counted in `swaps`, not in
 * `warm`. A class no swap ran reads `0 of 0` for the caller to name.
 */
export function classWarmth(swaps: SwapRow[]): ClassWarmth[] {
	return TASK_CLASSES.map((cls) => {
		const rows = swaps.filter((r) => r.task_class === cls);
		const warm = rows.filter((r) => r.moe?.state === "live" && r.moe.written_by_running_engine === true && r.moe.profile_exists === true).length;
		// The ledger is newest-first, so the first row carrying a path is the newest one.
		const newest = rows.find((r) => typeof r.moe?.profile_path === "string");
		return { cls, swaps: rows.length, warm, ...(newest?.moe?.profile_path ? { profile: newest.moe.profile_path } : {}) };
	});
}

/**
 * What built this, in one line: the engine the router reports, the extension's own version, and
 * the bundle's fingerprint. Each missing piece is NAMED — an engine that answers no version, a
 * package.json that did not parse, a `dist/index.js` that was never built — because a build
 * record of zeros verifies nothing.
 */
export function versionLine(engineVersion: string | undefined, pkgVersion: string | undefined, bundleHash: string | undefined): string {
	const engine = engineVersion ? `engine ${engineVersion}` : "engine version not reported";
	const ext = pkgVersion ? `ext ${pkgVersion}` : "ext version not read";
	const bundle = bundleHash ? `bundle ${bundleHash.slice(0, 8)}` : "bundle not built";
	return `${engine} · ${ext} · ${bundle}`;
}

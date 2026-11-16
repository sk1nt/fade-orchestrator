#!/usr/bin/env node
// recording.mjs — a scripted, reproducible demo of the orchestration surface, for a screen capture.
//
// The clip is NOT a mockup. The real `omp` binary loads the real extension (installed at
// `~/.omp/agent/extensions/fade_orchestrate.ts`) in a real 150x45 terminal rooted in a real project,
// and the panel renders from a router that speaks the basalt 0.4.0 payload `test/gate_rig.mjs` pins:
// `loaded` is a boolean, the lane rides under `model`, the tier fields nest under `engine`,
// `live.tok_s` is null at idle, and a swap in flight reports `percent` plus
// `swap {from,to,phase,since}`.
//
// What IS staged: the RUN on disk (goal, tasks, phases, the pre-swap gate) and the keystroke
// timeline. Shipped code, staged state — which is what a UI capture is. The swap is not staged end
// to end: `/orchestrate verify` — the act the panel's `[v]` key maps — runs the shipped code. It
// issues `POST /v1/load`, starts the shipped swap watcher and writes the `LANE SWAPS` ledger row,
// against a router that answers as the live one does: `/v1/load` is held until the pack is resident.
//
// A live router is never touched: the demo binds its own port (`FADE_DEMO_PORT`, default 18199), so
// recording a clip can never swap a pack something else is decoding on.
//
// The subject project's tree is never damaged: every file this demo writes is snapshotted first, and
// `--stop` restores the snapshot and prints a per-file hash comparison. A run already in
// `var/omp-orchestrate/` is preserved like any other file — clobbering a live run would be the
// silent-wire defect class, aimed at the user.
//
// Keys go through tmux (`send-keys -H 1b 66`, the Alt+F bytes `test/pty_rig.mjs` proves arrive as one
// 2-byte read) on the same clock that mutates the state files, so the clip is deterministic: one
// timeline, no race against the recorder's typer. `--help` prints the knobs and touches nothing.
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = process.argv.includes("--help") || process.argv.includes("-h");
const MODE = process.argv.includes("--stop") ? "stop" : "run";
const PORT = Number(process.env.FADE_DEMO_PORT ?? 18199); // a port no live router commonly holds
const SOCK = "fade-demo";
const SESS = "fade-demo";
// The package root, so the demo runs from a clone with no path assumptions; FADE_DEMO_REPO points
// the clip at a different project.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = process.env.FADE_DEMO_REPO ?? ROOT;

if (HELP) {
	console.log(`demo — a scripted capture of the orchestration surface: real omp, real extension, staged run.

usage
  node demo/recording.mjs                seed, launch, drive the timeline; leaves the terminal up
  node demo/recording.mjs --stop         restore the snapshotted run files, tear the terminal down
  npm run demo:record                    record the clip with vhs (needs vhs on PATH)

env
  FADE_DEMO_REPO        project the clip runs in; defaults to this package's root. Its
                        var/omp-orchestrate/ files are snapshotted and restored by hash.
  FADE_DEMO_PORT        stub router port, default 18199 — never a live router's port
  FADE_DEMO_SWAP_S      simulated pack-swap seconds, default 13
  FADE_DEMO_PROVIDER    registry provider id, default strata-flash
  FADE_DEMO_CODE_MODEL  code-lane registry model as provider/id, default <provider>/flash-next

prerequisites: tmux and the omp CLI, the extension installed at
~/.omp/agent/extensions/fade_orchestrate.ts, and vhs for npm run demo:record.`);
	process.exit(0);
}
const RUNDIR = join(REPO, "var", "omp-orchestrate");
const PRESERVE = join(RUNDIR, "demo_preserve");
const AGENT = join(tmpdir(), "fade-demo-agent");
const RUN_ID = "DEMO2611";
// The session starts ON THE CODE LANE's registry model so the host's own model segment names the lane
// the run is on from the first frame, and the extension flips it at every swap. `omp --model` takes
// `provider/id` exactly as the host's model registry spells it.
const CODE_MODEL = process.env.FADE_DEMO_CODE_MODEL ?? `${process.env.FADE_DEMO_PROVIDER ?? "strata-flash"}/flash-next`;
const T0 = Date.now();
// The files the loop owns. `swap_history.json` is measured history: it is preserved, never
// rewritten, so the clip's swap table starts from real swaps.
const RUN_FILES = ["state.json", "ACTIVE.json", "metrics.jsonl", "metrics_state.json", "swap_history.json"];

const sh = (file, args, opts = {}) => execFileSync(file, args, { encoding: "utf8", maxBuffer: 1 << 22, ...opts });
const tmux = (...args) => sh("tmux", ["-L", SOCK, ...args]);
const send = (...keys) => tmux("send-keys", "-t", SESS, ...keys);
const log = (m) => console.log(`T+${String(((Date.now() - T0) / 1000).toFixed(1)).padStart(5)}s  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");

const snapshot = () => {
	const dir = join(PRESERVE, stamp());
	mkdirSync(dir, { recursive: true });
	const kept = RUN_FILES.filter((f) => existsSync(join(RUNDIR, f)));
	for (const f of kept) copyFileSync(join(RUNDIR, f), join(dir, f));
	writeFileSync(join(dir, ".demo"), JSON.stringify({ repo: REPO, files: kept, restored_by: "--stop" }));
	return { dir, kept };
};

const restore = (dir) => {
	for (const f of RUN_FILES) {
		const src = join(dir, f);
		if (existsSync(src)) copyFileSync(src, join(RUNDIR, f));
		else if (existsSync(join(RUNDIR, f))) rmSync(join(RUNDIR, f));
	}
	rmSync(dir, { recursive: true, force: true });
};

/**
 * Any process carrying the demo's agent dir in its environment is a demo session. `tmux kill-server`
 * can leave the session's process reparented and briefly alive, and the live extension then rewrites
 * `metrics_state.json` AFTER the restore put the user's copy back. The tree is only restored once
 * nothing is left that can write it.
 */
const demoPids = () =>
	readdirSync("/proc")
		.filter((d) => /^\d+$/.test(d))
		.filter((d) => {
			try {
				return readFileSync(`/proc/${d}/environ`, "utf8").includes("fade-demo-agent");
			} catch {
				return false;
			}
		})
		.map(Number);

const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

if (MODE === "stop") {
	try {
		tmux("kill-server");
	} catch {}
	for (let waited = 0; waited < 6000; waited += 250) {
		const pids = demoPids();
		if (pids.length === 0) break;
		for (const pid of pids) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		await sleep(250);
	}
	const runs = existsSync(PRESERVE) ? readdirSync(PRESERVE).filter((d) => existsSync(join(PRESERVE, d, ".demo"))).sort() : [];
	if (runs.length === 0) console.log("demo: nothing to restore (no snapshot under var/omp-orchestrate/demo_preserve)");
	for (const d of runs) {
		const dir = join(PRESERVE, d);
		const kept = RUN_FILES.filter((f) => existsSync(join(dir, f))).map((f) => [f, sha(join(dir, f))]);
		restore(dir);
		const bad = kept.filter(([f, h]) => !existsSync(join(RUNDIR, f)) || sha(join(RUNDIR, f)) !== h);
		console.log(bad.length === 0 ? `demo: restored ${kept.length} run file(s) from ${d} — every hash matches the snapshot` : `demo: RESTORE MISMATCH for ${bad.map(([f]) => f).join(", ")} — the tree is NOT the tree you gave the demo`);
	}
	rmSync(AGENT, { recursive: true, force: true });
	process.exit(0);
}

// ---------------------------------------------------------------- the staged run
// The staged run is this repo's own review work, so the clip's panel, its checks and the gate all
// read true against the tree the terminal is rooted in.
const task = (id, objective, files, acceptance, status, result) => ({ id, objective, files, acceptance, dependencies: [], round: 1, status, ...(result ? { result } : {}) });
const state = {
	key: "fade.omp_orchestrate.v1",
	run_id: RUN_ID,
	goal: "Tidy fade-orchestrator for public review — de-diary the comments, tidy the suite, make the shipped tree reproducible",
	lane: "flash-next",
	round: 1,
	max_rounds: 6,
	state: "coding",
	checks: [
		["npm run typecheck", "exit 0: strict tsc over src"],
		["npm test", "all unit tests pass, 0 failures"],
		["npm run build", "dist/index.js rebuilt, non-empty"],
	],
	tasks: [
		task("T1", "De-diary the protocol core: the state schema, the router client, the ledgers, the MoE probe", ["src/core.ts", "src/router.ts", "src/history.ts", "src/moe.ts"], "typecheck green; no internal ticket ids or line-number pointers left", "passed", "the invariants survive; four exports with no consumer are gone"),
		task("T2", "De-diary the wiring: hooks, tools, commands, the lane switch, the raw-key listener", ["src/index.ts"], "typecheck green; every hook, schema and error string byte-identical", "passed", "each rule is stated once, where it is enforced"),
		task("T3", "De-diary the surface: the status line, the screen, its data contract, the key map", ["src/ui.ts", "src/panel.ts", "src/screendata.ts", "src/keymap.ts"], "typecheck green; every rendered string unchanged", "passed", "the model-naming rule now lives on modelLabel alone"),
		task("T4", "Tidy the suite: the unit tests and the three rigs, one shared fixture", ["test/"], "the rebuilt bundle passes every test", "in_progress"),
		task("T5", "Rewrite the docs: README, the surface doc, the quantization rationale", ["README.md", "docs/"], "no private provenance in the docs; the stated test count matches the suite", "pending"),
		task("T6", "Make the shipped tree reproducible: the demo, the bundle, the CI gates", ["demo/", "package.json", ".github/workflows/ci.yml", "dist/index.js"], "the bundle matches a fresh build; the demo has a dry run", "pending", "each CI step names exactly what it proves"),
	],
	phases: [{ phase: "planning_done", lane: "deepseek", accepted: true, round: 1, at: new Date(Date.now() - 14 * 60_000).toISOString() }],
	rejection_history: [],
	repair_tasks: [],
	protocol_retries: 0,
	stall_count: 0,
	paused: false,
	started_utc: new Date(Date.now() - 17 * 60_000).toISOString(),
	repo: REPO,
};

const seed = () => {
	if (!existsSync(REPO)) {
		console.error(`demo: ${REPO} does not exist — the clip runs in a real project. Point FADE_DEMO_REPO at one, or clone one.`);
		process.exit(1);
	}
	mkdirSync(RUNDIR, { recursive: true });
	const pres = snapshot();
	log(`snapshotted ${pres.kept.length} run file(s) → ${pres.dir.replace(homedir(), "~")} (--stop restores them)`);
	writeFileSync(join(RUNDIR, "state.json"), JSON.stringify(state, null, 2));
	writeFileSync(join(RUNDIR, "ACTIVE.json"), JSON.stringify({ run_id: RUN_ID, repo: REPO, goal: state.goal, started_utc: state.started_utc, max_rounds: 6 }, null, 2));
	const turn = (n, phase, pp, tg, ttft, kv, swap_ms, at_min_ago) => JSON.stringify({ ts: new Date(Date.now() - at_min_ago * 60_000).toISOString(), run_id: RUN_ID, turn: n, round: 1, phase, pp, tg, ttft, kv_hit_pct: kv, swap_ms, round_outcome: phase ?? "coding" });
	writeFileSync(join(RUNDIR, "metrics.jsonl"), [
		turn(1, "planning_done", 35144, 134, 4.21, 82.4, 0, 16),
		turn(2, "coding", 807587, 452, 0.12, 99.9, 16513, 11),
		turn(3, "coding", 98536, 147, 0.25, 99.9, 0, 6),
		turn(4, "coding", 61220, 3355, 0.3, 91.0, 0, 2),
	].join("\n") + "\n");
	if (!existsSync(join(RUNDIR, "swap_history.json")))
		writeFileSync(join(RUNDIR, "swap_history.json"), JSON.stringify({ key: "fade.omp_orchestrate.swaps.v1", rows: [] }, null, 2));

	// An isolated agent dir: every entry of the host's agent dir symlinked EXCEPT keybindings, so the
	// host's own chords cannot decide what the clip shows.
	rmSync(AGENT, { recursive: true, force: true });
	mkdirSync(AGENT, { recursive: true });
	const real = join(homedir(), ".omp", "agent");
	for (const entry of readdirSync(real)) {
		if (/^keybindings\.(yml|yaml|json)$/i.test(entry)) continue;
		symlinkSync(join(real, entry), join(AGENT, entry));
	}
	log(`staged run ${RUN_ID} in ${REPO} (${state.tasks.length} tasks, ${state.checks.length} checks) — tasks are the project's real work`);
};

// ---------------------------------------------------------------- the stub router
// The measured basalt 0.4.0 shape, field for field. The one scripted part is the swap physics: a
// `POST /v1/load` is answered only when the pack is resident (the live router's behavior), while
// `/health` reports `loading`, a ramping `percent` and the `swap` object. That is what makes the
// multicolored row and the measured ledger row appear from the shipped code.
const SWAP_S = Number(process.env.FADE_DEMO_SWAP_S ?? 13); // live swaps measure 13-25 s
let resident = "flash-next";
let swap = null;
let percent = null;
let swapT0 = 0;
let landers = [];
setInterval(() => {
	if (!swap) return;
	const el = (Date.now() - swapT0) / 1000;
	if (el < SWAP_S) {
		percent = Math.min(99, Math.round((el / SWAP_S) * 100));
		return;
	}
	const from = swap.from;
	const to = swap.to;
	swap = null;
	percent = null;
	resident = to;
	for (const l of landers.splice(0)) l(from, to);
}, 1000).unref();

const server = createServer(async (req, res) => {
	let body = "";
	for await (const c of req) body += c;
	const reply = (obj, code = 200) => {
		res.writeHead(code, { "content-type": "application/json" });
		res.end(JSON.stringify(obj));
	};
	if (req.url.startsWith("/health"))
		return reply({ status: "ok", max_context: 262144, model: resident, images: true, api_key: false, loaded: resident !== null, loading: swap !== null, service: "basalt", percent, swap });
	if (req.url === "/v1/models")
		return reply({ data: [{ id: "flash-next", object: "model", status: { value: resident === "flash-next" ? "loaded" : "unloaded" } }, { id: "deepseek", object: "model", status: { value: resident === "deepseek" ? "loaded" : "unloaded" } }] });
	if (req.url === "/v1/load" && req.method === "POST") {
		const { model } = JSON.parse(body || "{}");
		if (model === resident) return reply({ ok: true, model, note: "already resident" });
		const t0 = Date.now();
		swap = { from: resident, to: model, phase: "loading", since: 0 };
		percent = 2;
		swapT0 = Date.now();
		// Held open until the pack is resident, exactly as the live router answers: an early answer
		// would clear the extension's swap pill at once, and the clip would show a swap with no swap.
		landers.push(() => reply({ ok: true, model, swapped: true, elapsed_s: +((Date.now() - t0) / 1000).toFixed(3) }));
		return;
	}
	if (req.url === "/metrics")
		return reply({
			engine: { model: resident, version: "0.4.0", quant: resident, expert_slots: 13112, expert_total: 24576, spill: null, max_context: 262144, kv: "int8", gpus: "0000:11:00.0,0000:E1:00.0", vram_free_mib: 649, arena_mib: 34638 },
			live: { state: swap ? "loading" : "decoding", load: percent, queued: 0, slots: { total: 1, active: 1, queue_depth: 0 }, queue: [], tok_s: swap ? null : 437.2 },
			best: { prefill: { tok_s: 12758.7 }, decode: { tok_s: 622.0 } },
			totals: { requests: 3860, prompt: 470387266, reused: 460719434 },
			requests: [{ id: "r_3849", path: "/v1/chat/completions", slot: 0, duration_s: 0.6, prompt_tokens: 98536, reused: 98230, output_tokens: 147, decode_tok_s: 437.2, hit_rate: 0.999, ttft_s: 0.25 }],
			swap,
		});
	reply({ error: "unknown" }, 404);
});

// ---------------------------------------------------------------- the terminal
const launch = () => {
	// `-u PI_SESSION_FILE -u PI_SESSION_ID` is load-bearing: a session whose file is nested under a
	// dated parent dir is classified DELEGATED, so the status row is suppressed by the `owned` rule and
	// `/orchestrate` refuses to start a run. The demo's terminal must own its session identity.
	const env = {
		PI_CODING_AGENT_DIR: AGENT,
		FADE_ORCHESTRATE_ROUTER: `http://127.0.0.1:${PORT}`,
		FADE_ORCHESTRATE_METRICS_INTERVAL_MS: "1000",
		FADE_ORCHESTRATE_PANEL_REFRESH_MS: "1000",
	};
	// A demo terminal that is not up yet is the normal case: tmux says so on stderr with exit 1, which
	// execFileSync turns into a throw, and a clip must not show an error line for a clean start.
	try {
		sh("tmux", ["-L", SOCK, "kill-server"], { stdio: "ignore" });
	} catch {}
	tmux("new-session", "-d", "-x", "150", "-y", "45", "-s", SESS, "-c", REPO, "env", "-u", "PI_SESSION_FILE", "-u", "PI_SESSION_ID", ...Object.entries(env).flatMap(([k, v]) => [`${k}=${v}`]), "omp", "--model", CODE_MODEL, "--no-session", "--no-tools", "--no-lsp", "--offline", "--no-judge", "--no-spotlight");
	// The demo terminal is the subject of a capture, not a multiplexer to operate: the tmux status bar
	// would sit under the panel's key bar and read as part of the product.
	tmux("set-option", "-t", SESS, "status", "off");
};

const readState = () => JSON.parse(readFileSync(join(RUNDIR, "state.json"), "utf8"));
const writeState = (st) => writeFileSync(join(RUNDIR, "state.json"), JSON.stringify(st, null, 2));

const timeline = [
	{ t: 17, note: "Alt+F (ESC f, raw bytes) opens the screen", do: () => send("-H", "1b", "66") },
	{ t: 23, note: "the selection moves: the selected task carries its files and acceptance", do: () => send("Down") },
	{ t: 26, note: "…and the next task", do: () => send("Down") },
	{ t: 29, note: "Escape closes the screen; the status row survives", do: () => send("Escape") },
	{
		t: 32,
		note: "pre-swap gate runs on the CODE lane → GREEN (the swap is paid only after this)",
		do: () => {
			const st = readState();
			st.gate_last = {
				passed: true,
				at: new Date().toISOString(),
				results: st.checks.map(([cmd, expected]) => ({ cmd, expected, ok: true, tail: "exit 0" })),
			};
			st.tasks[3].status = "passed";
			st.tasks[3].result = "the suite is green against the rebuilt bundle and every rig names what it pins";
			writeState(st);
		},
	},
	{ t: 34, note: "Alt+F again: the gate row is GREEN, so the verifier swap is now payable (held 8s to read)", do: () => send("-H", "1b", "66") },
	{ t: 42, note: "Escape: the status row is the surface for a swap, and the panel would cover it", do: () => send("Escape") },
	{ t: 44, note: "/orchestrate verify — the shipped act issues POST /v1/load; the row turns multicolored while the pack comes in", do: () => send("/orchestrate verify", "Enter") },
	{
		t: 44 + SWAP_S + 2,
		note: "the thinking lane is resident: the loop's own watcher wrote the measured swap row",
		do: () => {
			const st = readState();
			st.phases.push({ phase: "coding_done", lane: "flash-next", accepted: true, round: 1, at: new Date().toISOString() });
			writeState(st);
		},
	},
	{ t: 44 + SWAP_S + 4, note: "Alt+F: the verifier's view — resident deepseek, the swap cost on screen (held 10s)", do: () => send("-H", "1b", "66") },
	{ t: 44 + SWAP_S + 14, note: "Escape", do: () => send("Escape") },
	{ t: 44 + SWAP_S + 17, note: "/orchestrate halt: a run not in use leaves nothing on screen", do: () => send("/orchestrate halt", "Enter") },
];

const main = async () => {
	if (spawnSync("bash", ["-c", `exec 3<>/dev/tcp/127.0.0.1/${PORT}`], { encoding: "utf8" }).status === 0) {
		console.error(`demo: port ${PORT} is already serving — a second demo would drive the first one's terminal. Point FADE_DEMO_PORT elsewhere, or run: node demo/recording.mjs --stop`);
		process.exit(1);
	}
	seed();
	await new Promise((r, j) => {
		server.once("error", j);
		server.listen(PORT, "127.0.0.1", r);
	});
	log(`stub router on 127.0.0.1:${PORT} (the basalt 0.4.0 payload shape; no live router is touched)`);
	launch();
	log(`omp + the live extension started in a 150x45 tmux terminal, rooted in ${REPO}`);
	console.log(`\n  attach:  tmux -L ${SOCK} attach -t ${SESS}\n`);
	console.log("  one clock drives keys and state:\n" + timeline.filter((e) => e.note).map((e) => `    T+${String(e.t).padStart(5)}s  ${e.note}`).join("\n") + "\n");

	for (const ev of timeline) {
		const wait = ev.t * 1000 - (Date.now() - T0);
		if (wait > 0) await sleep(wait);
		ev.do();
		if (ev.note) log(ev.note);
	}
	log("timeline done — the demo terminal is still up: tmux -L fade-demo attach");
	log(`restore the project's run files and tear it down: node demo/recording.mjs --stop`);
	server.close();
	process.exit(0);
};

main().catch((e) => {
	console.error(`demo: ${e instanceof Error ? e.message : e}`);
	process.exit(1);
});

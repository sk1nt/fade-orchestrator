/**
 * Optimal MoE loading across turns: the engine's "last known placement" support.
 *
 * Measured basis (basalt 0.4.0, docs/configuration/index.md:108-110, 2026-11):
 * - `expert-profile-save` — **Flash-Next only**: the learned expert placement is written on exit
 *   and every `expert-profile-save-every` minutes; a later start places from it instead of
 *   relearning. Needs the adaptive tier. This is the warm start the 91 -> 130 tok/s cold ramp
 *   exists without.
 * - `expert-profile` (read side) — Flash-Next default: `data/profiles/<arch>-<layers>x<experts>.prof`.
 * - The verifier pack (DeepSeek-V4.1) has NO save path in this engine release: the only profile
 *   is the pack's own static one (`m_.tiers().expert_profile`, src/models/deepseek41/tier.cpp:499);
 *   `write_expert_profile` is wired only by the qwen4exp `--expert-profile-save` path
 *   (src/models/qwen4exp/serve/tier_profile.cpp:17). So DeepSeek rehearses placement every swap;
 *   it cannot be made warm by configuration until the engine grows the counterpart.
 *
 * Three states must stay states, never greens:
 *   configured_not_live — the serve config names the save file, but the RUNNING router does not
 *     serve that config file (a config edit without a router/lane reload = exactly this);
 *   configured_live_no_profile — the flag is live, no profile file yet (nothing learned yet);
 *   engine_unsupported — the pack's model class has no save path (the verifier lane).
 *
 * Measured 2026-11-15: on this desk the knobs reach the engine through the CONFIG, not argv — the
 * router is `python -m serve.server --config <file>` and the engine's argv carries none of the
 * model aliases' keys, so an argv-only liveness test reports a working lane as "NOT live". The
 * running router's own `--config` path is therefore the liveness test, and the profile's mtime
 * against the engine process start is the write-side proof.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface LaneMoe {
	lane: string;
	/** "live" = the running router serves the config that carries the save flag; "configured" = config only. */
	state: "live" | "configured" | "unsupported" | "unknown";
	/** The save path from the config (absolute), when configured. */
	profile_path?: string;
	/** Profile file exists and its age: a start after this file was written places warm. */
	profile_exists: boolean;
	profile_age_s?: number;
	/** The running router names the very config file this reading parsed. */
	config_is_running?: boolean;
	/** The profile's mtime is at or after the running engine's start: THIS engine writes it. */
	written_by_running_engine?: boolean;
	/** The Flash-Next-only fact, named per lane: the verifier pack has no save path. */
	note?: string;
}

const FLASH_NEXT_SAVE_CAPABLE = /flash.?next|qwen/i;

export function readServeConfig(path: string | undefined): { models: Record<string, Record<string, unknown>> } | undefined {
	if (!path) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as { models?: Array<Record<string, unknown>> };
		const models: Record<string, Record<string, unknown>> = {};
		for (const m of raw.models ?? []) {
			const alias = String(m.alias ?? m.model ?? "");
			if (alias) models[alias] = m;
		}
		return { models };
	} catch {
		return undefined;
	}
}

/** The engine's own command line, preferring the basalt binary over the python router that starts it. */
export function runningEngineArgs(): string | undefined {
	const proof = engineProof();
	return proof.engineCmdline ?? proof.routerCmdline;
}

export interface EngineProof {
	engineCmdline?: string;
	routerCmdline?: string;
	/** The config path the RUNNING router names in its argv (`--config <path>`). */
	routerConfigPath?: string;
	enginePid?: number;
	/** Epoch seconds of the engine process start, from /proc/<pid>/stat + /proc/uptime. */
	engineStartEpoch?: number;
}

/** Scan /proc once for the engine and the router: the only surface that proves what is RUNNING. */
export function engineProof(): EngineProof {
	const out: EngineProof = {};
	try {
		for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
			let cmd: string;
			try {
				cmd = readFileSync(join("/proc", pid, "cmdline"), "utf8");
			} catch {
				continue;
			}
			const flat = cmd.split("\0").join(" ");
			if (!out.engineCmdline && /\/basalt\b/.test(flat) && /--serve/.test(flat) && !/\bpython\b/.test(flat.split(" ")[0] ?? "")) {
				out.engineCmdline = flat;
				out.enginePid = Number(pid);
				out.engineStartEpoch = processStartEpoch(Number(pid));
			}
			if (!out.routerCmdline && /serve\.server/.test(flat)) {
				out.routerCmdline = flat;
				const cfg = /--config[= ](\S+)/.exec(flat)?.[1];
				if (cfg) out.routerConfigPath = cfg;
			}
			if (out.engineCmdline && out.routerCmdline) break;
		}
	} catch {
		// /proc unavailable (non-Linux): unknown, never a green.
	}
	return out;
}

/** Process start epoch, from /proc/<pid>/stat field 22 (starttime, clock ticks) and /proc/uptime. */
export function processStartEpoch(pid: number): number | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const starttime = Number(fields[19]);
		const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
		if (!Number.isFinite(starttime) || !Number.isFinite(uptime)) return undefined;
		return Math.floor(Date.now() / 1000 - (uptime - starttime / 100));
	} catch {
		return undefined;
	}
}

/** Path identity that tolerates relative/absolute spellings of the same file (the unit's argv is relative). */
const sameFile = (a: string, b: string): boolean => {
	const na = resolve(a);
	const nb = resolve(b);
	return na === nb || na.replace(/\/+$/, "") === nb.replace(/\/+$/, "");
};

export function laneMoe(lane: string, opts: { configPath?: string; modelsDir?: string; liveCmdline?: string; proof?: EngineProof } = {}): LaneMoe {
	const cfg = readServeConfig(opts.configPath);
	const model = cfg?.models?.[lane];
	const savePath = model && typeof model["expert-profile-save"] === "string" ? String(model["expert-profile-save"]) : undefined;
	const saveCapable = FLASH_NEXT_SAVE_CAPABLE.test(lane) || (model && String(model.model ?? "").toLowerCase().includes("qwen"));
	if (!savePath && !saveCapable) {
		return { lane, state: "unsupported", profile_exists: false, note: "engine has no save path for this pack (Flash-Next only); placement is relearned every swap" };
	}
	if (!savePath) {
		return {
			lane,
			state: "configured",
			profile_exists: false,
			note: 'save-capable pack: the serve config does not set "expert-profile-save" (operator act: add it at the model alias, then reload the lane)',
		};
	}
	const proof = opts.proof ?? engineProof();
	// Liveness: the caller may hand us a cmdline (the rigs' argv form, the engine's direct-launch
	// form). On this desk the knobs reach the engine through the CONFIG the router names, so the
	// running router's `--config` path is the test; the argv scan is the fallback for a direct launch.
	const argvLive = opts.liveCmdline !== undefined && opts.liveCmdline.includes("--expert-profile-save") && opts.liveCmdline.includes(savePath);
	const configIsRunning = opts.configPath !== undefined && proof.routerConfigPath !== undefined && sameFile(proof.routerConfigPath, opts.configPath);
	const isLive = opts.liveCmdline !== undefined ? argvLive : argvLive || configIsRunning;
	let exists = false;
	let age_s: number | undefined;
	let writtenByEngine: boolean | undefined;
	try {
		const st = statSync(savePath);
		exists = st.isFile();
		age_s = (Date.now() - st.mtimeMs) / 1000;
		if (proof.engineStartEpoch !== undefined) writtenByEngine = st.mtimeMs / 1000 >= proof.engineStartEpoch;
	} catch {
		exists = false;
	}
	const note = isLive
		? exists && writtenByEngine === false
			? "live: the running router serves this config; the profile PREDATES this engine — placing from it needs the lane (re)load, and the engine rewrites it every expert-profile-save-every minutes"
			: undefined
		: `configured, NOT live: the running router serves ${proof.routerConfigPath ?? "no config path (a direct engine launch)"}, not ${opts.configPath ?? "the configured path"} (reload the lane/router to apply)`;
	return {
		lane,
		state: isLive ? "live" : "configured",
		profile_path: savePath,
		profile_exists: exists,
		...(age_s !== undefined ? { profile_age_s: age_s } : {}),
		config_is_running: configIsRunning,
		...(writtenByEngine !== undefined ? { written_by_running_engine: writtenByEngine } : {}),
		...(note !== undefined ? { note } : {}),
	};
}

/** One overlay row per lane: the "load last known MoE configuration" state, measured. */
export function moeRows(lanes: string[], opts: { configPath?: string; liveCmdline?: string; proof?: EngineProof } = {}): { label: string; value: string }[] {
	const proof = opts.proof ?? engineProof();
	return lanes.map((lane) => {
		const m = laneMoe(lane, { ...opts, proof });
		const age = m.profile_age_s !== undefined ? `${(m.profile_age_s / 3600).toFixed(1)} h old` : "no file";
		const value =
			m.state === "unsupported"
				? "unsupported (Flash-Next only; relearned per swap)"
				: m.state === "configured" && !m.profile_path
					? "not configured (add expert-profile-save, reload lane)"
					: m.state === "configured"
						? `configured, NOT live · ${m.profile_exists ? age : "no profile yet"}`
						: `${m.state} · ${m.profile_exists ? age : "no profile yet"} · ${m.written_by_running_engine === true ? "written by this engine · warm start" : m.profile_exists ? "earlier engine's file · warm on reload" : "nothing learned yet"}`;
		return { label: `MoE ${lane}`, value };
	});
}

export const MOE_ACT_DOC = `Optimal MoE loading (operator act, per lane):
  1. in the basalt serve config's model entry add
       "expert-profile-save": "<repo>/var/basalt-profiles/<alias>.prof",
       "expert-profile-save-every": 10
  2. reload that lane (POST /v1/load on the alias at a quiet moment).
Flash-Next saves the learned adaptive-tier placement and starts from it (warm start, no 91 tok/s
ramp). DeepSeek-V4.1 has no save path in engine 0.4.0: its placement is relearned every swap and
cannot be made warm by configuration.`;

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
 *   configured_not_live — the serve config names the save file but the RUNNING engine's cmdline
 *     does not carry the flag (a config edit without a lane reload = exactly this);
 *   configured_live_no_profile — the flag is live, no profile file yet (nothing learned yet);
 *   engine_unsupported — the pack's model implementation has no save path (verifier lane).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LaneMoe {
	lane: string;
	/** "live" = the running engine carries the save flag; "configured" = config only. */
	state: "live" | "configured" | "unsupported" | "unknown";
	/** The save path from the config (absolute), when configured. */
	profile_path?: string;
	/** Profile file exists and its age: a start after this file was written places warm. */
	profile_exists: boolean;
	profile_age_s?: number;
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

/** The running engine's command line, to prove a config flag is actually live (not just edited). */
export function runningEngineArgs(): string | undefined {
	try {
		for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
			let cmd: string;
			try {
				cmd = readFileSync(join("/proc", pid, "cmdline"), "utf8");
			} catch {
				continue;
			}
			if (/\bbasalt\b/.test(cmd) && /--serve|serve\b/.test(cmd)) return cmd.split("\0").join(" ");
		}
	} catch {
		// /proc unavailable (non-Linux): unknown, never a green.
	}
	return undefined;
}

export function laneMoe(lane: string, opts: { configPath?: string; modelsDir?: string; liveCmdline?: string } = {}): LaneMoe {
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
	const live = opts.liveCmdline;
	const isLive = live === undefined ? true : live.includes("--expert-profile-save") && live.includes(savePath);
	let exists = false;
	let age_s: number | undefined;
	try {
		const st = statSync(savePath);
		exists = st.isFile();
		age_s = (Date.now() - st.mtimeMs) / 1000;
	} catch {
		exists = false;
	}
	return {
		lane,
		state: isLive ? "live" : "configured",
		profile_path: savePath,
		profile_exists: exists,
		...(age_s !== undefined ? { profile_age_s: age_s } : {}),
		note: isLive ? undefined : "configured, NOT live: the running engine was started before the flag existed (reload the lane to apply)",
	};
}

/** One overlay row per lane: the "load last known MoE configuration" state, measured. */
export function moeRows(lanes: string[], opts: { configPath?: string; liveCmdline?: string } = {}): { label: string; value: string }[] {
	const live = opts.liveCmdline ?? runningEngineArgs();
	return lanes.map((lane) => {
		const m = laneMoe(lane, { ...opts, liveCmdline: live });
		const age = m.profile_age_s !== undefined ? `${(m.profile_age_s / 3600).toFixed(1)} h old` : "no file";
		const value =
			m.state === "unsupported"
				? "unsupported (Flash-Next only; relearned per swap)"
				: m.state === "configured" && !m.profile_path
					? "not configured (add expert-profile-save, reload lane)"
					: `${m.state} · ${m.profile_exists ? age : "no profile yet"}${m.profile_exists ? " · warm start" : ""}`;
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

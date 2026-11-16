/**
 * Optimal MoE loading across turns: the engine's "last known placement" support.
 *
 * Engine facts (basalt 0.4.0):
 * - `expert-profile-save` — **Flash-Next only**: the learned expert placement is written on exit
 *   and every `expert-profile-save-every` minutes; a later start places from it instead of
 *   relearning. Needs the adaptive tier. This is the warm start the 91 -> 130 tok/s cold ramp
 *   exists without.
 * - `expert-profile` (read side) — Flash-Next default: `data/profiles/<arch>-<layers>x<experts>.prof`.
 * - The verifier pack (DeepSeek-V4.1) has NO save path in this engine release: the only profile
 *   is the pack's own static one (`m_.tiers().expert_profile`, src/models/deepseek41/tier.cpp);
 *   `write_expert_profile` is wired only by the qwen4exp `--expert-profile-save` path
 *   (src/models/qwen4exp/serve/tier_profile.cpp). So DeepSeek rehearses placement every swap;
 *   it cannot be made warm by configuration until the engine grows the counterpart.
 *
 * Three states must stay states, never greens:
 *   configured_not_live — the serve config names the save file, but the RUNNING router does not
 *     serve that config file (a config edit without a router/lane reload = exactly this);
 *   configured_live_no_profile — the flag is live, no profile file yet (nothing learned yet);
 *   engine_unsupported — the pack's model class has no save path (the verifier lane).
 *
 * The knobs reach the engine through the CONFIG, not argv: the router is
 * `python -m serve.server --config <file>` and the engine's argv carries none of the model
 * aliases' keys, so an argv-only liveness test reports a working lane as "NOT live". The running
 * router's own `--config` path is therefore the liveness test, and the profile's mtime against
 * the engine process start is the write-side proof.
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

/** How long a `/proc` scan stays trustworthy. The scan walks every pid on the box, and the panel
 *  asks for it on every keystroke and on each 2 s refresh tick; a lane load or a router restart
 *  invalidates it, so 10 s is the worst-case lag for anything else. `0` disables the cache. */
export const PROOF_TTL_MS = Number(process.env.FADE_ORCHESTRATE_PROOF_TTL_MS ?? 10_000);

let proofCache: { proof: EngineProof; at: number } | undefined;

/** The panel's proof: the last scan while it is younger than `PROOF_TTL_MS`, else a fresh one.
 *  The EMPTY scan (no engine, no router) caches too — a down router is the case that walks every
 *  pid without ever hitting the `break`, so it must not be re-walked per keystroke. The TTL is
 *  read from the env per call so a test (or an operator) can flip it without a rebuild. */
export function engineProofCached(): EngineProof {
	const ttl = Number(process.env.FADE_ORCHESTRATE_PROOF_TTL_MS ?? PROOF_TTL_MS);
	if (ttl > 0 && proofCache && Date.now() - proofCache.at < ttl) return proofCache.proof;
	proofCache = { proof: engineProof(), at: Date.now() };
	return proofCache.proof;
}

/** Drop the cached scan: a lane (re)load or a router restart changes what is RUNNING. */
export function engineProofInvalidate(): void {
	proofCache = undefined;
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
	const proof = opts.proof ?? engineProof();
	// Which serve config this row reads: the operator's explicit `FADE_ORCHESTRATE_BASALT_CONFIG`,
	// else the config the RUNNING router names in its own argv. A config the router does not serve
	// answers a question nobody asked: on this box the live config carries the lane's
	// `expert-profile-save` and a stale prod alias does not, so a panel pointed at the alias reported
	// "not configured (add expert-profile-save)" about a pack that was placing from a warm profile.
	const configPath = opts.configPath ?? proof.routerConfigPath;
	const configDerived = opts.configPath === undefined && configPath !== undefined;
	const cfg = readServeConfig(configPath);
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
	// Liveness: the caller may hand us a cmdline (the rigs' argv form, the engine's direct-launch
	// form). The knobs reach the engine through the CONFIG the router names, so the running
	// router's `--config` path is the test; the argv scan is the fallback for a direct launch.
	const argvLive = opts.liveCmdline !== undefined && opts.liveCmdline.includes("--expert-profile-save") && opts.liveCmdline.includes(savePath);
	const configIsRunning = configPath !== undefined && proof.routerConfigPath !== undefined && sameFile(proof.routerConfigPath, configPath);
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
			: configDerived
				? `live: read from the router's own --config (${configPath}); FADE_ORCHESTRATE_BASALT_CONFIG is unset`
				: undefined
		: `configured, NOT live: the running router serves ${proof.routerConfigPath ?? "no config path (a direct engine launch)"}, not ${configPath ?? "the configured path"} (reload the lane/router to apply)`;
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

/** One overlay row per lane: the "load last known MoE configuration" state. */
export function moeRows(lanes: string[], opts: { configPath?: string; liveCmdline?: string; proof?: EngineProof } = {}): { label: string; value: string }[] {
	const proof = opts.proof ?? engineProofCached();
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

/** The engine's health surface for one lane: what the expert tier spilled to, and the slots it had. */
type MoeHealth = { spill_experts?: number; spill_total?: number; spill_bytes_gb?: number; slots?: number };

export interface MoeBalance {
	lane: string;
	verdict: "balanced" | "spilled" | "single-gpu" | "unknown";
	note: string;
	/** The config's `gpu` value in its string form: `"0,1"` from `"0,1"` or `[0,1]`. */
	gpu?: string;
	/** How many cards that names — the card list's length, never a guess. */
	devices?: number;
	spill_experts?: number;
	spill_total?: number;
}

/** The serve config spells `gpu` as `"0,1"`, `[0,1]` or a bare card; every spelling yields the card count. */
const gpuDevices = (gpu: unknown): { verbatim: string; devices: number } | undefined => {
	if (typeof gpu === "string") {
		const cards = gpu.split(/[\s,]+/).filter(Boolean);
		return cards.length ? { verbatim: gpu, devices: cards.length } : undefined;
	}
	if (Array.isArray(gpu)) {
		const cards = gpu.map(String).filter((c) => c !== "" && c !== "undefined" && c !== "null");
		return cards.length ? { verbatim: cards.join(","), devices: cards.length } : undefined;
	}
	if (typeof gpu === "number" && Number.isFinite(gpu)) return { verbatim: String(gpu), devices: 1 };
	return undefined;
};

/** `vram-reserve-mib` is PER CARD: a 2048 reserve on `gpu: "0,1"` holds 2 GiB on EACH card, 4 GiB off the pair. */
const reserveClause = (model: Record<string, unknown>, devices: number): string => {
	const raw: unknown = model["vram-reserve-mib"];
	const vram = typeof raw === "number" ? raw : undefined;
	if (vram === undefined) return "";
	const gib = (mib: number) => `${+(mib / 1024).toFixed(2)} GiB`;
	return `; "vram-reserve-mib": ${vram} is per card — ${gib(vram)} on each of the ${devices} cards, ${gib(vram * devices)} held off the pair, not ${gib(vram)} total`;
};

/** A save-capable alias whose profile PREDATES the running engine places from the PREVIOUS run's map. */
const stalePlacementClause = (model: Record<string, unknown>, engineStartEpoch: () => number | undefined): string => {
	const savePath = typeof model["expert-profile-save"] === "string" ? String(model["expert-profile-save"]) : undefined;
	if (!savePath) return "";
	const start = engineStartEpoch();
	if (start === undefined) return "";
	let mtime_s: number | undefined;
	try {
		mtime_s = statSync(savePath).mtimeMs / 1000;
	} catch {
		return "";
	}
	if (mtime_s >= start) return "";
	return `; its profile PREDATES this engine's start, so placement is restored from the PREVIOUS run's map (reload the lane to relearn it)`;
};

const placementBalance = (lane: string, opts: { configPath?: string; health?: MoeHealth }, engineStartEpoch: () => number | undefined): MoeBalance => {
	const cfg = readServeConfig(opts.configPath);
	if (!cfg) {
		return { lane, verdict: "unknown", note: `no serve config to read${opts.configPath ? ` at ${opts.configPath}` : " (no config path configured)"} — placement is unjudged` };
	}
	const model = cfg.models[lane];
	if (!model) {
		return { lane, verdict: "unknown", note: `lane "${lane}" is not in ${opts.configPath} — no "gpu" / "*-reserve-mib" keys to judge` };
	}
	const gpu = gpuDevices(model.gpu);
	if (!gpu) {
		return { lane, verdict: "unknown", note: `the alias carries no "gpu" key (or an empty one): add "gpu": "0,1" to split the expert tier across the cards` };
	}
	const { verbatim, devices } = gpu;
	const health = opts.health;
	if (!health) {
		return { lane, verdict: "unknown", gpu: verbatim, devices, note: `no health reading supplied for ${lane}: spill is unmeasured, so the placement is unjudged` };
	}
	const spill = typeof health.spill_experts === "number" ? health.spill_experts : undefined;
	const reserve = reserveClause(model, devices);
	const spillTotal = health.spill_total;
	if (spill !== undefined && spill > 0) {
		return {
			lane,
			verdict: "spilled",
			gpu: verbatim,
			devices,
			spill_experts: spill,
			...(spillTotal !== undefined ? { spill_total: spillTotal } : {}),
			note: `${spill}/${spillTotal ?? "?"} experts are on the file tier${health.spill_bytes_gb !== undefined ? ` (${health.spill_bytes_gb} GB)` : ""} — experts outside VRAM are PCIe/NVMe reads per generated token, on the generation path; fit the tier to the ${devices} card(s) with "ram-reserve-mib" / "vram-reserve-mib" at the alias and the pack quant, then re-save the profile — never a bigger pack${reserve}`,
		};
	}
	const measured = { ...(spill !== undefined ? { spill_experts: spill } : {}), ...(spillTotal !== undefined ? { spill_total: spillTotal } : {}) };
	if (devices === 1) {
		return {
			lane,
			verdict: "single-gpu",
			gpu: verbatim,
			devices,
			...measured,
			note: `one card carries the whole expert tier and the second is idle for this lane: the alias sets "gpu": "${verbatim}" — widen it to "gpu": "0,1" so both cards split the tier${reserve}`,
		};
	}
	return {
		lane,
		verdict: "balanced",
		gpu: verbatim,
		devices,
		...measured,
		note: `${devices} cards carry the expert tier ("gpu": "${verbatim}") and ${
			spill === 0 ? `the health reading shows 0/${spillTotal ?? "?"} experts on the file tier` : "the file tier is UNMEASURED: the router reported no spill line, so nothing here proves the tier fits in VRAM"
		}${reserve}${stalePlacementClause(model, engineStartEpoch)}`,
	};
};

/**
 * GPU placement for one lane: the host runs 2 cards (`--gpu 0,1`), so the expert tier belongs on
 * both, sized by the reserve knobs. Absent data is NAMED, never rendered as a zero — a missing
 * health reading is not "no spill", and a missing `gpu` key is not "one card". The stale-profile
 * clause is the one live reading: `/proc` is scanned only for an alias that carries
 * `expert-profile-save`, and only to compare its profile's mtime against the engine's start.
 */
export function moeBalance(lane: string, opts: { configPath?: string; health?: MoeHealth } = {}): MoeBalance {
	// Same rule as `laneMoe`: the operator's path, else the config the RUNNING router serves.
	const configPath = opts.configPath ?? engineProofCached().routerConfigPath;
	let read = false;
	let start: number | undefined;
	return placementBalance(lane, { ...opts, configPath }, () => {
		if (!read) {
			read = true;
			start = engineProof().engineStartEpoch;
		}
		return start;
	});
}

/** One overlay row per lane: which cards carry the expert tier, and what sits on the file tier. */
export function moeBalanceRows(lanes: string[], opts: { configPath?: string; healthByLane?: Record<string, MoeHealth> } = {}): { label: string; value: string }[] {
	const proof = engineProofCached();
	return lanes.map((lane) => {
		const b = placementBalance(lane, { configPath: opts.configPath ?? proof.routerConfigPath, health: opts.healthByLane?.[lane] }, () => proof.engineStartEpoch);
		const tail =
			b.verdict === "spilled"
				? `${b.spill_experts ?? "?"}/${b.spill_total ?? "?"} experts on the file tier`
				: b.verdict === "single-gpu"
					? "second card idle"
					: b.verdict === "balanced"
						? b.spill_experts === undefined
							? "file tier UNMEASURED (router reported no spill line)"
							: "no file-tier experts"
						: b.note;
		const value = b.verdict === "unknown" ? `${b.verdict} · ${b.note}` : `${b.verdict} · gpu ${b.gpu ?? "?"} · ${b.devices ?? "?"} devices · ${tail}`;
		return { label: `MoE balance ${lane}`, value };
	});
}

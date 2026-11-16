/**
 * moe.ts unit tests: the "last known placement" states per lane, against measured engine facts
 * (docs/configuration/index.md): expert-profile-save is Flash-Next only, and a config edit is
 * not live until the lane reloads (the running cmdline is the proof).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drafterRow, engineProofCached, engineProofInvalidate, laneMoe, moeBalance, moeBalanceRows, moeRows, packDrafter } from "../.test-build/moe.mjs";

const mkConfig = (dir, models) => {
	const p = join(dir, "config.json");
	writeFileSync(p, JSON.stringify({ version: 2, models }));
	return p;
};

test("configured + live + profile present = warm start", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		const prof = join(dir, "flash.prof");
		writeFileSync(prof, "P");
		const cfg = mkConfig(dir, [{ alias: "flash-next", model: "qwen3.8.basalt", "expert-profile-save": prof }]);
		const m = laneMoe("flash-next", { configPath: cfg, liveCmdline: `basalt serve --expert-profile-save ${prof}` });
		assert.equal(m.state, "live");
		assert.equal(m.profile_exists, true);
		assert.equal(m.state, "live");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a config edit without a lane reload is configured NOT live (named, never green)", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		const cfg = mkConfig(dir, [{ alias: "flash-next", model: "qwen3.8.basalt", "expert-profile-save": join(dir, "p.prof") }]);
		const m = laneMoe("flash-next", { configPath: cfg, liveCmdline: "basalt serve --model qwen3.8.basalt" });
		assert.equal(m.state, "configured");
		assert.match(m.note, /NOT live/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Flash-Next without the save key is a named operator act", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		const cfg = mkConfig(dir, [{ alias: "flash-next", model: "qwen3.8.basalt" }]);
		const m = laneMoe("flash-next", { configPath: cfg, liveCmdline: "basalt serve" });
		assert.equal(m.state, "configured");
		assert.match(m.note, /expert-profile-save/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the verifier pack is engine-unsupported: Flash-Next only", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		const cfg = mkConfig(dir, [{ alias: "deepseek", model: "DeepSeek-V4.1-Flash.basalt" }]);
		const m = laneMoe("deepseek", { configPath: cfg, liveCmdline: "basalt serve" });
		assert.equal(m.state, "unsupported");
		assert.match(m.note, /Flash-Next only/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("moeRows renders one measured row per lane", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		const cfg = mkConfig(dir, [
			{ alias: "flash-next", model: "qwen3.8.basalt" },
			{ alias: "deepseek", model: "DeepSeek-V4.1-Flash.basalt" },
		]);
		const rows = moeRows(["flash-next", "deepseek"], { configPath: cfg, liveCmdline: "basalt serve" });
		assert.equal(rows.length, 2);
		assert.match(rows[0].value, /not configured/);
		assert.match(rows[1].value, /unsupported/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── the config-based liveness, written against the live shape ──────────────────────────────────
// A router serves models from `--config <file>`: the model knobs reach the engine through the
// CONFIG file, never argv. An argv-only liveness test calls the working lane "NOT live"; the
// running router's --config path is the test, and the profile's
// mtime against the engine process start is the write-side proof.
const liveCfg = (dir) => mkConfig(dir, [{ alias: "flash-next", model: "qwen3.8.basalt", "expert-profile-save": join(dir, "flash-next.prof"), "expert-profile-save-every": 10 }]);

test("the running router serves this config: live, with no argv flag to find", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		writeFileSync(join(dir, "flash-next.prof"), "P");
		const cfg = liveCfg(dir);
		const m = laneMoe("flash-next", { configPath: cfg, proof: { routerConfigPath: cfg } });
		assert.equal(m.state, "live");
		assert.equal(m.config_is_running, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a router serving a DIFFERENT config is configured NOT live, naming both paths", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		writeFileSync(join(dir, "flash-next.prof"), "P");
		const cfg = liveCfg(dir);
		const other = join(dir, "other.json");
		const m = laneMoe("flash-next", { configPath: cfg, proof: { routerConfigPath: other } });
		assert.equal(m.state, "configured");
		assert.match(m.note, /NOT live/);
		assert.ok(m.note.includes("other.json") && m.note.includes("config.json"), m.note);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the write side: profile mtime vs engine start decides warm-now vs warm-on-reload, in the row", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		writeFileSync(join(dir, "flash-next.prof"), "P");
		const cfg = liveCfg(dir);
		const mtime_s = statSync(join(dir, "flash-next.prof")).mtimeMs / 1000;
		assert.equal(laneMoe("flash-next", { configPath: cfg, proof: { routerConfigPath: cfg, engineStartEpoch: mtime_s - 60 } }).written_by_running_engine, true);
		const stale = laneMoe("flash-next", { configPath: cfg, proof: { routerConfigPath: cfg, engineStartEpoch: mtime_s + 3600 } });
		assert.equal(stale.written_by_running_engine, false);
		assert.match(stale.note, /PREDATES this engine/);
		assert.match(moeRows(["flash-next"], { configPath: cfg, proof: { routerConfigPath: cfg, engineStartEpoch: mtime_s - 60 } })[0].value, /written by this engine · warm start/);
		assert.match(moeRows(["flash-next"], { configPath: cfg, proof: { routerConfigPath: cfg, engineStartEpoch: mtime_s + 3600 } })[0].value, /earlier engine's file · warm on reload/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("no proof at all: configured, named, never a green", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		const cfg = liveCfg(dir);
		const m = laneMoe("flash-next", { configPath: cfg, proof: {} });
		assert.equal(m.state, "configured");
		assert.match(m.note, /no config path/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("no config path given: the row reads the config the router SERVES", () => {
	// The box's failure this closes: the live config carries the lane's `expert-profile-save` and a
	// stale prod alias does not, so a panel pointed at the alias printed "not configured (add
	// expert-profile-save, reload lane)" about a pack that was placing from a warm profile.
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		writeFileSync(join(dir, "flash-next.prof"), "P");
		const served = liveCfg(dir);
		const m = laneMoe("flash-next", { proof: { routerConfigPath: served } });
		assert.equal(m.state, "live", "the served config's save path is found with no env var at all");
		assert.equal(m.config_is_running, true);
		assert.match(m.note ?? "", /FADE_ORCHESTRATE_BASALT_CONFIG is unset/, m.note ?? "");
		// An explicit path still wins, and its NOT-live diagnosis is unchanged.
		// A DISTINCT path: `mkConfig` names its file `config.json`, and the same path as the served
		// config would make "explicit wins" and "is the served one" the same test.
		const staleAlias = join(dir, "stale-alias.json");
		writeFileSync(staleAlias, JSON.stringify({ version: 2, models: [{ alias: "flash-next", model: "qwen3.8.basalt", "expert-profile-save": join(dir, "stale.prof") }] }));
		const byHand = laneMoe("flash-next", { configPath: staleAlias, proof: { routerConfigPath: served } });
		assert.equal(byHand.state, "configured");
		assert.match(byHand.note ?? "", /NOT live/, "an explicit path wins, and reading a config the router does not serve stays named");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── GPU placement: the host runs 2 cards, so the expert tier belongs on both ──────────────────
// The serve config carries the per-alias `gpu`, `vram-reserve-mib`, `ram-reserve-mib`; the engine's
// health says what spilled to the file tier. Absent data is NAMED, never a zero: no health reading
// is not "no spill", and a missing `gpu` key is not "one card".
test("2 devices and no spill = balanced", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		const cfg = mkConfig(dir, [{ alias: "flash-next", model: "qwen3.8.basalt", gpu: "0,1", "vram-reserve-mib": 2048, "ram-reserve-mib": 65536 }]);
		const b = moeBalance("flash-next", { configPath: cfg, health: { spill_experts: 0, spill_total: 15360 } });
		assert.equal(b.verdict, "balanced");
		assert.equal(b.gpu, "0,1");
		assert.equal(b.devices, 2);
		assert.equal(b.spill_experts, 0);
		assert.ok(b.note.includes("4 GiB held off the pair"), b.note);
		const rows = moeBalanceRows(["flash-next"], { configPath: cfg, healthByLane: { "flash-next": { spill_experts: 0, spill_total: 15360 } } });
		assert.equal(rows[0].label, "MoE balance flash-next");
		assert.match(rows[0].value, /^balanced · gpu 0,1 · 2 devices · no file-tier experts$/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("no spill line in the health reading: the row never claims the tier sits in VRAM", () => {
	// The box's live shape: the router reports `spill.total` with no `spill.experts`, so the count is
	// unmeasured. The config proves the SPLIT, so the verdict stays `balanced`, and the row names the
	// file tier UNMEASURED instead of asserting "no file-tier experts" from an absent reading.
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		const cfg = mkConfig(dir, [{ alias: "flash-next", model: "qwen3.8.basalt", gpu: "0,1" }]);
		const b = moeBalance("flash-next", { configPath: cfg, health: { spill_total: 24576 } });
		assert.equal(b.verdict, "balanced");
		assert.equal(b.spill_experts, undefined);
		assert.match(b.note, /file tier is UNMEASURED/, b.note);
		const rows = moeBalanceRows(["flash-next"], { configPath: cfg, healthByLane: { "flash-next": { spill_total: 24576 } } });
		assert.match(rows[0].value, /^balanced · gpu 0,1 · 2 devices · file tier UNMEASURED \(router reported no spill line\)$/, rows[0].value);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('gpu: "0" = single-gpu, naming the config key', () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		const cfg = mkConfig(dir, [{ alias: "flash-next", model: "qwen3.8.basalt", gpu: "0" }]);
		const b = moeBalance("flash-next", { configPath: cfg, health: { spill_experts: 0, spill_total: 15360 } });
		assert.equal(b.verdict, "single-gpu");
		assert.equal(b.gpu, "0");
		assert.equal(b.devices, 1);
		assert.match(b.note, /"gpu": "0"/);
		assert.match(b.note, /second is idle/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a spill reading is spilled, naming the counts and the tier that fits the cards", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		const cfg = mkConfig(dir, [{ alias: "flash-next", model: "qwen3.8.basalt", gpu: "0,1", "vram-reserve-mib": 2048 }]);
		const b = moeBalance("flash-next", { configPath: cfg, health: { spill_experts: 2680, spill_total: 15360, spill_bytes_gb: 41 } });
		assert.equal(b.verdict, "spilled");
		assert.equal(b.spill_experts, 2680);
		assert.equal(b.spill_total, 15360);
		assert.ok(b.note.includes("2680/15360"), b.note);
		assert.match(b.note, /file tier/);
		assert.match(b.note, /PCIe\/NVMe reads per generated token/);
		assert.ok(b.note.includes("ram-reserve-mib") && b.note.includes("vram-reserve-mib"), b.note);
		assert.match(b.note, /re-save the profile/);
		assert.match(b.note, /never a bigger pack/);
		assert.match(b.note, /pack quant/);
		assert.ok(b.note.includes("4 GiB held off the pair"), b.note);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("gpu: [0,1] in array form is 2 devices, in the row's string form", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		const cfg = mkConfig(dir, [{ alias: "flash-next", model: "qwen3.8.basalt", gpu: [0, 1] }]);
		const b = moeBalance("flash-next", { configPath: cfg, health: { spill_experts: 0 } });
		assert.equal(b.verdict, "balanced");
		assert.equal(b.devices, 2);
		assert.equal(b.gpu, "0,1");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("no health reading is unknown naming itself, never a zero spill", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		const cfg = mkConfig(dir, [{ alias: "flash-next", model: "qwen3.8.basalt", gpu: "0,1" }]);
		const b = moeBalance("flash-next", { configPath: cfg });
		assert.equal(b.verdict, "unknown");
		assert.match(b.note, /no health reading/);
		assert.ok(!b.note.includes("0/0"), b.note);
		assert.equal(b.devices, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a lane absent from the config is unknown; absent numbers render as ?", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		const cfg = mkConfig(dir, [
			{ alias: "flash-next", model: "qwen3.8.basalt", gpu: "0,1" },
			{ alias: "verifier", model: "DeepSeek-V4.1-Flash.basalt" },
		]);
		const b = moeBalance("deepseek", { configPath: cfg, health: { spill_experts: 0 } });
		assert.equal(b.verdict, "unknown");
		assert.ok(b.note.includes("deepseek"), b.note);
		const rows = moeBalanceRows(["deepseek", "flash-next", "verifier"], {
			configPath: cfg,
			healthByLane: { "flash-next": { spill_experts: 2680 }, verifier: { spill_experts: 0 } },
		});
		assert.match(rows[0].value, /^unknown · lane "deepseek" is not in/);
		assert.equal(rows[1].value, "spilled · gpu 0,1 · 2 devices · 2680/? experts on the file tier");
		assert.match(rows[2].value, /^unknown · the alias carries no "gpu" key/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── the memoised /proc scan: every pid per scan, asked for per keystroke and per 2 s tick ─────
// The cache is proven on the REAL /proc: object identity for a young scan, a new object once the
// TTL is 0, a new object after an invalidation. No fs mock — a mocked scan proves nothing about
// the walk it is meant to replace.
const PROOF_TTL_ENV = "FADE_ORCHESTRATE_PROOF_TTL_MS";

const withTtl = (value, body) => {
	const prev = process.env[PROOF_TTL_ENV];
	process.env[PROOF_TTL_ENV] = value;
	engineProofInvalidate();
	try {
		body();
	} finally {
		if (prev === undefined) delete process.env[PROOF_TTL_ENV];
		else process.env[PROOF_TTL_ENV] = prev;
		engineProofInvalidate();
	}
};

test("engineProofCached: a young scan is the SAME object, so a keystroke costs no /proc walk", () => {
	withTtl("600000", () => {
		const first = engineProofCached();
		assert.equal(engineProofCached(), first);
	});
});

test("FADE_ORCHESTRATE_PROOF_TTL_MS=0 disables the cache: every call is a fresh scan", () => {
	withTtl("0", () => {
		assert.notEqual(engineProofCached(), engineProofCached());
	});
});

test("engineProofInvalidate drops the cache: the lane load / router restart sees a new scan", () => {
	withTtl("600000", () => {
		const first = engineProofCached();
		assert.equal(engineProofCached(), first);
		engineProofInvalidate();
		assert.notEqual(engineProofCached(), first);
	});
});

test("moeRows reads the cached scan by default; an explicit proof wins and never enters the cache", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	const prev = process.env[PROOF_TTL_ENV];
	process.env[PROOF_TTL_ENV] = "600000";
	engineProofInvalidate();
	try {
		writeFileSync(join(dir, "flash-next.prof"), "P");
		const cfg = liveCfg(dir);
		const mtime_s = statSync(join(dir, "flash-next.prof")).mtimeMs / 1000;
		const a = moeRows(["flash-next"], { configPath: cfg })[0].value;
		const b = moeRows(["flash-next"], { configPath: cfg })[0].value;
		assert.equal(a, b);
		// An injected proof is the caller's, used as handed: live only because THIS proof says so.
		assert.match(
			moeRows(["flash-next"], { configPath: cfg, proof: { routerConfigPath: cfg, engineStartEpoch: mtime_s - 60 } })[0].value,
			/^live · .* written by this engine · warm start$/,
		);
		// No config path in the proof = named, never a green — and it did not poison the cache.
		assert.match(moeRows(["flash-next"], { configPath: cfg, proof: {} })[0].value, /^configured, NOT live ·/);
		assert.equal(moeRows(["flash-next"], { configPath: cfg })[0].value, a);
	} finally {
		if (prev === undefined) delete process.env[PROOF_TTL_ENV];
		else process.env[PROOF_TTL_ENV] = prev;
		engineProofInvalidate();
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A v2 pack header, exactly as `include/basalt/core/model_format.hpp` lays it out. */
const mkPack = (dir, name, sections) => {
	const head = Buffer.alloc(64 + sections.length * 128);
	head.write("BASALTMF", 0, "latin1");
	head.writeUInt32LE(2, 8);
	head.writeUInt32LE(sections.length, 12);
	head.writeBigUInt64LE(BigInt(head.length), 16);
	sections.forEach((s, i) => {
		const base = 64 + i * 128;
		head.write(s.name, base, "latin1");
		head.writeBigUInt64LE(BigInt(0), base + 64);
		head.writeBigUInt64LE(BigInt(s.bytes), base + 72);
	});
	const p = join(dir, name);
	writeFileSync(p, head);
	return p;
};

test("the drafter row names DSpark from the pack header and the config's own knobs", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		const pack = mkPack(dir, "ds4.basalt", [
			{ name: "experts", bytes: 8e9 },
			{ name: "dspark/gguf", bytes: 7976914240 },
		]);
		const cfg = mkConfig(dir, [{ alias: "deepseek", model: pack, spec: 3, "draft-experts": 32 }]);
		const row = drafterRow(["deepseek"], { configPath: cfg, proof: { routerConfigPath: cfg } });
		assert.equal(row.label, "MoE drafter");
		assert.match(row.value, /^deepseek DSpark 7\.43 GiB pack · win ≤3 · 32\/stage$/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Flash-Next's MTP sections are named from the pack, and an unset spec is the engine default", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		const pack = mkPack(dir, "qfn.basalt", [
			{ name: "mtp/dense", bytes: 118111600 },
			{ name: "mtp/experts", bytes: 708837376 },
		]);
		const cfg = mkConfig(dir, [{ alias: "flash-next", model: pack }]);
		const row = drafterRow(["flash-next"], { configPath: cfg, proof: { routerConfigPath: cfg } });
		assert.match(row.value, /^flash-next MTP 0.77 GiB pack · spec engine-default · draft-experts default$/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("one row names every lane; a pack with neither drafter and an unreadable pack are named states", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-moe-"));
	try {
		const bare = mkPack(dir, "bare.basalt", [{ name: "dense", bytes: 1e9 }]);
		const cfg = mkConfig(dir, [
			{ alias: "flash-next", model: bare },
			{ alias: "deepseek", model: join(dir, "missing.basalt") },
		]);
		const row = drafterRow(["flash-next", "deepseek"], { configPath: cfg, proof: { routerConfigPath: cfg } });
		assert.match(row.value, /flash-next no drafter in pack/);
		assert.match(row.value, /deepseek pack not read/);
		assert.match(row.value, /; /);
		// No config path = nothing to read, and that is said rather than green.
		const none = drafterRow(["deepseek"], { proof: {} });
		assert.match(none.value, /deepseek pack not read/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

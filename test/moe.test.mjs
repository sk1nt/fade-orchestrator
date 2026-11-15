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
import { laneMoe, moeRows } from "../.test-build/moe.mjs";

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

// ── the config-based liveness, measured on the live shape (2026-11-15) ──────────────────────────
// The router on this desk is `python -m serve.server --config <file>`: the model knobs reach the
// engine through the CONFIG file, never argv. An argv-only liveness test called the working
// flash-next lane "NOT live"; the running router's --config path is the test, and the profile's
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

import "./env.mjs?suite=lane_session";
import { test } from "node:test";
import assert from "node:assert/strict";
const { createLaneSession } = await import(`../.test-build/lane-session.mjs?shared=${Date.now()}`);
let sequence = 0;
function fixture() {
 const levels = [], pins = [], notices = [];
 const roles = { default: "basalt/flash-next", smol: "basalt/flash-next", plan: "openai-codex/gpt-6.1-sol:high" };
 let tools = ["read", "bash", "edit", "task"], aborted = false;
 const session = `lane-unit-${process.pid}-${++sequence}`;
 const ctx = { model: { provider: "basalt", id: "flash-next" }, modelRegistry: { find: (provider, id) => ({ provider, id }) }, sessionManager: { getSessionId: () => session }, ui: { setWorkingMessage: () => {}, notify: m => notices.push(m) }, abort: () => { aborted = true; } };
 const host = { setModel: async model => { pins.push(model.id); ctx.model = model; return true; }, setThinkingLevel: level => levels.push(level), getActiveTools: () => [...tools], setActiveTools: next => { tools = [...next]; }, pi: { settings: { getModelRoles: () => ({ ...roles }), setModelRole: (role, model) => { roles[role] = model; } } } };
 return { ctx, host, roles, levels, pins, notices, tools: () => tools, aborted: () => aborted };
}
const loaded = target => ({ ok: true, served_id: target, polls: 1, refreshes: 0, failed: false, waited_s: 0, reason: "loaded" });

test("shared settings move together and restore writers after two advisor phases", async () => {
 const f = fixture(), lane = createLaneSession(f.host, { phaseTool: "fade_phase" });
 await lane.pin(f.ctx, "deepseek");
 assert.deepEqual(f.tools(), ["read", "bash", "task", "fade_phase"]);
 assert.equal(f.roles.default, "basalt/deepseek");
 assert.equal(f.roles.smol, "basalt/deepseek");
 assert.equal(f.roles.plan, "openai-codex/gpt-6.1-sol:high");
 await lane.pin(f.ctx, "hy4-flash");
 await lane.pin(f.ctx, "flash-next");
 assert.deepEqual(f.levels, ["high", "high", "low"]);
 assert.ok(f.tools().includes("edit"));
 assert.ok(!f.tools().includes("fade_phase"));
});

test("separately loaded callers restore the same session's writers and phase tool", async () => {
 const f = fixture();
 await createLaneSession(f.host, { phaseTool: "fade_phase" }).pin(f.ctx, "deepseek");
 await createLaneSession(f.host).pin(f.ctx, "flash-next");
 assert.ok(f.tools().includes("edit"));
 assert.ok(!f.tools().includes("fade_phase"));
});

test("a rejected pin changes no settings, blocks requests, and permits a successful retry", async () => {
 const f = fixture(), saved = f.host.setModel;
 f.host.setModel = async () => false;
 const lane = createLaneSession(f.host);
 await assert.rejects(lane.pin(f.ctx, "deepseek"), /did not switch/);
 assert.deepEqual(f.levels, []);
 assert.equal(f.roles.default, "basalt/flash-next");
 f.host.setModel = saved;
 assert.equal(await lane.pin(f.ctx, "deepseek"), true);
 assert.deepEqual(f.levels, ["high"]);
});

test("failed readiness aborts the actual caller turn instead of throwing through a hook runner", async () => {
 const f = fixture();
 const lane = createLaneSession(f.host, { wait: async () => ({ ...loaded("flash-next"), ok: false, failed: true, reason: "load failed" }) });
 await lane.beforeRequest(f.ctx, { payload: { model: "flash-next" } });
 assert.equal(f.aborted(), true);
 assert.match(f.notices.at(-1), /request stopped/);
});

test("a continuation built before the switch is rewritten to the proven target", async () => {
 const f = fixture(), waited = [];
 const lane = createLaneSession(f.host, { wait: async target => { waited.push(target); return loaded(target); } });
 await lane.pin(f.ctx, "hy4-flash");
 const payload = await lane.beforeRequest(f.ctx, { payload: { model: "flash-next", messages: ["unchanged"] } });
 assert.deepEqual(waited, ["hy4-flash"]);
 assert.deepEqual(payload, { model: "hy4-flash", messages: ["unchanged"] });
});

test("a superseding switch cancels the old readiness target before it can release a request", async () => {
 const f = fixture();
 let waiting, release;
 const first = new Promise(resolve => { waiting = resolve; });
 const lane = createLaneSession(f.host, { wait: async (target, opts) => {
  if (target === "deepseek") { waiting(); await new Promise(resolve => { release = resolve; }); assert.equal(opts.isCurrent(), false); }
  return loaded(target);
 } });
 await lane.pin(f.ctx, "deepseek");
 const request = lane.beforeRequest(f.ctx, { payload: { model: "deepseek" } });
 await first;
 await lane.pin(f.ctx, "flash-next");
 release();
 assert.equal((await request).model, "flash-next");
 assert.equal(f.aborted(), false);
});

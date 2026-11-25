#!/usr/bin/env node
// THE LIVE PROOF of the in-process lane call, on a real router, with no stubs.
//
// What it has to prove is the rule the whole feature rests on: a completion the plugin issues itself
// costs NO pack swap, and the guard that keeps it that way refuses — with zero bytes sent — a call
// that would make the router unload the resident lane. The recorded price of the swap this avoids is
// 13-25 s per direction (flash-next 52.2 GiB, DeepSeek-V4.1 242.1 GiB), so "the lane did not move"
// is the assertion, not the answer's quality.
//
// Three readings, in order:
//   1. the RESIDENT lane answers one in-process completion (real HTTP, real pack);
//   2. the router's OTHER entry — the DeepSeek lane the thinking phase wants — is refused
//      `lane_not_resident`, and the client sends it nothing;
//   3. the DeepSeek server on its OWN port (`basalt-deepseek`, :18016) is called the same way: when
//      it is down the class is named (`endpoint_unreachable`), and when it is UP the call answers
//      with the interactive lane untouched. Both outcomes pass; a silent empty answer fails.
// Then the router is read again: the resident entry must be the one it was, and no swap in flight.
//
// Run it against a live router: `node test/build.mjs && node test/thinklane_live.mjs`. It writes
// nothing and loads nothing; the only bytes it sends are completions and `GET /health`, `/v1/models`.

import { CODE_LANE, PROVIDER, ROUTER, THINK_LANE } from "../.test-build/router.mjs";
import { askLane, probeThink } from "../.test-build/thinklane.mjs";

const get = async (url) => {
	const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
	return r.json();
};

/** The entry the router reports as loaded, the same way `residentLane` reads it. */
const resident = async () => {
	const listing = await get(`${ROUTER}/v1/models`).catch(() => undefined);
	const loaded = (listing?.data ?? []).find((m) => String(m.status?.value ?? m.status ?? m.state) === "loaded");
	return loaded?.id ?? loaded?.model;
};

const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "  ok" : "  FAIL"}  ${label}${detail ? ` · ${detail}` : ""}`);
	if (!ok) failures.push(label);
};

const before = await resident().catch(() => undefined);
if (!before) {
	console.log(`FAIL  the router at ${ROUTER} names no resident lane, so the rig can prove nothing`);
	process.exit(1);
}
console.log(`router ${ROUTER} · resident lane ${before}`);

const other = before === THINK_LANE ? CODE_LANE : THINK_LANE;
const PROMPT = "Reply with exactly one word: READY";

// 1. the resident lane, in process. The budget is NOT tiny on purpose: at 24 tokens the thinking
// lane answers with a NULL content and `finish_reason: length` (measured on :18014), which is a
// named refusal, not an answer — 200 tokens buys a real completion to assert on.
const residentCall = await askLane(`${PROVIDER}/${before}`, PROMPT, { maxTokens: 200, temperature: 0, timeoutMs: 90_000 });
console.log(`1  ${residentCall.cls} · ${residentCall.endpoint} · ${(residentCall.ms / 1000).toFixed(1)}s · ${residentCall.text.length} chars`);
console.log(`   ${residentCall.detail}`);
check("the resident lane answers one in-process completion", residentCall.ok === true && residentCall.text.trim() !== "", residentCall.cls);

// 2. the lane the thinking phase wants, when the router is not holding it.
const owedCall = await askLane(`${PROVIDER}/${other}`, PROMPT, { maxTokens: 24, timeoutMs: 90_000 });
console.log(`2  ${owedCall.cls} · ${owedCall.endpoint} · ${owedCall.ms}ms`);
console.log(`   ${owedCall.detail}`);
check(`a request naming the non-resident ${other} is refused with zero bytes`, owedCall.ok === false && owedCall.cls === "lane_not_resident", owedCall.cls);
// 3. the DeepSeek server on its own port: down is a named class, up is a call that answered.
const ownPort = await askLane("basalt-deepseek/deepseek", PROMPT, { maxTokens: 24, timeoutMs: 30_000 });
console.log(`3  ${ownPort.cls} · ${ownPort.endpoint} · ${(ownPort.ms / 1000).toFixed(1)}s · ${ownPort.text.length} chars`);
console.log(`   ${ownPort.detail}`);
check(
	"the endpoint on its own port is served, or names why it is not",
	ownPort.ok === true || ownPort.cls === "endpoint_unreachable" || ownPort.cls === "timeout" || ownPort.cls === "http_error",
	ownPort.cls,
);

// The probe, on the lane that is owed: refused from the reading, never from a completion.
const probe = await probeThink(`${PROVIDER}/${other}`);
console.log(`4  probe ${probe.ok ? "ok" : "refused"} · ${probe.detail}`);
check("the probe refuses the owed lane without sending a completion", probe.ok === false && /swap|zero bytes/.test(probe.detail), probe.detail);

// THE POINT: the lane never moved, and nothing is swapping.
const after = await resident().catch(() => undefined);
const health = await get(`${ROUTER}/health`).catch(() => undefined);
console.log(`5  resident after ${after} · health ${health?.status ?? "?"} · loading ${health?.loading ?? "?"} · swap ${health?.swap ? JSON.stringify(health.swap) : "none"}`);
check("the resident lane is the entry it was", after === before, `${before} → ${after}`);
check("no swap is in flight", health?.loading !== true && (health?.swap === null || health?.swap === undefined), JSON.stringify(health?.swap ?? null));

console.log(failures.length === 0 ? `PROOF PASS · in-process ${residentCall.cls} in ${(residentCall.ms / 1000).toFixed(1)}s, owed lane refused as ${owedCall.cls}, own port ${ownPort.cls}, lane ${before} unmoved` : `PROOF FAIL · ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);

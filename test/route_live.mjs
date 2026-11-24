#!/usr/bin/env node
// route_live.mjs — the swap seam, proven against the LIVE lane.
//
// loadLane with the DEFAULT swap command (no FADE_ORCHESTRATE_SWAP_CMD): the resident pack must
// answer through the fast path, "already resident; no swap issued" — the plugin never POSTs
// /v1/load itself any more, and no lease is burned for a pack that is already serving.
//
// Guarded skip (the `make model-test` convention): no lane answering /health with a loaded pack
// prints SKIP and exits 0 — a down router is never graded as a failure, and this proof never
// requests a pack the lane does not already host.
import assert from "node:assert/strict";

const { loadLane, listLanes } = await import("../.test-build/router.mjs");

const lanes = await listLanes();
const resident = lanes.models.find((m) => m.status === "loaded");
if (!resident) {
	console.log(`SKIP: no loaded pack on ${process.env.FADE_ORCHESTRATE_ROUTER ?? "http://127.0.0.1:18014"} (${lanes.health}); the seam needs a live lane`);
	process.exit(0);
}
const r = await loadLane(resident.id);
assert.equal(r.ok, true, `a resident pack must land as ok (${r.detail})`);
assert.ok(r.detail.includes("already resident; no swap issued"), `the fast path must say so (${r.detail})`);
console.log(`route live: ${resident.id} resident, plugin loadLane paid ZERO load — ${r.detail}`);

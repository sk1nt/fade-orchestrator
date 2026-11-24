#!/usr/bin/env node
// The rigs' stand-in for basalt-ctl.sh. The plugin now routes every lane swap through the
// swap command (FADE_ORCHESTRATE_SWAP_CMD); the rigs keep their fake routers and their
// POST /v1/load counters by pointing that seam here. The contract it emulates is the ctl's:
// rc 0 with the LAST stdout line naming the requested pack means the pack is resident;
// a router that refuses answers non-zero with the class on stderr.
import { readFile } from "node:fs/promises";

const jobPath = process.argv[2];
if (!jobPath) {
	console.error("swap_stub: usage: swap_stub.mjs <job.json>");
	process.exit(2);
}
const job = JSON.parse(await readFile(jobPath, "utf8"));
const router = process.env.FADE_ORCHESTRATE_ROUTER ?? "http://127.0.0.1:18014";
try {
	const r = await fetch(`${router}/v1/load`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: job.model }),
		signal: AbortSignal.timeout(240_000),
	});
	const text = await r.text();
	if (!r.ok) {
		console.error(`swap_stub: http ${r.status} ${text.slice(0, 200)}`);
		process.exit(1);
	}
	console.log(job.model);
} catch (e) {
	console.error(`swap_stub: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

/**
 * The extension must LOAD behind a hostile host.
 *
 * omp 18.20.2 hands an extension factory a LOADING-PHASE proxy whose property `get` of a guarded
 * action method throws `Extension runtime not initialized. Action methods cannot be called during
 * extension loading.` — the same throw as calling it. A throw inside the factory body fails the
 * load, and the measured cost in a live operator session (2026-11-15) was the whole surface at
 * once: no status row, no panel, no `/orchestrate`, no `fade_phase` tool, because every
 * `registerTool`/`registerCommand` below the throw never runs. The session's log carried only
 * `Warning: Failed to load extension …/fade_orchestrate.ts: Extension runtime not initialized. …`.
 *
 * So the contract this test pins: the factory completes behind a proxy that throws for guarded
 * reads, the phase tool and the commands are registered anyway, and a chord the host holds is
 * SKIPPED by the shortcut registration instead of killing the load.
 */
const GUARDED = new Set([
	"setModel",
	"getActiveTools",
	"setActiveTools",
	"sendUserMessage",
	"getShortcuts",
	"getShortcutConflict",
]);

const LOADING_THROW = "Extension runtime not initialized. Action methods cannot be called during extension loading.";

test("a loading-phase proxy cannot disable the extension: the tool and commands still register", async () => {
	const built = new URL("../.test-build/index.mjs", import.meta.url);
	assert.ok(existsSync(built), "run `node test/build.mjs` first (npm test builds it)");

	// FADE_KEY and FALLBACK_KEY are read at module load: point the primary chord at a chord the
	// fake host holds, so the registration path under test is the refused one.
	process.env.FADE_ORCHESTRATE_KEY = "ctrl+o";
	process.env.FADE_ORCHESTRATE_FALLBACK_KEY = "alt+shift+i";

	const registered = { tools: [], commands: [], shortcuts: [], events: [] };
	const base = {
		registerTool: (tool) => void registered.tools.push(tool?.name),
		registerCommand: (name) => void registered.commands.push(name),
		registerShortcut: (key) => {
			if (key === "ctrl+o") throw new Error("Extension shortcut conflicts with built-in shortcut");
			registered.shortcuts.push(key);
		},
		on: (event) => void registered.events.push(event),
	};
	const pi = new Proxy(base, {
		get(target, prop) {
			if (typeof prop === "string" && GUARDED.has(prop)) throw new Error(LOADING_THROW);
			return target[prop];
		},
	});

	const { default: factory } = await import(built.href);
	factory(pi); // the defect: this line threw, and the load died with it

	assert.ok(registered.tools.includes("fade_phase"), `phase tool must register: ${JSON.stringify(registered.tools)}`);
	for (const command of ["orchestrate", "lanes"]) {
		assert.ok(registered.commands.includes(command), `/${command} must register: ${JSON.stringify(registered.commands)}`);
	}
	assert.ok(registered.shortcuts.includes("alt+shift+i"), `the free fallback chord registers: ${JSON.stringify(registered.shortcuts)}`);
	assert.ok(!registered.shortcuts.includes("ctrl+o"), `the host-held chord is skipped, not registered: ${JSON.stringify(registered.shortcuts)}`);
	for (const event of ["session_start", "agent_start", "agent_end"]) {
		assert.ok(registered.events.includes(event), `the ${event} hook binds: ${JSON.stringify(registered.events)}`);
	}
});

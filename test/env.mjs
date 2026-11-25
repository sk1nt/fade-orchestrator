/**
 * The suites that assert lane IDENTITY must not inherit the operator's live lane config.
 *
 * The router module resolves PROVIDER / THINK_LANE / CODE_LANE from process.env at module import,
 * so a shell parked on one lane (this box runs FADE_ORCHESTRATE_THINK_LANE=flash-next for
 * single-lane mode) silently redefines ROUTER_ENTRIES: `isRouterModel("deepseek")` answers false and
 * the router-entry test goes red with NO change to the code under test. Import this module FIRST in
 * such a suite — ESM evaluates imports in declaration order, so the deletes land before the bundle
 * is evaluated — and the suite measures the documented defaults in every environment.
 */
export const LANE_ENV_DEFAULTS = {
	FADE_ORCHESTRATE_PROVIDER: "strata-flash",
	FADE_ORCHESTRATE_THINK_LANE: "deepseek",
	FADE_ORCHESTRATE_CODE_LANE: "flash-next",
	FADE_ORCHESTRATE_VERIFIER_MODEL: "ninfer-local/coder-gpu1",
};

for (const k of [
	"FADE_ORCHESTRATE_PROVIDER",
	"FADE_ORCHESTRATE_THINK_LANE",
	"FADE_ORCHESTRATE_CODE_LANE",
	"FADE_ORCHESTRATE_SWAP_VIA",
	"FADE_ORCHESTRATE_VERIFIER_MODEL",
	"FADE_ORCHESTRATE_BASALT_CONFIG",
]) {
	delete process.env[k];
}

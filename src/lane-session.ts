/** One session switchover path for Frontier and the orchestrator. */
import { CODE_LANE, PROVIDER, THINKING, isServedLane, isThinkingLane, laneServeHold, type ServeHold } from "./router.ts";
import { packToModelId } from "./supervisor.ts";

export const MUTATING_TOOLS: Record<string, true> = { edit: true, write: true, apply_patch: true, multiedit: true, multi_edit: true, notebook_edit: true };

type Model = { provider: string; id: string };
type Context = {
 model?: Model;
 modelRegistry: { find(provider: string, id: string): any };
 sessionManager?: { getSessionId(): string };
 ui: { setWorkingMessage(message?: string): void; notify(message: string, type?: "info" | "warning" | "error"): void };
 abort?: () => unknown;
 signal?: AbortSignal;
};
type Host = {
 setModel(model: any): Promise<unknown>;
 setThinkingLevel(level: any): unknown;
 getActiveTools?: () => string[];
 setActiveTools?: (tools: string[]) => unknown;
 pi?: { settings?: { getModelRoles(): Record<string, string | undefined>; setModelRole(role: string, model: string): unknown } };
};
type State = { tools?: string[]; phaseTool?: string; target?: string; generation: number; failure?: string; serial: Promise<unknown> };
// Both installed extensions can be bundled independently. Share session state across those bundles.
const key = Symbol.for("fade.lane-session.v1");
const globals = globalThis as unknown as Record<symbol, Map<string, State>>;
const sessions = globals[key] ??= new Map<string, State>();

export function createLaneSession(host: Host, options: { phaseTool?: string; wait?: typeof laneServeHold } = {}) {
 const wait = options.wait ?? laneServeHold;
 const local: State = { generation: 0, serial: Promise.resolve() };
 const stateFor = (ctx: Context): State => {
  const id = ctx.sessionManager?.getSessionId?.();
  if (!id) return local;
  let state = sessions.get(id);
  if (!state) { state = { generation: 0, serial: Promise.resolve() }; sessions.set(id, state); }
  return state;
 };
 const pin = async (ctx: Context, pack: string): Promise<boolean> => {
  const id = packToModelId(pack);
  if (!isServedLane(id)) throw new Error(`unconfigured lane ${id}`);
  const model = ctx.modelRegistry.find(PROVIDER, id);
  if (!model) throw new Error(`model ${PROVIDER}/${id} is not in the registry`);
  const state = stateFor(ctx);
  // The load is the pin's trigger, never the session's current choice: every
  // switch must re-pin, so a repeated same-lane switch cannot be answered by a
  // short-circuit. The ready() call waits for the target to serve, not for the
  // pin to have fired once per lane.
  const generation = ++state.generation;
  const job = state.serial.catch(() => undefined).then(async () => {
   if (generation !== state.generation) return false;
   const switched = await host.setModel(model);
   if (switched !== true && !(typeof switched === "object" && switched !== null && (switched as { switched?: boolean }).switched === true))
    throw new Error(`setModel(${PROVIDER}/${id}) did not switch`);
   if (generation !== state.generation) return false;
   host.setThinkingLevel(THINKING[id]);
   // Retarget only roles already on this local provider; explicit cloud roles stay selected.
   const settings = host.pi?.settings;
   if (settings) {
    for (const [role, selector] of Object.entries(settings.getModelRoles())) {
     if (typeof selector !== "string" || !selector.startsWith(`${PROVIDER}/`)) continue;
     const current = selector.slice(PROVIDER.length + 1).split(":")[0];
     if (isServedLane(current)) await settings.setModelRole(role, `${PROVIDER}/${id}`);
    }
   }
   if (host.getActiveTools && host.setActiveTools) {
    const active = host.getActiveTools();
    state.phaseTool ??= options.phaseTool;
    let next: string[];
    if (isThinkingLane(id)) {
     state.tools ??= [...active];
     next = active.filter(t => MUTATING_TOOLS[t] !== true && t !== state.phaseTool);
     if (options.phaseTool) next.push(options.phaseTool);
    } else {
     next = [...new Set([...(state.tools ?? []), ...active])].filter(t => !state.phaseTool || t !== state.phaseTool);
    }
    if (next.length !== active.length || next.some(t => !active.includes(t))) await host.setActiveTools(next);
    if (id === CODE_LANE) { state.tools = undefined; state.phaseTool = undefined; }
   }
   state.target = id;
   state.failure = undefined;
   return true;
  });
  state.serial = job;
  try { return await job; }
  catch (error) {
   if (generation === state.generation) { state.failure = String(error); ctx.abort?.(); }
   throw error;
  }
 };
 const ready = async (ctx: Context, target: string, opts: Parameters<typeof laneServeHold>[1] = {}): Promise<ServeHold> => {
  let painted = false;
  try {
   return await wait(target, { ...opts, progress: (message, percent) => {
    painted = true;
    ctx.ui.setWorkingMessage(message);
    opts.progress?.(message, percent);
   } });
  } finally { if (painted) ctx.ui.setWorkingMessage(); }
 };
 const beforeRequest = async (ctx: Context, event: unknown): Promise<unknown> => {
  if (ctx.model?.provider !== PROVIDER) return;
  const payload = (event as { payload?: { model?: unknown } } | undefined)?.payload;
  const wire = typeof payload?.model === "string" ? packToModelId(payload.model) : ctx.model.id;
  if (!isServedLane(wire)) return;
  const state = stateFor(ctx);
  for (;;) {
   await state.serial.catch(() => undefined);
   if (ctx.signal?.aborted) return;
   if (state.failure) {
    ctx.abort?.();
    ctx.ui.notify(`lane settings are unavailable: ${state.failure}; request stopped`, "warning");
    return;
   }
   const generation = state.generation;
   const target = state.target ?? wire;
   const result = await ready(ctx, target, { isCurrent: () => generation === state.generation && !ctx.signal?.aborted });
   if (ctx.signal?.aborted) return;
   if (generation !== state.generation) continue;
   if (!result.ok) {
    // The hook runner catches exceptions. Abort explicitly so the host sends no payload.
    ctx.abort?.();
    ctx.ui.notify(`lane ${target} is unavailable: ${result.reason}; request stopped`, "warning");
    return;
   }
   if (payload && target !== wire) return { ...payload, model: target };
   return;
  }
 };
 return { pin, ready, beforeRequest };
}

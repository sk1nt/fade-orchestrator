import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** Frontier's journal also reflects slash-command settlement, which has no tool result. */
export async function readFrontierPhase(sessionId: string | undefined, root?: string): Promise<string | undefined> {
	if (!sessionId || basename(sessionId) !== sessionId) return undefined;
	const override = process.env.OMP_FRONTIER_ROOT?.trim();
	const directory = join(root ?? (override ? resolve(override) : join(homedir(), ".omp", "frontier")), sessionId);
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "none" : undefined;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			const task = JSON.parse(await readFile(join(directory, entry.name, "task.json"), "utf8"));
			if (typeof task?.taskId === "string" && typeof task.rounds === "number" && typeof task.phase === "string" && frontierIsActive(task.phase)) return task.phase;
		} catch {
			// An incomplete task file is ignored by Frontier's own loader as well.
		}
	}
	return "none";
}

/** Read the phase recorded by Frontier's tool result without depending on its implementation. */
export function frontierPhase(details: unknown): string | undefined {
	const frontier = details && typeof details === "object" && "frontier" in details ? details.frontier : undefined;
	const phase = frontier && typeof frontier === "object" && "phase" in frontier ? frontier.phase : undefined;
	return typeof phase === "string" ? phase : undefined;
}

export function frontierPhaseFromHistory(entries: readonly unknown[]): string | undefined {
	for (const entry of [...entries].reverse()) {
		if (!entry || typeof entry !== "object" || !("message" in entry)) continue;
		const message = entry.message;
		if (!message || typeof message !== "object" || !("toolName" in message) || message.toolName !== "frontier") continue;
		const phase = frontierPhase("details" in message ? message.details : undefined);
		if (phase !== undefined) return phase;
	}
	return undefined;
}

export function frontierIsActive(phase: string | undefined): boolean {
	return phase !== undefined && !["none", "done", "denied", "aborted"].includes(phase);
}

/** Queue one handover until the host can accept it. Cancellation also fences async reads. */
export function queueHandover(options: {
	isCurrent: () => boolean;
	isIdle: () => boolean;
	build: () => Promise<string>;
	deliver: (message: string) => void;
	onDelivered: () => void;
	onError: (error: unknown) => void;
	delayMs?: number;
}): () => void {
	let canceled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let reportedError = false;
	const current = () => !canceled && options.isCurrent();
	const schedule = () => {
		if (!current()) return;
		timer = setTimeout(() => void attempt(), options.delayMs ?? 250);
		timer.unref();
	};
	const attempt = async () => {
		if (!current()) return;
		try {
			if (!options.isIdle()) {
				schedule();
				return;
			}
			const message = await options.build();
			if (!current()) return;
			if (!options.isIdle()) {
				schedule();
				return;
			}
			options.deliver(message);
		} catch (error) {
			if (!current()) return;
			if (!reportedError) {
				reportedError = true;
				options.onError(error);
			}
			schedule();
			return;
		}
		canceled = true;
		options.onDelivered();
	};
	schedule();
	return () => {
		canceled = true;
		clearTimeout(timer);
	};
}

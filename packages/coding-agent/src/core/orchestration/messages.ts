import type { Event, RunState } from "@void/orchestrator";

export const VOID_SPAWN_CUSTOM_TYPE = "void:spawn";
export const VOID_SPAWN_STATE_CUSTOM_TYPE = "void:spawn-state";

export interface VoidSpawnMessageDetails {
	childSessionId: string;
}

export interface VoidSubagentResult extends Event {
	kind: "subagentResult";
	childSessionId: string;
	state: Exclude<RunState, "pending" | "running">;
	text: string;
	elapsed: number;
}

export interface VoidSpawnState {
	version: 1;
	parentSessionId: string;
	childSessionId: string;
	runId: string;
	provider: string;
	childName?: string;
	state: RunState;
	result?: VoidSubagentResult;
}

export function isVoidSpawnMessageDetails(value: unknown): value is VoidSpawnMessageDetails {
	return isRecord(value) && typeof value.childSessionId === "string" && value.childSessionId !== "";
}

export function isVoidSpawnState(value: unknown): value is VoidSpawnState {
	if (
		!(
			isRecord(value) &&
			value.version === 1 &&
			isNonemptyString(value.parentSessionId) &&
			isNonemptyString(value.childSessionId) &&
			isNonemptyString(value.runId) &&
			isNonemptyString(value.provider) &&
			(value.childName === undefined || typeof value.childName === "string") &&
			isRunState(value.state)
		)
	) {
		return false;
	}
	const terminal = value.state === "done" || value.state === "failed" || value.state === "cancelled";
	return terminal ? isVoidSubagentResult(value.result, value) : value.result === undefined;
}

export function voidSpawnStateKey(state: Pick<VoidSpawnState, "runId" | "state">): string {
	return `${state.runId}:${state.state}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonemptyString(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

function isVoidSubagentResult(value: unknown, state: Record<string, unknown>): value is VoidSubagentResult {
	return (
		isRecord(value) &&
		value.kind === "subagentResult" &&
		value.childSessionId === state.childSessionId &&
		value.state === state.state &&
		typeof value.text === "string" &&
		typeof value.elapsed === "number" &&
		Number.isFinite(value.elapsed) &&
		value.elapsed >= 0 &&
		(value.childName === undefined || typeof value.childName === "string")
	);
}

function isRunState(value: unknown): value is RunState {
	return value === "pending" || value === "running" || value === "done" || value === "failed" || value === "cancelled";
}

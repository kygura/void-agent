/**
 * Harness subsystem: programmatically invoke external CLI coding agents
 * (`claude -p`, `codex exec`, generic templates) as child processes,
 * normalize their output into one HarnessEvent stream, and track/persist
 * runs and sessions with resume support.
 */

export { ClaudeHarness, claudeArgs, parseClaudeLine } from "./claude.js";
export { CodexHarness, codexArgs, parseCodexLine } from "./codex.js";
export {
	finalizeGeneric,
	GenericHarness,
	type GenericHarnessConfig,
	genericArgs,
	parseGenericLine,
} from "./generic.js";
export { type Finalize, finalizeStructured, type ParseLine, runHarnessProc } from "./glue.js";
export type { ProcHandle, ProcResult, ProcSpec } from "./proc.js";
export { spawnProc } from "./proc.js";
export {
	type HarnessEventListener,
	type HarnessRun,
	type HarnessRunEvent,
	HarnessRunManager,
	type HarnessRunState,
	type HarnessSession,
	HarnessSessionStore,
	type LoadedHarnessSession,
	type SubmitPromptResult,
} from "./runs.js";
export type { Harness, HarnessEvent, HarnessEventKind, HarnessRunConfig, HarnessUsage } from "./types.js";
export { nowIso } from "./types.js";
export { VoidHarness, type VoidSpawnConfig } from "./void.js";

import { ClaudeHarness } from "./claude.js";
import { CodexHarness } from "./codex.js";
import type { Harness } from "./types.js";

/** Returns the built-in, first-class harnesses (claude, codex). Generic harnesses are config-driven — see GenericHarness. */
export function createDefaultHarnesses(): Harness[] {
	return [new ClaudeHarness(), new CodexHarness()];
}

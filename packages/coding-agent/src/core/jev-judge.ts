/**
 * Adapts `@void/jev`'s tool-call judge to the permission gate.
 *
 * Kept separate from `permissions.ts` so the gate stays provider-neutral: any `PermissionJudge`
 * can screen calls, and Jev is one implementation of it.
 */

import { createToolCallJudge, JEV_API_KEY_ENV, JevClient } from "@void/jev";
import type { PermissionJudge } from "./permissions.js";
import type { PermissionJudgeSettings } from "./settings-manager.js";

export type JevJudgeSetup = { judge: PermissionJudge; model: string } | { error: string };

export interface JevJudgeOverrides {
	apiKey?: string;
	fetch?: typeof fetch;
}

/** Build a Jev-backed judge from settings, or explain why it cannot be built. */
export function createJevPermissionJudge(
	settings: PermissionJudgeSettings,
	overrides: JevJudgeOverrides = {},
): JevJudgeSetup {
	const key = overrides.apiKey ?? process.env[JEV_API_KEY_ENV];
	if (!key) {
		return { error: `permissions.judge is enabled but ${JEV_API_KEY_ENV} is not set; using normal prompts` };
	}

	const client = new JevClient({
		apiKey: key,
		...(settings.model ? { model: settings.model } : {}),
		...(settings.timeoutMs !== undefined ? { timeoutMs: settings.timeoutMs } : {}),
		...(overrides.fetch ? { fetch: overrides.fetch } : {}),
	});
	const judgeCall = createToolCallJudge(client, {
		policy: {
			...(settings.allowConfidence !== undefined ? { allowConfidence: settings.allowConfidence } : {}),
			...(settings.rejectConfidence !== undefined ? { rejectConfidence: settings.rejectConfidence } : {}),
		},
	});

	const judge: PermissionJudge = async (request, signal) => {
		const verdict = await judgeCall(
			{
				toolName: request.toolName,
				args: request.args,
				cwd: request.cwd,
				...(request.intent ? { intent: request.intent } : {}),
				...(request.origin ? { origin: request.origin } : {}),
			},
			signal,
		);
		return { decision: verdict.decision, reason: verdict.reason, source: verdict.model };
	};

	return { judge, model: client.model };
}

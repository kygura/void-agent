/**
 * Opt-in interactive permission gating for mutating tool calls.
 *
 * Default is auto-approve: with no settings change and no approver attached the gate is
 * disabled and `check()` returns "allow" without ever suspending.
 *
 * Security posture: when gating IS enabled the gate fails CLOSED. Any path that cannot reach
 * a human (no approver attached, approver threw, approver returned garbage) denies the call
 * rather than allowing it. Denial is always prompt - the gate never blocks forever, so a
 * headless or background caller degrades to a readable tool error instead of a deadlock.
 */

/**
 * Built-in tools that mutate state outside the agent's own transcript.
 *
 * - `edit` / `write`: write to the filesystem.
 * - `bash`: arbitrary command execution; the widest mutation surface there is.
 * - `subagent` / `subagent_send`: start or steer a child agent that itself gets edit/write/bash.
 *   Gating the spawn point is not sufficient on its own (children are gated individually too),
 *   but an ungated spawn lets the model launch work the user never saw described.
 *
 * Deliberately NOT gated (read-only, no side effects outside the transcript):
 * `read`, `grep`, `find`, `ls`, `web_search`, `subagent_output`.
 */
export const MUTATING_TOOL_NAMES: readonly string[] = ["edit", "write", "bash", "subagent", "subagent_send"];

export function isMutatingTool(toolName: string): boolean {
	return MUTATING_TOOL_NAMES.includes(toolName);
}

/** A single pending approval request handed to the UI. */
export interface PermissionRequest {
	toolName: string;
	args: Record<string, unknown>;
	/** Working directory the call runs against, for rendering paths. */
	cwd: string;
	/**
	 * Label of the agent that asked. Undefined for the top-level session; set to the child's
	 * agent name when a subagent's request is escalated to the parent's queue.
	 */
	origin?: string;
}

/**
 * - `allow`: run this call only.
 * - `always`: run it, and stop asking for this tool for the rest of the session (persisted).
 * - `deny`: block this call; sibling calls in the same batch still prompt.
 * - `cancel`: block this call AND abort the whole turn.
 */
export type PermissionDecision = "allow" | "always" | "deny" | "cancel";

export type PermissionApprover = (request: PermissionRequest, signal?: AbortSignal) => Promise<PermissionDecision>;

export interface PermissionGateOptions {
	enabled: boolean;
	/** Tool names pre-approved via a previous "always allow". */
	alwaysAllow?: string[];
	/** Persist a newly added "always allow" entry. */
	onAlwaysAllow?: (toolName: string) => void;
}

export interface PermissionCheckResult {
	allowed: boolean;
	/** Model-readable reason, present only when blocked. */
	reason?: string;
}

const DENY_REASON = "Denied by user. Do not retry this call; ask the user how to proceed.";
const CANCEL_REASON = "Turn cancelled by user.";
const NO_APPROVER_REASON =
	"Permission required but no interactive approver is available. Denied. " +
	"Disable permission gating or run this in an interactive session.";

/**
 * Session-scoped gate. One instance is shared by a parent session and every in-process
 * subagent child it spawns, so a child's request lands in the parent's approval queue.
 */
export class PermissionGate {
	private enabled: boolean;
	private readonly alwaysAllow: Set<string>;
	private readonly onAlwaysAllow?: (toolName: string) => void;
	private approver?: PermissionApprover;
	/** Serializes prompts so a parallel batch queues instead of racing the UI. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(options: PermissionGateOptions) {
		this.enabled = options.enabled;
		this.alwaysAllow = new Set(options.alwaysAllow ?? []);
		this.onAlwaysAllow = options.onAlwaysAllow;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	/** Attach the interactive approver. Without one an enabled gate denies everything. */
	setApprover(approver: PermissionApprover | undefined): void {
		this.approver = approver;
	}

	hasApprover(): boolean {
		return this.approver !== undefined;
	}

	isAlwaysAllowed(toolName: string): boolean {
		return this.alwaysAllow.has(toolName);
	}

	/**
	 * Decide whether a tool call may run.
	 *
	 * Returns immediately (no suspension, no queueing) for the disabled-gate, non-mutating,
	 * and already-always-allowed cases, so the default configuration costs one Set lookup.
	 */
	async check(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionCheckResult> {
		if (!this.enabled) return { allowed: true };
		if (!isMutatingTool(request.toolName)) return { allowed: true };
		if (this.alwaysAllow.has(request.toolName)) return { allowed: true };
		if (signal?.aborted) return { allowed: false, reason: CANCEL_REASON };
		if (!this.approver) return { allowed: false, reason: NO_APPROVER_REASON };

		const decision = await this.enqueue(request, signal);

		switch (decision) {
			case "always":
				this.alwaysAllow.add(request.toolName);
				this.onAlwaysAllow?.(request.toolName);
				return { allowed: true };
			case "allow":
				return { allowed: true };
			case "cancel":
				// Aborting the turn is the approver's job: it owns the session handle and the UI.
				return { allowed: false, reason: CANCEL_REASON };
			default:
				return { allowed: false, reason: DENY_REASON };
		}
	}

	/**
	 * Run one approval at a time.
	 *
	 * `executeToolCallsParallel` preflights every call in an assistant message before running
	 * any of them, so several checks land here back to back. Chaining onto a single queue makes
	 * the UI show them one after another instead of stacking modals.
	 *
	 * The chain is kept unbroken on failure (`.then(run, run)`) so one rejected prompt cannot
	 * wedge every later request.
	 */
	private enqueue(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionDecision> {
		const run = async (): Promise<PermissionDecision> => {
			// Re-check between queued prompts: an earlier "always allow" or "cancel" in the same
			// batch can settle this one without asking again.
			if (this.alwaysAllow.has(request.toolName)) return "allow";
			if (signal?.aborted) return "cancel";
			try {
				const decision = await this.race(request, signal);
				// Fail closed on an approver that returns something unexpected.
				return decision === "allow" || decision === "always" || decision === "cancel" || decision === "deny"
					? decision
					: "deny";
			} catch {
				// Fail closed on approver error (including abort). Never allow, never hang.
				return signal?.aborted ? "cancel" : "deny";
			}
		};

		const result = this.queue.then(run, run);
		this.queue = result;
		return result;
	}

	/**
	 * Resolve as soon as EITHER the user decides or the signal aborts.
	 *
	 * The approver is responsible for tearing down its own UI on abort, but racing here means a
	 * mid-prompt cancel resolves this promise promptly even if the approver is slow to notice.
	 */
	private race(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionDecision> {
		const approver = this.approver;
		if (!approver) return Promise.resolve("deny");
		if (!signal) return approver(request);

		return new Promise<PermissionDecision>((resolve, reject) => {
			const onAbort = () => resolve("cancel");
			signal.addEventListener("abort", onAbort, { once: true });
			approver(request, signal)
				.then(resolve, reject)
				.finally(() => signal.removeEventListener("abort", onAbort));
		});
	}
}

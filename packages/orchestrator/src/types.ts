/** A Go-compatible RFC 3339 timestamp as written on the wire. */
export type Timestamp = string;

/** An elapsed Go time.Duration represented as integer nanoseconds on the wire. */
export type Nanoseconds = number;

export type EventKind = "started" | "text" | "thinking" | "tool" | "result" | "exit" | "subagentResult";

export interface Usage {
	inputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
}

/** One flat normalized event. Irrelevant optional fields are omitted when serialized. */
export interface Event {
	kind: EventKind;
	providerSessionId?: string;
	text?: string;
	tool?: string;
	detail?: string;
	done?: boolean;
	isError?: boolean;
	usage?: Usage;
	exitCode?: number;
	childSessionId?: string;
	childName?: string;
	state?: RunState;
	elapsed?: Nanoseconds;
}

export type Effort = "default" | "low" | "medium" | "high";
export type ExplicitEffort = Exclude<Effort, "default">;

/** The Go-compatible auth mode. An omitted or empty value means automatic mode. */
export type AuthMode = "" | "auto" | "subscription" | "api";

export type ProviderType = "claude" | "codex" | "generic" | "mock";

export interface RunConfig {
	provider: string;
	prompt: string;
	workdir?: string;
	model?: string;
	effort?: ExplicitEffort | "";
	extraArgs?: readonly string[];
	env?: readonly string[];
	/** Environment keys removed after configured entries overlay the parent environment. */
	envDenyList?: readonly string[];
	providerSessionId?: string;
}

/** The raw normalized stream parser seam used by process-backed Providers. */
export interface Adapter {
	parseLine(line: string): readonly Event[];
	finish(exitCode: number): readonly Event[];
}

export interface Provider {
	readonly name: string;
	readonly type?: ProviderType;
	readonly resumable?: boolean;
	start(config: RunConfig, signal?: AbortSignal): AsyncIterable<Event>;
}

export interface ResumableProvider extends Provider {
	readonly resumable: boolean;
}

export interface AuthInfo {
	loggedIn: boolean;
	authMethod?: string;
	subscribed?: boolean;
}

export interface AuthLoginResult {
	started: boolean;
	message?: string;
}

export interface AuthAdapter {
	status(signal?: AbortSignal): Promise<AuthInfo>;
	login(signal?: AbortSignal): Promise<AuthLoginResult>;
}

export type RunState = "pending" | "running" | "done" | "failed" | "cancelled";

export const RUN_STATES = {
	pending: "pending",
	running: "running",
	done: "done",
	failed: "failed",
	cancelled: "cancelled",
} as const satisfies Record<RunState, RunState>;

export interface RunSnapshot {
	id: string;
	name?: string;
	provider: string;
	sessionId?: string;
	providerSessionId?: string;
	state: RunState;
	startedAt: Timestamp;
	endedAt?: Timestamp;
	lastActivityAt?: Timestamp;
	prompt: string;
	model?: string;
	effort?: ExplicitEffort;
	finalText?: string;
	usage?: Usage;
}

export type Run = RunSnapshot;

export interface PromptQueueState {
	prompts: readonly string[];
	activeRunId?: string;
}

export type PromptQueueSnapshot = PromptQueueState;

export interface SessionSnapshot {
	id: string;
	provider: string;
	providerSessionId?: string;
	model?: string;
	effort?: ExplicitEffort;
	workdir?: string;
	name?: string;
	parentSessionId?: string;
	created: Timestamp;
	runIds: readonly string[];
	queue: PromptQueueState;
}

export type Session = SessionSnapshot;

export interface TaskRunSnapshot extends RunSnapshot {
	/** TaskRuns are process-lifetime and therefore have no Session ID. */
	sessionId?: never;
}

export type TaskRun = TaskRunSnapshot;

export interface RunEvent {
	runId: string;
	event?: Event;
	state: RunState;
	lifecycle?: boolean;
	warning?: string;
}

export type OrchestratorEvent = RunEvent;

export type SubscriptionListener = (event: OrchestratorEvent) => void;

export interface Subscription {
	unsubscribe(): void;
}

export interface OrchestratorState {
	runs: readonly RunSnapshot[];
	sessions: readonly SessionSnapshot[];
	taskRuns: readonly TaskRunSnapshot[];
	defaultProvider: string;
	closing: boolean;
}

export interface ProviderConfig {
	type: ProviderType;
	command?: string;
	args?: readonly string[];
	model?: string;
	modelFlag?: string;
	effort?: Effort;
	effortFlag?: string;
	models?: readonly string[];
	extraArgs?: readonly string[];
	env?: readonly string[];
	auth?: AuthMode;
}

export interface OrchestratorConfig {
	defaultProvider: string;
	providers: Readonly<Record<string, ProviderConfig>>;
}

export interface ConfigError {
	path: string;
	code: "invalid-type" | "missing" | "invalid-value" | "unknown-field" | "invalid-json";
	message: string;
}

export interface ConfigParseSuccess {
	ok: true;
	config: OrchestratorConfig;
	errors: readonly [];
}

export interface ConfigParseFailure {
	ok: false;
	errors: readonly ConfigError[];
}

export type ConfigParseResult = ConfigParseSuccess | ConfigParseFailure;

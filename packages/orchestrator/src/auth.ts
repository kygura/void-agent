import { spawnProcess } from "./process.js";
import { isRecord, stringValue, validateExecutable } from "./provider-utils.js";
import type { AuthAdapter, AuthInfo, AuthLoginResult, AuthMode } from "./types.js";

export type ChildAuthKind = "claude" | "codex";

export interface CommandOutput {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

export type CommandRunner = (argv: readonly string[], signal?: AbortSignal) => Promise<CommandOutput>;
export type LoginStarter = (
	kind: ChildAuthKind,
	argv: readonly string[],
	signal?: AbortSignal,
) => Promise<AuthLoginResult>;

export interface ChildAuthAdapterOptions {
	readonly command?: string;
	readonly run?: CommandRunner;
	readonly startLogin?: LoginStarter;
	readonly statusTimeoutMs?: number;
}

export class AuthCache {
	private readonly values = new Map<string, AuthInfo>();

	public get(name: string): AuthInfo | undefined {
		const value = this.values.get(name);
		return value === undefined ? undefined : { ...value };
	}

	public getOr(name: string): AuthInfo {
		return this.get(name) ?? { loggedIn: false };
	}

	public set(name: string, info: AuthInfo): void {
		this.values.set(name, { ...info });
	}
}

export class ChildAuthAdapter implements AuthAdapter {
	private readonly command: string;
	private readonly run: CommandRunner;
	private readonly startLogin: LoginStarter;
	private readonly statusTimeoutMs: number;

	public constructor(
		private readonly kind: ChildAuthKind,
		options: ChildAuthAdapterOptions = {},
	) {
		this.command = options.command ?? kind;
		validateExecutable(this.command);
		this.run = options.run ?? runCapturedCommand;
		this.startLogin = options.startLogin ?? startDetachedLogin;
		this.statusTimeoutMs = options.statusTimeoutMs ?? 20_000;
	}

	public async status(signal?: AbortSignal): Promise<AuthInfo> {
		const controller = new AbortController();
		const abort = () => controller.abort(signal?.reason);
		if (signal?.aborted === true) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => controller.abort(new Error("auth status timed out")), this.statusTimeoutMs);
		try {
			const output = await this.run(buildAuthStatusArgv(this.kind, this.command), controller.signal);
			return this.kind === "claude"
				? parseClaudeAuthStatus(output.stdout)
				: parseCodexAuthStatus(`${output.stdout}\n${output.stderr}`);
		} catch {
			return { loggedIn: false };
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
	}

	public async login(signal?: AbortSignal): Promise<AuthLoginResult> {
		try {
			return await this.startLogin(this.kind, buildAuthLoginArgv(this.kind, this.command), signal);
		} catch (error) {
			return { started: false, message: error instanceof Error ? error.message : String(error) };
		}
	}
}

export function createChildAuthAdapter(kind: ChildAuthKind, options: ChildAuthAdapterOptions = {}): ChildAuthAdapter {
	return new ChildAuthAdapter(kind, options);
}

export function buildAuthStatusArgv(kind: ChildAuthKind, command: string = kind): readonly string[] {
	return kind === "claude" ? [command, "auth", "status"] : [command, "login", "status"];
}

export function buildAuthLoginArgv(kind: ChildAuthKind, command: string = kind): readonly string[] {
	return kind === "claude" ? [command, "auth", "login"] : [command, "login", "--device-auth"];
}

export function parseClaudeAuthStatus(data: string): AuthInfo {
	let value: unknown;
	try {
		value = JSON.parse(data) as unknown;
	} catch {
		return { loggedIn: false };
	}
	if (!isRecord(value) || value.loggedIn !== true) return { loggedIn: false };
	const authMethod = stringValue(value, "authMethod");
	return {
		loggedIn: true,
		...(authMethod === undefined ? {} : { authMethod }),
		subscribed: authMethod === "claude.ai",
	};
}

/** Negative status lines win before affirmative, line-scoped classification. */
export function parseCodexAuthStatus(data: string): AuthInfo {
	const lines = data.toLowerCase().split(/\r?\n/);
	if (lines.some((line) => line.includes("not logged in"))) return { loggedIn: false };
	for (const line of lines) {
		if (!line.includes("logged in")) continue;
		if (line.includes("chatgpt")) return { loggedIn: true, authMethod: "chatgpt", subscribed: true };
		if (line.includes("api key")) return { loggedIn: true, authMethod: "apikey", subscribed: false };
	}
	return { loggedIn: false };
}

export function effectiveAuthMode(configured: AuthMode | undefined, info: AuthInfo): "subscription" | "api" {
	if (configured === "subscription") return "subscription";
	if (configured === "api") return "api";
	return info.subscribed === true ? "subscription" : "api";
}

export async function runCapturedCommand(argv: readonly string[], signal?: AbortSignal): Promise<CommandOutput> {
	const handle = spawnProcess({ argv }, signal);
	const lines: string[] = [];
	for await (const line of handle.lines) lines.push(line);
	const result = await handle.result;
	return { stdout: lines.join("\n"), stderr: result.stderrTail, exitCode: result.exitCode };
}

async function startDetachedLogin(
	_kind: ChildAuthKind,
	argv: readonly string[],
	signal?: AbortSignal,
): Promise<AuthLoginResult> {
	const handle = spawnProcess({ argv }, signal);
	if (handle.pid === undefined) {
		const result = await handle.result;
		return { started: false, message: result.error?.message ?? "could not start login" };
	}
	void (async () => {
		for await (const _line of handle.lines) {
			// Login output is intentionally drained but never logged.
		}
		await handle.result;
	})();
	return { started: true };
}

/** A credential-adjacent JSON store seam suitable for fake keychains in tests. */
export interface KeychainBackend {
	read(service: string, account: string, signal?: AbortSignal): Promise<string | undefined>;
	write(service: string, account: string, value: string, signal?: AbortSignal): Promise<void>;
	delete(service: string, account: string, signal?: AbortSignal): Promise<void>;
}

export class JsonKeychainStore {
	public constructor(
		private readonly backend: KeychainBackend,
		private readonly service: string,
		private readonly account: string,
	) {
		if (service === "" || account === "") throw new Error("keychain service and account are required");
	}

	public async update(
		mutate: (current: Record<string, unknown>) => Record<string, unknown> | undefined,
		signal?: AbortSignal,
	): Promise<void> {
		throwIfAborted(signal);
		const raw = await this.backend.read(this.service, this.account, signal);
		let current: Record<string, unknown> = {};
		if (raw !== undefined && raw !== "") {
			const parsed = JSON.parse(raw) as unknown;
			if (!isRecord(parsed)) throw new Error("keychain credential payload must be a JSON object");
			current = { ...parsed };
		}
		const replacement = mutate(current);
		throwIfAborted(signal);
		await this.backend.write(this.service, this.account, JSON.stringify(replacement ?? current), signal);
	}

	public delete(signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		return this.backend.delete(this.service, this.account, signal);
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error("operation aborted");
}

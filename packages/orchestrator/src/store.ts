import { chmod, mkdir, open, readdir, readFile } from "node:fs/promises";
import { basename, join, win32 } from "node:path";
import type { Event, RunState, Timestamp, Usage } from "./types.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const GO_ZERO_TIMESTAMP = "0001-01-01T00:00:00Z";
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export interface SessionMeta {
	id: string;
	provider: string;
	providerSessionId?: string;
	name?: string;
	parentSessionId?: string;
	created: Timestamp;
}

export interface StoredRecord {
	runId: string;
	event: Event;
}

export interface StoredSession {
	meta: SessionMeta;
	records: readonly StoredRecord[];
	prompts: ReadonlyMap<string, string>;
	warning?: string;
}

/** The persistence seam; JSONL paths, file handles, and serialization stay private. */
export interface SessionStore {
	list(): Promise<readonly string[]>;
	load(sessionId: string): Promise<StoredSession>;
	appendMeta(meta: SessionMeta): Promise<void>;
	appendPrompt(sessionId: string, runId: string, prompt: string): Promise<void>;
	appendEvent(sessionId: string, runId: string, event: Event): Promise<void>;
}

interface WireMeta {
	id: string;
	provider: string;
	providerSessionId?: string;
	name?: string;
	parentSessionId?: string;
	created?: Timestamp;
}

interface WireUsage {
	inputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
}

interface WireEvent {
	kind: string;
	providerSessionId?: string;
	text?: string;
	tool?: string;
	detail?: string;
	done?: boolean;
	isError?: boolean;
	usage?: WireUsage;
	exitCode?: number;
	childSessionId?: string;
	childName?: string;
	state?: string;
	elapsed?: number;
}

type SerializedOperation = Promise<void>;

class AppendSessionStore implements SessionStore {
	readonly #directory: string;
	readonly #sessionTails = new Map<string, SerializedOperation>();

	constructor(directory: string) {
		this.#directory = directory;
	}

	async list(): Promise<readonly string[]> {
		const entries = await readdir(this.#directory, { withFileTypes: true });
		return entries
			.filter((entry) => !entry.isDirectory() && entry.name.endsWith(".json"))
			.map((entry) => entry.name.slice(0, -".json".length))
			.sort();
	}

	load(sessionId: string): Promise<StoredSession> {
		return this.#serialize(sessionId, async () => {
			const contents = await readFile(this.#path(sessionId), "utf8");
			return decodeSession(sessionId, contents);
		});
	}

	appendMeta(meta: SessionMeta): Promise<void> {
		return this.#appendLine(meta.id, encodeMetaLine(meta));
	}

	appendPrompt(sessionId: string, runId: string, prompt: string): Promise<void> {
		return this.#appendLine(sessionId, encodePromptLine(runId, prompt));
	}

	appendEvent(sessionId: string, runId: string, event: Event): Promise<void> {
		return this.#appendLine(sessionId, encodeEventLine(runId, event));
	}

	#path(sessionId: string): string {
		return join(this.#directory, `${sessionId}.json`);
	}

	#appendLine(sessionId: string, line: string): Promise<void> {
		return this.#serialize(sessionId, async () => {
			const file = await open(this.#path(sessionId), "a+", FILE_MODE);
			try {
				if (process.platform !== "win32") await file.chmod(FILE_MODE);
				const size = (await file.stat()).size;
				let separator = "";
				if (size > 0) {
					const lastByte = new Uint8Array(1);
					const { bytesRead } = await file.read(lastByte, 0, 1, size - 1);
					if (bytesRead === 1 && lastByte[0] !== 0x0a) separator = "\n";
				}
				await file.writeFile(`${separator}${line}\n`, "utf8");
			} finally {
				await file.close();
			}
		});
	}

	#serialize<Result>(sessionId: string, operation: () => Promise<Result>): Promise<Result> {
		if (!isSafeSessionId(sessionId)) return Promise.reject(new Error("store: invalid session id"));
		const previous = this.#sessionTails.get(sessionId) ?? Promise.resolve();
		const result = previous.catch(() => undefined).then(operation);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.#sessionTails.set(sessionId, tail);
		void tail.then(() => {
			if (this.#sessionTails.get(sessionId) === tail) this.#sessionTails.delete(sessionId);
		});
		return result;
	}
}

function isSafeSessionId(sessionId: string): boolean {
	return (
		sessionId !== "" &&
		sessionId !== "." &&
		sessionId !== ".." &&
		!sessionId.includes("\0") &&
		sessionId === basename(sessionId) &&
		sessionId === win32.basename(sessionId)
	);
}

export async function createSessionStore(directory: string): Promise<SessionStore> {
	await mkdir(directory, { mode: DIRECTORY_MODE, recursive: true });
	if (process.platform !== "win32") await chmod(directory, DIRECTORY_MODE);
	return new AppendSessionStore(directory);
}

function encodeMetaLine(meta: SessionMeta): string {
	const encoded: WireMeta = { id: meta.id, provider: meta.provider };
	assignNonemptyString(encoded, "providerSessionId", meta.providerSessionId);
	assignNonemptyString(encoded, "name", meta.name);
	assignNonemptyString(encoded, "parentSessionId", meta.parentSessionId);
	encoded.created = assertTimestamp(meta.created);
	return JSON.stringify({ meta: encoded });
}

function encodePromptLine(runId: string, prompt: string): string {
	const line: { runId?: string; prompt?: string } = {};
	assignNonemptyString(line, "runId", runId);
	assignNonemptyString(line, "prompt", prompt);
	return JSON.stringify(line);
}

function encodeEventLine(runId: string, event: Event): string {
	const line: { runId?: string; event: WireEvent } = { event: encodeEvent(event) };
	if (runId !== "") line.runId = runId;
	return JSON.stringify(orderRunEventLine(line));
}

function orderRunEventLine(line: { runId?: string; event: WireEvent }): { runId?: string; event: WireEvent } {
	return line.runId === undefined ? { event: line.event } : { runId: line.runId, event: line.event };
}

function encodeEvent(event: Event): WireEvent {
	const encoded: WireEvent = { kind: event.kind };
	assignNonemptyString(encoded, "providerSessionId", event.providerSessionId);
	assignNonemptyString(encoded, "text", event.text);
	assignNonemptyString(encoded, "tool", event.tool);
	assignNonemptyString(encoded, "detail", event.detail);
	if (event.done === true) encoded.done = true;
	if (event.isError === true) encoded.isError = true;
	if (event.usage !== undefined) encoded.usage = encodeUsage(event.usage);
	assignNonzeroInteger(encoded, "exitCode", event.exitCode);
	assignNonemptyString(encoded, "childSessionId", event.childSessionId);
	assignNonemptyString(encoded, "childName", event.childName);
	assignNonemptyString(encoded, "state", event.state);
	assignNonzeroInteger(encoded, "elapsed", event.elapsed);
	return encoded;
}

function encodeUsage(usage: Usage): WireUsage {
	const encoded: WireUsage = {};
	assignNonzeroInteger(encoded, "inputTokens", usage.inputTokens);
	assignNonzeroInteger(encoded, "outputTokens", usage.outputTokens);
	if (usage.costUsd !== undefined && usage.costUsd !== 0) {
		if (!Number.isFinite(usage.costUsd)) throw new TypeError("store: usage.costUsd must be finite");
		encoded.costUsd = usage.costUsd;
	}
	return encoded;
}

function assignNonemptyString<ObjectType extends object, Key extends keyof ObjectType>(
	target: ObjectType,
	key: Key,
	value: ObjectType[Key] | undefined,
): void {
	if (typeof value === "string" && value !== "") target[key] = value;
}

function assignNonzeroInteger<ObjectType extends object, Key extends keyof ObjectType>(
	target: ObjectType,
	key: Key,
	value: ObjectType[Key] | undefined,
): void {
	if (typeof value !== "number" || value === 0) return;
	if (!Number.isSafeInteger(value)) throw new TypeError(`store: ${String(key)} must be a safe integer`);
	target[key] = value;
}

function assertTimestamp(timestamp: Timestamp): Timestamp {
	if (!RFC3339_PATTERN.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
		throw new TypeError("store: created must be an RFC 3339 timestamp");
	}
	return timestamp;
}

function decodeSession(sessionId: string, contents: string): StoredSession {
	let meta: SessionMeta = { id: sessionId, provider: "", created: GO_ZERO_TIMESTAMP };
	const records: StoredRecord[] = [];
	const prompts = new Map<string, string>();
	let skipped = 0;

	for (const rawLine of contents.split("\n")) {
		const trimmed = rawLine.trim();
		if (trimmed === "") continue;
		try {
			const decoded = decodeLine(trimmed);
			if (decoded.meta !== undefined) {
				meta = { ...decoded.meta, id: sessionId };
			} else if (decoded.event !== undefined) {
				records.push({ runId: decoded.runId, event: decoded.event });
			} else if (decoded.prompt !== "") {
				prompts.set(decoded.runId, decoded.prompt);
			}
		} catch {
			skipped++;
		}
	}

	const warning = skipped === 0 ? undefined : `store: session ${sessionId}: skipped ${skipped} corrupt line(s)`;
	return warning === undefined ? { meta, records, prompts } : { meta, records, prompts, warning };
}

interface DecodedLine {
	meta?: SessionMeta;
	runId: string;
	prompt: string;
	event?: Event;
}

function decodeLine(line: string): DecodedLine {
	const parsed: unknown = JSON.parse(line);
	if (parsed === null) return { runId: "", prompt: "" };
	const object = requireObject(parsed);
	const runId = readString(object, "runId");
	const prompt = readString(object, "prompt");
	const meta = decodeMeta(object.meta);
	const event = decodeEvent(object.event);
	return { runId, prompt, ...(meta === undefined ? {} : { meta }), ...(event === undefined ? {} : { event }) };
}

function decodeMeta(value: unknown): SessionMeta | undefined {
	if (value === undefined || value === null) return undefined;
	const object = requireObject(value);
	return {
		id: readString(object, "id"),
		provider: readString(object, "provider"),
		...readOptionalNonemptyString(object, "providerSessionId"),
		...readOptionalNonemptyString(object, "name"),
		...readOptionalNonemptyString(object, "parentSessionId"),
		created: readTimestamp(object, "created"),
	};
}

function decodeEvent(value: unknown): Event | undefined {
	if (value === undefined || value === null) return undefined;
	const object = requireObject(value);
	const usage = decodeUsage(object.usage);
	const kind = readString(object, "kind") as Event["kind"];
	const state = readString(object, "state") as RunState | "";
	return {
		kind,
		...readOptionalNonemptyString(object, "providerSessionId"),
		...readOptionalNonemptyString(object, "text"),
		...readOptionalNonemptyString(object, "tool"),
		...readOptionalNonemptyString(object, "detail"),
		...(readBoolean(object, "done") ? { done: true } : {}),
		...(readBoolean(object, "isError") ? { isError: true } : {}),
		...(usage === undefined ? {} : { usage }),
		...readOptionalNonzeroInteger(object, "exitCode"),
		...readOptionalNonemptyString(object, "childSessionId"),
		...readOptionalNonemptyString(object, "childName"),
		...(state === "" ? {} : { state }),
		...readOptionalNonzeroInteger(object, "elapsed"),
	};
}

function decodeUsage(value: unknown): Usage | undefined {
	if (value === undefined || value === null) return undefined;
	const object = requireObject(value);
	const costUsd = readNumber(object, "costUsd");
	return {
		...readOptionalNonzeroInteger(object, "inputTokens"),
		...readOptionalNonzeroInteger(object, "outputTokens"),
		...(costUsd === 0 ? {} : { costUsd }),
	};
}

function requireObject(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("not an object");
	return value as Record<string, unknown>;
}

function readString(object: Record<string, unknown>, key: string): string {
	const value = object[key];
	if (value === undefined || value === null) return "";
	if (typeof value !== "string") throw new TypeError(`${key} is not a string`);
	return value;
}

function readOptionalNonemptyString<Key extends string>(
	object: Record<string, unknown>,
	key: Key,
): Partial<Record<Key, string>> {
	const value = readString(object, key);
	return value === "" ? {} : ({ [key]: value } as Record<Key, string>);
}

function readBoolean(object: Record<string, unknown>, key: string): boolean {
	const value = object[key];
	if (value === undefined || value === null) return false;
	if (typeof value !== "boolean") throw new TypeError(`${key} is not a boolean`);
	return value;
}

function readNumber(object: Record<string, unknown>, key: string): number {
	const value = object[key];
	if (value === undefined || value === null) return 0;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${key} is not a number`);
	return value;
}

function readOptionalNonzeroInteger<Key extends string>(
	object: Record<string, unknown>,
	key: Key,
): Partial<Record<Key, number>> {
	const value = readNumber(object, key);
	if (!Number.isSafeInteger(value)) throw new TypeError(`${key} is not a safe integer`);
	return value === 0 ? {} : ({ [key]: value } as Record<Key, number>);
}

function readTimestamp(object: Record<string, unknown>, key: string): Timestamp {
	const value = object[key];
	if (value === undefined || value === null) return GO_ZERO_TIMESTAMP;
	if (typeof value !== "string") throw new TypeError(`${key} is not a timestamp`);
	return assertTimestamp(value);
}

/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 */

import { getEnvApiKey, type OAuthCredentials, type OAuthLoginCallbacks, type OAuthProviderId } from "@void/ai";
import { getOAuthApiKey, getOAuthProvider, getOAuthProviders } from "@void/ai/oauth";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.js";
import { readCliOAuthCredentials } from "./cli-credentials.js";
import { resolveConfigValue } from "./resolve-config-value.js";

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthStorageData = Record<string, AuthCredential>;

/**
 * Reserved top-level key in auth.json holding provider ids the user explicitly
 * logged out of. It is stripped from the credential map on load and re-attached
 * on save, so it never reaches `list()`, `has()` or `getAll()`. Files written
 * before this key existed simply parse to an empty opt-out list.
 */
const CLI_FALLBACK_OPT_OUT_KEY = "$cliFallbackOptOut";

type ParsedAuthFile = {
	credentials: AuthStorageData;
	optOut: string[];
};

type LockResult<T> = {
	result: T;
	next?: string;
};

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	constructor(private authPath: string = join(getAgentDir(), "auth.json")) {}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, "{}", "utf-8");
			chmodSync(this.authPath, 0o600);
		}
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.authPath);
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeFileSync(this.authPath, next, "utf-8");
				chmodSync(this.authPath, 0o600);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await lockfile.lock(this.authPath, {
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10000,
					randomize: true,
				},
				stale: 30000,
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

			throwIfCompromised();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			if (next !== undefined) {
				writeFileSync(this.authPath, next, "utf-8");
				chmodSync(this.authPath, 0o600);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage {
	private data: AuthStorageData = {};
	private runtimeOverrides: Map<string, string> = new Map();
	private fallbackResolver?: (provider: string) => string | undefined;
	private cliCredentials: Map<string, OAuthCredential | null> = new Map();
	/** Providers the user logged out of; their CLI fallback stays disabled. */
	private cliFallbackOptOut: Set<string> = new Set();
	private loadError: Error | null = null;
	private errors: Error[] = [];

	private constructor(private storage: AuthStorageBackend) {
		this.reload();
	}

	static create(authPath?: string): AuthStorage {
		return new AuthStorage(new FileAuthStorageBackend(authPath ?? join(getAgentDir(), "auth.json")));
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	/**
	 * Set a fallback resolver for API keys not found in auth.json or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
	}

	private parseAuthFile(content: string | undefined): ParsedAuthFile {
		if (!content) {
			return { credentials: {}, optOut: [] };
		}
		const { [CLI_FALLBACK_OPT_OUT_KEY]: optOut, ...credentials } = JSON.parse(content) as Record<string, unknown>;
		return {
			credentials: credentials as AuthStorageData,
			optOut: Array.isArray(optOut) ? optOut.filter((id): id is string => typeof id === "string") : [],
		};
	}

	private serializeAuthFile(file: ParsedAuthFile): string {
		const out: Record<string, unknown> = { ...file.credentials };
		if (file.optOut.length > 0) {
			out[CLI_FALLBACK_OPT_OUT_KEY] = file.optOut;
		}
		return JSON.stringify(out, null, 2);
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		this.cliCredentials.clear();
		let content: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				return { result: undefined };
			});
			const file = this.parseAuthFile(content);
			this.data = file.credentials;
			this.cliFallbackOptOut = new Set(file.optOut);
			this.loadError = null;
		} catch (error) {
			this.loadError = error as Error;
			this.recordError(error);
		}
	}

	/**
	 * Persist a credential change, and with it whether the provider's CLI
	 * fallback stays opted out. Logout opts out (durably, so a borrowed
	 * credential cannot silently come back); login opts back in.
	 */
	private persistProviderChange(provider: string, credential: AuthCredential | undefined, optOut: boolean): void {
		if (this.loadError) {
			return;
		}

		try {
			this.storage.withLock((current) => {
				const file = this.parseAuthFile(current);
				if (credential) {
					file.credentials[provider] = credential;
				} else {
					delete file.credentials[provider];
				}
				const others = file.optOut.filter((id) => id !== provider);
				file.optOut = optOut ? [...others, provider] : others;
				return { result: undefined, next: this.serializeAuthFile(file) };
			});
		} catch (error) {
			this.recordError(error);
		}
	}

	/**
	 * Credential from an installed CLI (Claude Code, Codex), cached per process.
	 * Read-only: these are never written back to their origin file.
	 *
	 * Single choke point for the fallback, so `get()`, `hasAuth()` and
	 * `getApiKey()` cannot disagree about an opted-out provider.
	 */
	private cliCredential(provider: string): OAuthCredential | undefined {
		if (this.cliFallbackOptOut.has(provider)) {
			return undefined;
		}
		const cached = this.cliCredentials.get(provider);
		if (cached !== undefined && (cached === null || Date.now() < cached.expires)) {
			return cached ?? undefined;
		}
		const credentials = readCliOAuthCredentials(provider);
		const credential: OAuthCredential | null = credentials ? { type: "oauth", ...credentials } : null;
		this.cliCredentials.set(provider, credential);
		return credential ?? undefined;
	}

	/**
	 * Get credential for a provider.
	 * Falls back to an installed CLI's credentials when void has none of its own.
	 */
	get(provider: string): AuthCredential | undefined {
		return this.data[provider] ?? this.cliCredential(provider);
	}

	/**
	 * Set credential for a provider.
	 */
	set(provider: string, credential: AuthCredential): void {
		this.data[provider] = credential;
		this.cliFallbackOptOut.delete(provider);
		this.persistProviderChange(provider, credential, false);
	}

	/**
	 * Remove credential for a provider. Also opts the provider out of the CLI
	 * fallback: without that, logout would report success while `get()` kept
	 * handing back another CLI's borrowed token.
	 */
	remove(provider: string): void {
		delete this.data[provider];
		this.cliFallbackOptOut.add(provider);
		this.persistProviderChange(provider, undefined, true);
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.keys(this.data);
	}

	/**
	 * Check if credentials exist for a provider in auth.json.
	 */
	has(provider: string): boolean {
		return provider in this.data;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		if (this.runtimeOverrides.has(provider)) return true;
		if (this.data[provider]) return true;
		if (getEnvApiKey(provider)) return true;
		if (this.cliCredential(provider)) return true;
		if (this.fallbackResolver?.(provider)) return true;
		return false;
	}

	/**
	 * Get all credentials (for passing to getOAuthApiKey).
	 */
	getAll(): AuthStorageData {
		return { ...this.data };
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			throw new Error(`Unknown OAuth provider: ${providerId}`);
		}

		const credentials = await provider.login(callbacks);
		this.set(providerId, { type: "oauth", ...credentials });
	}

	/**
	 * Logout from a provider.
	 */
	logout(provider: string): void {
		this.remove(provider);
	}

	/**
	 * Refresh OAuth token with backend locking to prevent race conditions.
	 * Multiple pi instances may try to refresh simultaneously when tokens expire.
	 */
	private async refreshOAuthTokenWithLock(
		providerId: OAuthProviderId,
	): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			return null;
		}

		const result = await this.storage.withLockAsync(async (current) => {
			const file = this.parseAuthFile(current);
			const currentData = file.credentials;
			this.data = currentData;
			this.cliFallbackOptOut = new Set(file.optOut);
			this.loadError = null;

			const cred = currentData[providerId];
			if (cred?.type !== "oauth") {
				return { result: null };
			}

			if (Date.now() < cred.expires) {
				return { result: { apiKey: provider.getApiKey(cred), newCredentials: cred } };
			}

			const oauthCreds: Record<string, OAuthCredentials> = {};
			for (const [key, value] of Object.entries(currentData)) {
				if (value.type === "oauth") {
					oauthCreds[key] = value;
				}
			}

			const refreshed = await getOAuthApiKey(providerId, oauthCreds);
			if (!refreshed) {
				return { result: null };
			}

			const merged: AuthStorageData = {
				...currentData,
				[providerId]: { type: "oauth", ...refreshed.newCredentials },
			};
			this.data = merged;
			this.loadError = null;
			return { result: refreshed, next: this.serializeAuthFile({ credentials: merged, optOut: file.optOut }) };
		});

		return result;
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. API key from auth.json
	 * 3. OAuth token from auth.json (auto-refreshed with locking)
	 * 4. Environment variable
	 * 5. OAuth token from an installed CLI's own credential file (read-only)
	 * 6. Fallback resolver (models.json custom providers)
	 */
	async getApiKey(providerId: string, options?: { includeFallback?: boolean }): Promise<string | undefined> {
		// Runtime override takes highest priority
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey) {
			return runtimeKey;
		}

		const cred = this.data[providerId];

		if (cred?.type === "api_key") {
			return resolveConfigValue(cred.key);
		}

		if (cred?.type === "oauth") {
			const provider = getOAuthProvider(providerId);
			if (!provider) {
				// Unknown OAuth provider, can't get API key
				return undefined;
			}

			// Check if token needs refresh
			const needsRefresh = Date.now() >= cred.expires;

			if (needsRefresh) {
				// Use locked refresh to prevent race conditions
				try {
					const result = await this.refreshOAuthTokenWithLock(providerId);
					if (result) {
						return result.apiKey;
					}
				} catch (error) {
					this.recordError(error);
					// Refresh failed - re-read file to check if another instance succeeded
					this.reload();
					const updatedCred = this.data[providerId];

					if (updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
						// Another instance refreshed successfully, use those credentials
						return provider.getApiKey(updatedCred);
					}

					// Refresh truly failed - return undefined so model discovery skips this provider
					// User can /login to re-authenticate (credentials preserved for retry)
					return undefined;
				}
			} else {
				// Token not expired, use current access token
				return provider.getApiKey(cred);
			}
		}

		// Fall back to environment variable
		const envKey = getEnvApiKey(providerId);
		if (envKey) return envKey;

		// Fall back to an account already logged into an installed CLI (read-only).
		// Expired CLI tokens are reported as absent, so no refresh happens here.
		const cliCred = this.cliCredential(providerId);
		const cliProvider = cliCred ? getOAuthProvider(providerId) : undefined;
		if (cliCred && cliProvider) {
			return cliProvider.getApiKey(cliCred);
		}

		// Fall back to custom resolver (e.g., models.json custom providers)
		if (options?.includeFallback !== false) {
			return this.fallbackResolver?.(providerId) ?? undefined;
		}

		return undefined;
	}

	/**
	 * Get all registered OAuth providers
	 */
	getOAuthProviders() {
		return getOAuthProviders();
	}
}

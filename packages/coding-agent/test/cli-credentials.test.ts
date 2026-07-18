import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { readCliOAuthCredentials } from "../src/core/cli-credentials.js";

const HOUR_MS = 60 * 60 * 1000;

/** Minimal unsigned JWT carrying only the `exp` claim, as Codex tokens do. */
function jwt(expSeconds: number): string {
	const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
	return `header.${payload}.signature`;
}

describe("CLI credential fallback", () => {
	let tempDir: string;
	let claudeDir: string;
	let codexDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `void-test-cli-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		claudeDir = join(tempDir, "claude");
		codexDir = join(tempDir, "codex");
		mkdirSync(claudeDir, { recursive: true });
		mkdirSync(codexDir, { recursive: true });
		// Point the readers at fixtures; never at the real ~/.claude or ~/.codex.
		vi.stubEnv("CLAUDE_CONFIG_DIR", claudeDir);
		vi.stubEnv("CODEX_HOME", codexDir);
		// Env keys outrank the CLI fallback, so keep them out of the way.
		vi.stubEnv("ANTHROPIC_API_KEY", "");
		vi.stubEnv("OPENAI_API_KEY", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function writeClaudeCredentials(content: string) {
		writeFileSync(join(claudeDir, ".credentials.json"), content);
	}

	function writeCodexCredentials(content: string) {
		writeFileSync(join(codexDir, "auth.json"), content);
	}

	function validClaudeCredentials(expiresAt = Date.now() + HOUR_MS) {
		return JSON.stringify({
			claudeAiOauth: {
				accessToken: "claude-access",
				refreshToken: "claude-refresh",
				expiresAt,
				subscriptionType: "max",
			},
			mcpOAuth: { "some-server": { accessToken: "unrelated" } },
		});
	}

	function validCodexCredentials(expSeconds = Math.floor((Date.now() + HOUR_MS) / 1000)) {
		return JSON.stringify({
			OPENAI_API_KEY: null,
			auth_mode: "chatgpt",
			last_refresh: new Date().toISOString(),
			tokens: {
				access_token: jwt(expSeconds),
				refresh_token: "codex-refresh",
				account_id: "acct-1",
			},
		});
	}

	describe("readCliOAuthCredentials", () => {
		test("parses Claude Code credentials", () => {
			const expiresAt = Date.now() + HOUR_MS;
			writeClaudeCredentials(validClaudeCredentials(expiresAt));

			const credentials = readCliOAuthCredentials("anthropic");

			expect(credentials?.access).toBe("claude-access");
			expect(credentials?.refresh).toBe("claude-refresh");
			// Absolute epoch-ms deadline with the same 5 minute skew void applies itself.
			expect(credentials?.expires).toBe(expiresAt - 5 * 60 * 1000);
		});

		test("parses Codex credentials with expiry taken from the JWT", () => {
			const expSeconds = Math.floor((Date.now() + HOUR_MS) / 1000);
			writeCodexCredentials(validCodexCredentials(expSeconds));

			const credentials = readCliOAuthCredentials("openai-codex");

			expect(credentials?.access).toBe(jwt(expSeconds));
			expect(credentials?.refresh).toBe("codex-refresh");
			expect(credentials?.expires).toBe(expSeconds * 1000 - 5 * 60 * 1000);
		});

		test("missing file yields no credentials", () => {
			expect(readCliOAuthCredentials("anthropic")).toBeUndefined();
			expect(readCliOAuthCredentials("openai-codex")).toBeUndefined();
		});

		test("malformed JSON yields no credentials", () => {
			writeClaudeCredentials("{ not json");
			writeCodexCredentials("{ not json");

			expect(readCliOAuthCredentials("anthropic")).toBeUndefined();
			expect(readCliOAuthCredentials("openai-codex")).toBeUndefined();
		});

		test("unexpected shape yields no credentials", () => {
			writeClaudeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: 42, expiresAt: "soon" } }));
			writeCodexCredentials(JSON.stringify({ tokens: { access_token: "not-a-jwt" } }));

			expect(readCliOAuthCredentials("anthropic")).toBeUndefined();
			expect(readCliOAuthCredentials("openai-codex")).toBeUndefined();
		});

		test("expired token is treated as absent", () => {
			writeClaudeCredentials(validClaudeCredentials(Date.now() - HOUR_MS));
			writeCodexCredentials(validCodexCredentials(Math.floor((Date.now() - HOUR_MS) / 1000)));

			expect(readCliOAuthCredentials("anthropic")).toBeUndefined();
			expect(readCliOAuthCredentials("openai-codex")).toBeUndefined();
		});

		test("unknown provider yields no credentials", () => {
			expect(readCliOAuthCredentials("some-other-provider")).toBeUndefined();
		});
	});

	describe("AuthStorage integration", () => {
		function authStorageWith(data: Record<string, unknown> = {}) {
			const authJsonPath = join(tempDir, "auth.json");
			writeFileSync(authJsonPath, JSON.stringify(data));
			return AuthStorage.create(authJsonPath);
		}

		test("CLI credentials are used when void has none", async () => {
			writeClaudeCredentials(validClaudeCredentials());
			const authStorage = authStorageWith();

			expect(authStorage.hasAuth("anthropic")).toBe(true);
			expect(authStorage.get("anthropic")).toMatchObject({ type: "oauth", access: "claude-access" });
			expect(await authStorage.getApiKey("anthropic")).toBe("claude-access");
		});

		test("void's own auth.json wins over the CLI fallback", async () => {
			writeClaudeCredentials(validClaudeCredentials());
			const authStorage = authStorageWith({
				anthropic: { type: "api_key", key: "void-own-key" },
			});

			expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "void-own-key" });
			expect(await authStorage.getApiKey("anthropic")).toBe("void-own-key");
		});

		test("no CLI files means no auth and no errors", async () => {
			const authStorage = authStorageWith();

			expect(authStorage.hasAuth("openai-codex")).toBe(false);
			expect(await authStorage.getApiKey("openai-codex")).toBeUndefined();
			expect(authStorage.drainErrors()).toEqual([]);
		});
	});

	describe("logout opts out of the CLI fallback", () => {
		const authJsonPath = () => join(tempDir, "auth.json");

		function authStorageWith(data: Record<string, unknown> = {}) {
			writeFileSync(authJsonPath(), JSON.stringify(data));
			return AuthStorage.create(authJsonPath());
		}

		test("logging out of a borrowed-only provider reports it absent everywhere", async () => {
			writeClaudeCredentials(validClaudeCredentials());
			const authStorage = authStorageWith();
			expect(authStorage.hasAuth("anthropic")).toBe(true);

			authStorage.logout("anthropic");

			expect(authStorage.get("anthropic")).toBeUndefined();
			expect(authStorage.hasAuth("anthropic")).toBe(false);
			expect(await authStorage.getApiKey("anthropic")).toBeUndefined();
		});

		test("the opt-out survives a reconstruct of AuthStorage", async () => {
			writeClaudeCredentials(validClaudeCredentials());
			authStorageWith().logout("anthropic");

			const reconstructed = AuthStorage.create(authJsonPath());

			expect(reconstructed.get("anthropic")).toBeUndefined();
			expect(reconstructed.hasAuth("anthropic")).toBe(false);
			expect(await reconstructed.getApiKey("anthropic")).toBeUndefined();
		});

		test("the opt-out survives reload()", () => {
			writeClaudeCredentials(validClaudeCredentials());
			const authStorage = authStorageWith();
			authStorage.logout("anthropic");

			authStorage.reload();

			expect(authStorage.get("anthropic")).toBeUndefined();
		});

		test("logging in again clears the opt-out", async () => {
			writeClaudeCredentials(validClaudeCredentials());
			const authStorage = authStorageWith();
			authStorage.logout("anthropic");

			authStorage.set("anthropic", { type: "api_key", key: "void-own-key" });
			expect(await authStorage.getApiKey("anthropic")).toBe("void-own-key");
			expect(await AuthStorage.create(authJsonPath()).getApiKey("anthropic")).toBe("void-own-key");

			// Proof the opt-out itself is gone, not merely shadowed by the own
			// credential: drop that credential from the file and the fallback works.
			writeFileSync(authJsonPath(), JSON.stringify({}));
			expect(await AuthStorage.create(authJsonPath()).getApiKey("anthropic")).toBe("claude-access");
		});

		test("opt-out is per-provider", () => {
			writeClaudeCredentials(validClaudeCredentials());
			writeCodexCredentials(validCodexCredentials());
			const authStorage = authStorageWith();

			authStorage.logout("anthropic");

			expect(authStorage.get("anthropic")).toBeUndefined();
			expect(authStorage.get("openai-codex")).toMatchObject({ type: "oauth", refresh: "codex-refresh" });
		});

		test("list() and has() ignore an opted-out borrowed provider", () => {
			writeClaudeCredentials(validClaudeCredentials());
			const authStorage = authStorageWith();

			authStorage.logout("anthropic");

			expect(authStorage.list()).toEqual([]);
			expect(authStorage.has("anthropic")).toBe(false);
			expect(authStorage.getAll()).toEqual({});
		});

		test("an auth.json written before the opt-out field still loads unchanged", async () => {
			writeClaudeCredentials(validClaudeCredentials());
			const authStorage = authStorageWith({ "openai-codex": { type: "api_key", key: "legacy-key" } });

			expect(authStorage.list()).toEqual(["openai-codex"]);
			expect(authStorage.has("openai-codex")).toBe(true);
			expect(await authStorage.getApiKey("openai-codex")).toBe("legacy-key");
			// The CLI fallback is still live for providers never logged out of.
			expect(await authStorage.getApiKey("anthropic")).toBe("claude-access");
			expect(authStorage.drainErrors()).toEqual([]);
		});
	});
});

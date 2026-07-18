/**
 * Read-only credential fallback for accounts already logged into other CLIs
 * (Claude Code, Codex), so users do not have to authenticate twice.
 *
 * This module deliberately imports `readFileSync` and nothing else from `fs`:
 * writing, refreshing or deleting a foreign CLI's file is not representable
 * here. Credentials derived from these files are only ever handed back to
 * void's own storage, never written back to their origin.
 *
 * Everything is best-effort: a missing, unreadable, malformed or expired
 * source degrades to `undefined` without throwing or logging.
 */

import type { OAuthCredentials } from "@void/ai";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Match the buffer void applies when minting its own OAuth credentials. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as unknown;
	} catch {
		return undefined;
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function configDir(envVar: string, fallbackDirName: string): string {
	return nonEmptyString(process.env[envVar]) ?? join(homedir(), fallbackDirName);
}

/** Expiry (epoch ms) from a JWT `exp` claim, without verifying the signature. */
function jwtExpiry(token: string): number | undefined {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		const claims = record(JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")));
		const exp = claims?.exp;
		return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
	} catch {
		return undefined;
	}
}

/** `~/.claude/.credentials.json` written by the Claude Code CLI. */
function readClaudeCodeCredentials(): OAuthCredentials | undefined {
	const path = join(configDir("CLAUDE_CONFIG_DIR", ".claude"), ".credentials.json");
	const oauth = record(record(readJson(path))?.claudeAiOauth);
	const access = nonEmptyString(oauth?.accessToken);
	const refresh = nonEmptyString(oauth?.refreshToken);
	const expiresAt = oauth?.expiresAt;
	if (!access || !refresh || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return undefined;
	return { access, refresh, expires: expiresAt - EXPIRY_SKEW_MS };
}

/** `~/.codex/auth.json` written by the Codex CLI (ChatGPT subscription mode). */
function readCodexCredentials(): OAuthCredentials | undefined {
	const path = join(configDir("CODEX_HOME", ".codex"), "auth.json");
	const tokens = record(record(readJson(path))?.tokens);
	const access = nonEmptyString(tokens?.access_token);
	const refresh = nonEmptyString(tokens?.refresh_token);
	if (!access || !refresh) return undefined;
	const expiry = jwtExpiry(access);
	if (expiry === undefined) return undefined;
	return { access, refresh, expires: expiry - EXPIRY_SKEW_MS };
}

const CLI_CREDENTIAL_SOURCES: Record<string, { name: string; read: () => OAuthCredentials | undefined }> = {
	anthropic: { name: "Claude Code CLI", read: readClaudeCodeCredentials },
	"openai-codex": { name: "Codex CLI", read: readCodexCredentials },
};

/** Display name of the CLI whose credentials void can borrow for `providerId`. */
export function cliCredentialSourceName(providerId: string): string | undefined {
	return CLI_CREDENTIAL_SOURCES[providerId]?.name;
}

/**
 * OAuth credentials for `providerId` taken from an installed CLI's own
 * credential file, or undefined if there are none usable. An already-expired
 * token is reported as absent: void cannot refresh it without writing to the
 * foreign CLI's file.
 */
export function readCliOAuthCredentials(providerId: string): OAuthCredentials | undefined {
	const credentials = CLI_CREDENTIAL_SOURCES[providerId]?.read();
	if (!credentials || Date.now() >= credentials.expires) return undefined;
	return credentials;
}

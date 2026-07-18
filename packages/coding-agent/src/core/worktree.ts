/**
 * Git worktree lifecycle helpers for opt-in per-child isolation
 * (see SPEC-void-orchestration-gaps.md, Part 4).
 *
 * Pure library code: create a worktree, check whether it's clean, remove it.
 * Not wired into subagent.ts yet — that's a separate task.
 *
 * Trust boundary (non-negotiable): every git invocation goes through an argv
 * array, never a shell string (`Bun.spawn` under Bun; a `node:child_process`
 * equivalent under plain Node, e.g. this package's vitest suite), matching
 * this repo's existing external-command convention
 * (packages/orchestrator/src/process.ts).
 */

import { spawn as nodeSpawn } from "node:child_process";
import { join } from "node:path";
import { Readable } from "node:stream";

/** Minimal typed subset of Bun's spawn API this module needs. */
interface BunSubprocess {
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
}

interface BunSpawnOptions {
	readonly cwd?: string;
	readonly stdout: "pipe";
	readonly stderr: "pipe";
}

interface BunRuntime {
	spawn(argv: readonly string[], options: BunSpawnOptions): BunSubprocess;
}

/** node:child_process-backed stand-in for BunRuntime, used whenever globalThis.Bun isn't there. */
const nodeRuntime: BunRuntime = {
	spawn(argv, options) {
		const [command, ...args] = argv;
		if (!command) throw new Error("worktree: argv must contain a non-empty executable");
		const child = nodeSpawn(command, args, { cwd: options.cwd });
		return {
			stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
			stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
			exited: new Promise<number>((resolve) => {
				child.on("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
			}),
		};
	},
};

/**
 * Resolved lazily (at call time, not import time) so a test's `environment: 'node'`
 * vitest worker — which has no globalThis.Bun — still gets a working runtime,
 * while a real Bun process keeps using Bun.spawn. Mirrors the injectable-runtime
 * convention in packages/orchestrator/src/process.ts's spawnProcess.
 */
function defaultRuntime(): BunRuntime {
	return (globalThis as typeof globalThis & { readonly Bun?: BunRuntime }).Bun ?? nodeRuntime;
}

interface GitResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

async function runGit(
	argv: readonly string[],
	cwd: string,
	runtime: BunRuntime = defaultRuntime(),
): Promise<GitResult> {
	const proc = runtime.spawn(["git", ...argv], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

/** Scratch location convention: `<agentDir>/worktrees/<runId>`. */
export function worktreePath(agentDir: string, runId: string): string {
	return join(agentDir, "worktrees", runId);
}

export interface CreatedWorktree {
	readonly path: string;
	readonly ref: string;
}

/**
 * Create a git worktree at `path` for `ref` (`git worktree add <path> <ref>`),
 * rooted at `repoDir`. Ref defaults to `repoDir`'s current HEAD.
 */
export async function createWorktree(repoDir: string, path: string, ref?: string): Promise<CreatedWorktree> {
	const resolvedRef = ref ?? (await headRef(repoDir));
	const result = await runGit(["worktree", "add", path, resolvedRef], repoDir);
	if (result.exitCode !== 0) {
		throw new Error(`git worktree add failed: ${result.stderr.trim() || result.stdout.trim()}`);
	}
	return { path, ref: resolvedRef };
}

async function headRef(repoDir: string): Promise<string> {
	const result = await runGit(["rev-parse", "HEAD"], repoDir);
	if (result.exitCode !== 0) throw new Error(`git rev-parse HEAD failed: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

/** True if `worktreeDir` (a worktree's own path) has no uncommitted changes. */
export async function isWorktreeClean(worktreeDir: string): Promise<boolean> {
	const result = await runGit(["status", "--porcelain"], worktreeDir);
	if (result.exitCode !== 0) throw new Error(`git status failed: ${result.stderr.trim()}`);
	return result.stdout.trim().length === 0;
}

/**
 * Remove a worktree unconditionally. Callers must already know it's clean —
 * this never re-checks, so never call it on a path you haven't confirmed.
 */
export async function removeWorktree(repoDir: string, path: string): Promise<void> {
	const result = await runGit(["worktree", "remove", path], repoDir);
	if (result.exitCode !== 0) throw new Error(`git worktree remove failed: ${result.stderr.trim()}`);
}

export interface CleanupResult {
	readonly removed: boolean;
	/** Set (and the worktree left untouched) when it had uncommitted changes. */
	readonly dirtyPath?: string;
}

/**
 * Convenience lifecycle op: remove the worktree at `path` if it's clean;
 * otherwise leave it in place and report its path. Never silently discards
 * a child's uncommitted work.
 */
export async function cleanupWorktree(repoDir: string, path: string): Promise<CleanupResult> {
	const clean = await isWorktreeClean(path);
	if (!clean) return { removed: false, dirtyPath: path };
	await removeWorktree(repoDir, path);
	return { removed: true };
}

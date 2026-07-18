/**
 * Real git-integration tests for the worktree helper module. Uses actual temp
 * git repos (no mocks) since this exercises process/git behavior directly.
 *
 * NOTE: worktree.ts spawns via Bun.spawn, so `globalThis.Bun` must exist at
 * runtime. Plain `vitest` runs under Node and won't have it — run this file
 * with `bun test test/worktree.test.ts`, the same way this package already
 * carves out test/harness-proc.test.ts and test/harness-glue.test.ts.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupWorktree,
	createWorktree,
	isWorktreeClean,
	removeWorktree,
	worktreePath,
} from "../src/core/worktree.js";

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function initRepo(repoDir: string): void {
	git(["init", "--initial-branch=main"], repoDir);
	git(["config", "--local", "user.email", "test@test.com"], repoDir);
	git(["config", "--local", "user.name", "Test"], repoDir);
}

function commit(repoDir: string, filename: string, content: string, message: string): string {
	writeFileSync(join(repoDir, filename), content);
	git(["add", filename], repoDir);
	git(["commit", "-m", message], repoDir);
	return git(["rev-parse", "HEAD"], repoDir);
}

describe("worktree", () => {
	let base: string;
	let repoDir: string;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "void-worktree-test-"));
		repoDir = join(base, "repo");
		spawnSync("mkdir", ["-p", repoDir]);
		initRepo(repoDir);
		commit(repoDir, "file.txt", "v1", "initial commit");
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	it("creates a worktree at the current HEAD when no ref is given", async () => {
		const head = git(["rev-parse", "HEAD"], repoDir);
		const path = worktreePath(base, "run-1");

		const result = await createWorktree(repoDir, path);

		expect(result.path).toBe(path);
		expect(result.ref).toBe(head);
		expect(readFileSync(join(path, "file.txt"), "utf-8")).toBe("v1");
	});

	it("creates a worktree at an explicit ref", async () => {
		const firstCommit = git(["rev-parse", "HEAD"], repoDir);
		commit(repoDir, "file.txt", "v2", "second commit");
		const path = worktreePath(base, "run-2");

		const result = await createWorktree(repoDir, path, firstCommit);

		expect(result.ref).toBe(firstCommit);
		expect(readFileSync(join(path, "file.txt"), "utf-8")).toBe("v1");
	});

	it("detects a clean worktree", async () => {
		const path = worktreePath(base, "run-3");
		await createWorktree(repoDir, path);

		await expect(isWorktreeClean(path)).resolves.toBe(true);
	});

	it("detects a dirty worktree", async () => {
		const path = worktreePath(base, "run-4");
		await createWorktree(repoDir, path);
		writeFileSync(join(path, "file.txt"), "modified");

		await expect(isWorktreeClean(path)).resolves.toBe(false);
	});

	it("removes a clean worktree", async () => {
		const path = worktreePath(base, "run-5");
		await createWorktree(repoDir, path);

		const result = await cleanupWorktree(repoDir, path);

		expect(result).toEqual({ removed: true });
		const list = git(["worktree", "list"], repoDir);
		expect(list).not.toContain(path);
	});

	it("refuses to remove a dirty worktree and surfaces its path", async () => {
		const path = worktreePath(base, "run-6");
		await createWorktree(repoDir, path);
		writeFileSync(join(path, "file.txt"), "uncommitted change");

		const result = await cleanupWorktree(repoDir, path);

		expect(result).toEqual({ removed: false, dirtyPath: path });
		// Never silently discarded: the worktree and its change are still there.
		expect(readFileSync(join(path, "file.txt"), "utf-8")).toBe("uncommitted change");
		const list = git(["worktree", "list"], repoDir);
		expect(list).toContain(path);
	});

	it("removeWorktree deletes unconditionally when the caller has already confirmed clean", async () => {
		const path = worktreePath(base, "run-7");
		await createWorktree(repoDir, path);

		await removeWorktree(repoDir, path);

		const list = git(["worktree", "list"], repoDir);
		expect(list).not.toContain(path);
	});
});

import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migratePiConfig, PI_CONFIG_MIGRATION_MARKER } from "../src/migrations.js";

type SnapshotEntry = {
	relativePath: string;
	kind: "directory" | "file" | "symlink";
	value: string;
};

const temporaryRoots: string[] = [];

function createRoots(): { root: string; sourceDir: string; destinationDir: string } {
	const root = mkdtempSync(join(tmpdir(), "void-config-migration-"));
	temporaryRoots.push(root);
	return {
		root,
		sourceDir: join(root, "pi", "agent"),
		destinationDir: join(root, "void"),
	};
}

function snapshotTree(path: string, relativePath = ""): SnapshotEntry[] {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) {
		return [{ relativePath, kind: "symlink", value: readlinkSync(path) }];
	}
	if (stat.isDirectory()) {
		return [
			{ relativePath, kind: "directory", value: "" },
			...readdirSync(path).flatMap((entry) => snapshotTree(join(path, entry), join(relativePath, entry))),
		];
	}
	return [{ relativePath, kind: "file", value: readFileSync(path).toString("base64") }];
}

function writeSourceFile(sourceDir: string, relativePath: string, content: string): void {
	const path = join(sourceDir, relativePath);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("pi configuration migration", () => {
	it("completes without warning when the source is missing", () => {
		const { sourceDir, destinationDir } = createRoots();

		expect(() => migratePiConfig({ sourceDir, destinationDir })).not.toThrow();
		expect(readFileSync(join(destinationDir, PI_CONFIG_MIGRATION_MARKER), "utf8")).toBe("1\n");
	});

	it("copies only the approved entries", () => {
		const { sourceDir, destinationDir } = createRoots();
		writeSourceFile(sourceDir, "settings.json", "settings");
		writeSourceFile(sourceDir, "extensions/one.ts", "extension");
		writeSourceFile(sourceDir, "chains/one.json", "chain");
		writeSourceFile(sourceDir, "APPEND_SYSTEM.md", "system");
		writeSourceFile(sourceDir, "oauth.json", "must not copy");

		migratePiConfig({ sourceDir, destinationDir });

		expect(readdirSync(destinationDir).sort()).toEqual(
			[PI_CONFIG_MIGRATION_MARKER, "APPEND_SYSTEM.md", "chains", "extensions", "settings.json"].sort(),
		);
		expect(readFileSync(join(destinationDir, "settings.json"), "utf8")).toBe("settings");
		expect(lstatSync(join(destinationDir, "settings.json")).mode & 0o777).toBe(0o600);
		expect(readFileSync(join(destinationDir, "extensions/one.ts"), "utf8")).toBe("extension");
		expect(readFileSync(join(destinationDir, "chains/one.json"), "utf8")).toBe("chain");
		expect(readFileSync(join(destinationDir, "APPEND_SYSTEM.md"), "utf8")).toBe("system");
		expect(existsSync(join(destinationDir, "oauth.json"))).toBe(false);
	});

	it("preserves existing destination files while merging directories", () => {
		const { sourceDir, destinationDir } = createRoots();
		writeSourceFile(sourceDir, "settings.json", "source settings");
		writeSourceFile(sourceDir, "extensions/shared.ts", "source shared");
		writeSourceFile(sourceDir, "extensions/new.ts", "new extension");
		writeSourceFile(sourceDir, "chains/new.json", "new chain");
		writeSourceFile(destinationDir, "settings.json", "destination settings");
		writeSourceFile(destinationDir, "extensions/shared.ts", "destination shared");
		writeSourceFile(destinationDir, "extensions/destination-only.ts", "keep this");

		migratePiConfig({ sourceDir, destinationDir });

		expect(readFileSync(join(destinationDir, "settings.json"), "utf8")).toBe("destination settings");
		expect(readFileSync(join(destinationDir, "extensions/shared.ts"), "utf8")).toBe("destination shared");
		expect(readFileSync(join(destinationDir, "extensions/new.ts"), "utf8")).toBe("new extension");
		expect(readFileSync(join(destinationDir, "extensions/destination-only.ts"), "utf8")).toBe("keep this");
		expect(readFileSync(join(destinationDir, "chains/new.json"), "utf8")).toBe("new chain");
	});

	it("retries missing descendants from a partial earlier run", () => {
		const { sourceDir, destinationDir } = createRoots();
		writeSourceFile(sourceDir, "extensions/already-copied.ts", "source old");
		writeSourceFile(sourceDir, "extensions/missing.ts", "source new");
		writeSourceFile(destinationDir, "extensions/already-copied.ts", "destination wins");

		migratePiConfig({ sourceDir, destinationDir });

		expect(readFileSync(join(destinationDir, "extensions/already-copied.ts"), "utf8")).toBe("destination wins");
		expect(readFileSync(join(destinationDir, "extensions/missing.ts"), "utf8")).toBe("source new");
		expect(existsSync(join(destinationDir, PI_CONFIG_MIGRATION_MARKER))).toBe(true);
	});

	it("warns non-fatally on a permission failure and can retry", () => {
		const { sourceDir, destinationDir } = createRoots();
		writeSourceFile(sourceDir, "settings.json", "settings");
		mkdirSync(destinationDir, { recursive: true });
		chmodSync(destinationDir, 0o500);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			expect(() => migratePiConfig({ sourceDir, destinationDir })).not.toThrow();
			expect(warnSpy).toHaveBeenCalled();
			expect(existsSync(join(destinationDir, PI_CONFIG_MIGRATION_MARKER))).toBe(false);
		} finally {
			chmodSync(destinationDir, 0o700);
			warnSpy.mockRestore();
		}

		migratePiConfig({ sourceDir, destinationDir });
		expect(readFileSync(join(destinationDir, "settings.json"), "utf8")).toBe("settings");
		expect(existsSync(join(destinationDir, PI_CONFIG_MIGRATION_MARKER))).toBe(true);
	});

	it("copies symlinks without dereferencing them", () => {
		if (process.platform === "win32") return;
		const { sourceDir, destinationDir } = createRoots();
		mkdirSync(sourceDir, { recursive: true });
		symlinkSync("not-copied.txt", join(sourceDir, "extensions"));

		migratePiConfig({ sourceDir, destinationDir });

		const copied = lstatSync(join(destinationDir, "extensions"));
		expect(copied.isSymbolicLink()).toBe(true);
		expect(readlinkSync(join(destinationDir, "extensions"))).toBe("not-copied.txt");
	});

	it("uses the completion marker for idempotency", () => {
		const { sourceDir, destinationDir } = createRoots();
		writeSourceFile(sourceDir, "settings.json", "first");

		migratePiConfig({ sourceDir, destinationDir });
		writeFileSync(join(sourceDir, "settings.json"), "changed after migration");
		migratePiConfig({ sourceDir, destinationDir });

		expect(readFileSync(join(destinationDir, "settings.json"), "utf8")).toBe("first");
		expect(readFileSync(join(destinationDir, PI_CONFIG_MIGRATION_MARKER), "utf8")).toBe("1\n");
	});

	it("does not mutate the source tree", () => {
		const { sourceDir, destinationDir } = createRoots();
		writeSourceFile(sourceDir, "settings.json", "settings");
		writeSourceFile(sourceDir, "extensions/nested/file.ts", "extension");
		writeSourceFile(sourceDir, "chains/nested/file.json", "chain");
		writeSourceFile(sourceDir, "APPEND_SYSTEM.md", "system");
		const before = snapshotTree(sourceDir);

		migratePiConfig({ sourceDir, destinationDir });

		expect(snapshotTree(sourceDir)).toEqual(before);
	});
});

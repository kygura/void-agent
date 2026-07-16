#!/usr/bin/env bun
/**
 * Void - Development launcher for Bun
 * Usage: bun scripts/dev.bun.ts [package-name]
 * Example: bun scripts/dev.bun.ts coding-agent
 */

import { spawn } from "child_process";
import path from "path";

const PROJECT_ROOT = import.meta.dir + "/..";
const TARGET = process.argv[2] ?? "all";

const PACKAGES: Record<string, string> = {
  tui: "packages/tui",
  ai: "packages/ai",
  agent: "packages/agent",
  "coding-agent": "packages/coding-agent",
  mom: "packages/mom",
  "web-ui": "packages/web-ui",
};

async function ensureDeps() {
  const depsCheck = await Bun.file(`${PROJECT_ROOT}/node_modules`).exists();
  if (!depsCheck) {
    console.log("📦 Installing dependencies...");
    await new Promise<void>((resolve) => {
		spawn("bun", ["install"], {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
      }).on("close", () => resolve());
    });
  }
}

async function dev(pkgName: string) {
  const pkgPath = PACKAGES[pkgName];
  if (!pkgPath) {
    console.error(`❌ Unknown package: ${pkgName}`);
    console.log(`Available: ${Object.keys(PACKAGES).join(", ")}`);
    process.exit(1);
  }

  console.log(`🔧 Starting development mode for ${pkgName}...`);
	spawn("bun", ["run", "dev"], {
    cwd: path.join(PROJECT_ROOT, pkgPath),
    stdio: "inherit",
  });
}

async function devAll() {
  console.log("🚀 Starting development mode for all packages...");
	spawn("bun", ["run", "dev"], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
}

async function main() {
  await ensureDeps();

  if (TARGET === "all") {
    await devAll();
  } else {
    await dev(TARGET);
  }
}

main().catch(console.error);

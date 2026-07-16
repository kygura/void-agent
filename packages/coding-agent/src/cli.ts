#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: bun src/cli.ts [args...]
 */
process.title = "void";
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { main } from "./main.js";

setGlobalDispatcher(new EnvHttpProxyAgent());

main(process.argv.slice(2));

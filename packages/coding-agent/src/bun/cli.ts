#!/usr/bin/env node
import "./register-bedrock.js";
import "../cli.js";

process.title = "void";
process.emitWarning = (() => {}) as typeof process.emitWarning;

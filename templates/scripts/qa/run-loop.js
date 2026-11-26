#!/usr/bin/env node
"use strict";
/*
 * run-loop — CommonJS facade over the ESM decision core (`run-loop-core.mjs`).
 *
 * The core is ESM because OpenCode's TUI plugin loader evaluates its graph as
 * ESM-only and therefore cannot see CommonJS exports. Existing CJS consumers
 * (`scripts/finalize.js`, `agent-harness run`) keep this synchronous entrypoint;
 * Node >=20.19 can require an ES module with no top-level await.
 */
module.exports = require("./run-loop-core.mjs");

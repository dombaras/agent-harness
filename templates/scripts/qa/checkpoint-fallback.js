#!/usr/bin/env node
"use strict";
/*
 * checkpoint-fallback — CommonJS facade over the ESM fallback writer
 * (`checkpoint-fallback.mjs`).
 *
 * The core is ESM because the TUI plugin graph is evaluated ESM-only. The server
 * guard and the runner keep this synchronous CJS entrypoint; Node >=20.19 can
 * require an ES module with no top-level await (same pattern as run-loop.js).
 */
module.exports = require("./checkpoint-fallback.mjs");

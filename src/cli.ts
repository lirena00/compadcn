#!/usr/bin/env node

import { runCli } from "./cli/run.js";

process.exitCode = await runCli();

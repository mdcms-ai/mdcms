#!/usr/bin/env node

import { createRequire } from "node:module";

import { runMdcmsCli } from "../lib/framework.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

const exitCode = await runMdcmsCli(process.argv.slice(2), {
  env: process.env,
  version,
});
process.exit(exitCode);

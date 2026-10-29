#!/usr/bin/env node
import { spawnSync } from "node:child_process"

const script = "C:/AGENT_FINAL/feishu_bridge/scripts/sheet.mjs"
const result = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: "inherit" })
process.exit(result.status ?? 1)

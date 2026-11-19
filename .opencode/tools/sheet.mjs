#!/usr/bin/env node
/**
 * sheet.mjs 的相对入口（个数 / 占比统计）。
 *
 * 调用方写：
 *
 *     node ../.opencode/tools/sheet.mjs count --sheet 数据.xlsx --where "列名=v"
 *
 * 真正的实现在 bridge 检出目录的 scripts/sheet.mjs。目录名可以是
 * Feishu-Bridge 或 feishu_bridge。查找顺序：FEISHU_BRIDGE → PM-Agent 同级目录
 * → 从当前目录向上，目录自身或其中的这两种名字。参数与退出码原样转发。
 */
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const NAMES = ["Feishu-Bridge", "feishu_bridge", "feishu-bridge"]
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..")

const roots = []
if (process.env.FEISHU_BRIDGE) roots.push(process.env.FEISHU_BRIDGE)
for (const name of NAMES) roots.push(path.resolve(repoRoot, "..", name))
for (let dir = process.cwd(); ; ) {
  roots.push(dir)
  for (const name of NAMES) roots.push(path.join(dir, name))
  const parent = path.dirname(dir)
  if (parent === dir) break
  dir = parent
}

const target = roots
  .map((root) => path.join(root, "scripts", "sheet.mjs"))
  .find((candidate) => fs.existsSync(candidate))

if (!target) {
  console.error(
    "找不到 bridge 的 scripts/sheet.mjs。\n" +
      "把 bridge 检出放在 PM-Agent 同级目录，或设置 FEISHU_BRIDGE 指向它。\n" +
      "找过这些位置：\n" +
      roots.map((root) => `  - ${root}`).join("\n"),
  )
  process.exit(1)
}

const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: "inherit" })
if (result.error) {
  console.error(`调用 sheet 统计失败：${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)

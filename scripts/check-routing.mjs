// 路由一致性校验：pm-brain.md 的路由注册表是全系统唯一事实源。
// 本脚本校验注册表与各 agent 文件之间不漂移：
//   1. 任务类型无重复；
//   2. 注册表引用的正文/片段 Agent 文件存在，且在 A0 的 subagent 白名单内；
//   3. 注册表每行的主技能存在（skills/<name>/SKILL.md），且在正文 Agent 的 skill 白名单内。
// 用法：node agent_structure/scripts/check-routing.mjs
// 退出码：0 全部通过；1 存在不一致。

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = path.join(root, ".opencode", "agents");
const skillsDir = path.join(root, ".opencode", "skills");

const errors = [];
const ok = [];
const fail = (msg) => errors.push(msg);
const pass = (msg) => ok.push(msg);

const brainPath = path.join(agentsDir, "pm-brain.md");
if (!existsSync(brainPath)) {
  console.error("找不到 pm-brain.md: " + brainPath);
  process.exit(1);
}
const brain = readFileSync(brainPath, "utf8");

// ---- 解析 A0 的 subagent 白名单 ----
const brainSubagents = new Set();
for (const m of brain.matchAll(/action:\s*subagent\s+resource:\s*"([^"]+)"\s+effect:\s*allow/g)) {
  brainSubagents.add(m[1]);
}

// ---- 解析路由注册表 ----
const registrySection = brain.split("### 路由注册表")[1];
if (!registrySection) {
  console.error("pm-brain.md 中找不到「### 路由注册表」段落");
  process.exit(1);
}
const tableText = registrySection.split(/^###\s/m)[0];
const rows = [];
for (const line of tableText.split("\n")) {
  const t = line.trim();
  if (!t.startsWith("|") || t.includes("---")) continue;
  const cells = t.split("|").map((c) => c.trim());
  if (cells[0] === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  if (cells.length < 7) continue;
  if (cells[0] === "任务类型") continue; // 表头
  const backticks = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  rows.push({
    type: cells[0],
    triggers: cells[1],
    body: backticks(cells[3])[0] || null,
    fragments: cells[4] === "无" ? [] : backticks(cells[4]),
    skill: backticks(cells[5])[0] || null,
  });
}

if (rows.length === 0) {
  console.error("路由注册表没有解析到任何数据行");
  process.exit(1);
}

// ---- 校验 1：任务类型唯一 ----
const seen = new Set();
for (const r of rows) {
  if (seen.has(r.type)) fail(`任务类型重复: ${r.type}`);
  seen.add(r.type);
}
pass(`任务类型唯一性: ${rows.length} 行`);

// ---- 校验 2/3：逐行核对 Agent 与技能 ----
const skillDirs = new Set(readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name));

const agentSkillCache = new Map();
function agentAllowedSkills(agentName) {
  if (agentSkillCache.has(agentName)) return agentSkillCache.get(agentName);
  const p = path.join(agentsDir, `${agentName}.md`);
  if (!existsSync(p)) return null;
  const text = readFileSync(p, "utf8");
  const skills = new Set();
  for (const m of text.matchAll(/action:\s*skill\s+resource:\s*"([^"]+)"\s+effect:\s*allow/g)) {
    skills.add(m[1]);
  }
  agentSkillCache.set(agentName, skills);
  return skills;
}

for (const r of rows) {
  const agentsToCheck = [r.body, ...r.fragments].filter(Boolean);
  if (!r.body) fail(`[${r.type}] 缺少正文 Agent`);
  for (const a of agentsToCheck) {
    if (!existsSync(path.join(agentsDir, `${a}.md`))) {
      fail(`[${r.type}] Agent 文件不存在: ${a}.md`);
      continue;
    }
    if (!brainSubagents.has(a)) {
      fail(`[${r.type}] ${a} 不在 pm-brain.md 的 subagent 白名单内`);
    }
  }
  if (!r.skill) {
    fail(`[${r.type}] 缺少主技能`);
  } else {
    if (!skillDirs.has(r.skill)) {
      fail(`[${r.type}] 技能目录不存在: skills/${r.skill}`);
    }
    if (r.body) {
      const allowed = agentAllowedSkills(r.body);
      if (allowed && !allowed.has(r.skill)) {
        fail(`[${r.type}] 主技能 ${r.skill} 不在 ${r.body} 的 skill 白名单内`);
      }
    }
  }
}
pass(`Agent 与技能引用核对: ${rows.length} 行`);

// ---- 输出 ----
console.log(`路由校验: ${rows.length} 个任务类型`);
for (const e of errors) console.log("  FAIL " + e);
if (errors.length === 0) {
  console.log("全部通过：注册表与各 Agent 文件一致。");
  process.exit(0);
} else {
  console.log(`共 ${errors.length} 处不一致，请先修复再上线。`);
  process.exit(1);
}

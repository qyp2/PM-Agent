#!/usr/bin/env node
/**
 * Feishu mailbox tool for agents: read messages from the bound mailbox.
 *
 *   node mail.mjs list [--unread] [--folder INBOX] [--label FLAGGED] [--size 10] [--raw]
 *   node mail.mjs get <message_id> [--raw]
 *
 * This tool holds NO credentials and does NOT know which mailbox it reads.
 * All requests go to the feishu-bridge loopback mail proxy (127.0.0.1), which
 * resolves the mailbox from the bridge-owned binding file — written only by
 * the bot 「绑定邮箱」 command after contact-API ownership verification.
 * There is no way from this side to select another mailbox: asking the agent
 * to "read someone else's mail" cannot work, and tampering with this script
 * cannot change which mailbox the proxy serves.
 *
 * Binding: send 「绑定邮箱」 in chat. Unbinding/rebinding is bridge-side only.
 */
import process from "node:process"

const PROXY = process.env.MAIL_PROXY_URL ?? "http://127.0.0.1:4097"

const fail = (message, hint) => {
  console.error(`ERROR ${message}${hint ? `\nHINT ${hint}` : ""}`)
  process.exit(1)
}

async function api(pathname, fatal = true) {
  // fatal=false (per-message detail fetches) throws instead of exiting, so one
  // bad message doesn't kill the whole list.
  const bad = (message, hint) => {
    if (fatal) fail(message, hint)
    throw new Error(message)
  }
  let resp
  try {
    resp = await fetch(`${PROXY}${pathname}`)
  } catch {
    bad(
      "mail proxy unreachable",
      "the feishu-bridge mail proxy is not running; report the mail channel as temporarily unavailable instead of guessing",
    )
  }
  const data = await resp.json().catch(() => undefined)
  if (!data || typeof data !== "object") bad(`mail proxy -> HTTP ${resp.status} (non-JSON)`)
  if (data.code === 40901) {
    bad(
      "mailbox not bound",
      "ask the user to send 「绑定邮箱」 in chat; the bridge binds the mailbox registered on their own Feishu account (binding someone else's address is rejected)",
    )
  }
  if (data.code !== 0) {
    const hints = {
      99991672: "missing scope: add mail:user_mailbox.message:* in the developer console, then publish a version",
      99991679: "data permission missing: add this mailbox under the app's 数据权限 (邮件数据资源)",
    }
    bad(`mail API -> code ${data.code}: ${data.msg}`, hints[data.code])
  }
  return data.data ?? {}
}

const text = (value) => (typeof value === "string" ? value.trim() : "")

function plainBody(body) {
  if (!body) return ""
  if (text(body.plain_body) || text(body.plain)) return text(body.plain_body) || text(body.plain)
  const html = text(body.html_body) || text(body.html)
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
}

function addressList(value) {
  const items = Array.isArray(value) ? value : value ? [value] : []
  return items.map((item) => item?.mail_address ?? item?.address ?? item?.name ?? "").filter(Boolean).join(", ")
}

/** 正文是 base64（url-safe 变体 Node 也兼容）。 */
const b64 = (value) => {
  try {
    return Buffer.from(String(value ?? ""), "base64").toString("utf8")
  } catch {
    return ""
  }
}

/** 简单并发池：拉详情一页最多 20 条，并发 5 避免触发限流。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++
        out[idx] = await fn(items[idx], idx)
      }
    }),
  )
  return out
}

function fmtDate(ms) {
  const n = Number(ms)
  return Number.isFinite(n) && n > 0 ? new Date(n).toLocaleString("zh-CN", { hour12: false }) : ""
}

async function getMessage(id, fatal = false) {
  const data = await api(`/mail/messages/${encodeURIComponent(id)}`, fatal)
  // 详情包在 message 里（老代码假设的 item 不存在）。
  return data.message ?? data.item ?? data
}

const labelsOf = (msg) => (Array.isArray(msg?.label_ids) ? msg.label_ids : [])
const isUnread = (msg) => labelsOf(msg).includes("UNREAD")
const isStarred = (msg) => labelsOf(msg).includes("IMPORTANT")

async function list(args, raw) {
  const size = Math.min(Math.max(Number(args.size ?? 10) || 10, 1), 20)
  const params = new URLSearchParams({ page_size: String(size) })
  // 飞书要求 folder_id / label_id 必传其一（缺省报 4039）；默认收件箱。
  if (args.folder) params.set("folder_id", args.folder)
  else if (!args.label) params.set("folder_id", "INBOX")
  if (args.unread) params.set("only_unread", "true")
  if (args.label) params.set("label_id", args.label)
  if (args.page_token) params.set("page_token", args.page_token)
  const data = await api(`/mail/list?${params}`)
  // 列表接口只回 message_id 字符串数组，主题/时间/标签要逐个 get。
  const ids = (data.items ?? []).map((item) => (typeof item === "string" ? item : item?.message_id)).filter(Boolean)
  if (raw) return console.log(JSON.stringify(data.items ?? [], null, 2))
  if (ids.length === 0) return console.log("(no messages)")
  const details = await mapLimit(ids, 5, (id) => getMessage(id).catch(() => undefined))
  for (let i = 0; i < ids.length; i++) {
    const msg = details[i]
    if (!msg) {
      console.log(`${ids[i]} | (读取失败)`)
      continue
    }
    const flags = `${isUnread(msg) ? "[未读]" : "     "}${isStarred(msg) ? "★" : " "}`
    console.log(`${ids[i]} | ${flags} | ${fmtDate(msg.internal_date)} | ${text(msg.subject)}`)
  }
  if (data.has_more) console.log(`(more available; page_token ${data.page_token})`)
}

async function get(id, raw) {
  const msg = await getMessage(id, true)
  if (raw) return console.log(JSON.stringify(msg, null, 2))
  const body = plainBody({ plain_body: b64(msg.body_plain_text), html_body: b64(msg.body_html) })
  console.log(`subject: ${text(msg.subject)}`)
  console.log(`date: ${fmtDate(msg.internal_date)}`)
  console.log(`labels: ${labelsOf(msg).join(", ") || "(none)"}  (UNREAD=未读, IMPORTANT=星标)`)
  const from = addressList(msg.from)
  if (from) console.log(`from: ${from}`)
  console.log(`attachments: ${(msg.attachments ?? []).map((a) => a.filename ?? a.name).filter(Boolean).join(", ") || "(none)"}`)
  console.log("---")
  console.log(body ? body.slice(0, 4000) : "(body unavailable; run with --raw to inspect the payload)")
}

const [, , command, ...rest] = process.argv
const args = Object.fromEntries(
  rest.filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, value] = arg.slice(2).split("=")
    return [key, value ?? true]
  }),
)
const positional = rest.filter((arg) => !arg.startsWith("--"))

if (command === "config" || command === "bind") {
  // 绑定通道在 bridge：bot「绑定邮箱」命令做归属校验后写 bridge 私有绑定文件。
  // 这里没有任何写入口，也没有凭证可用。
  fail(
    `${command} is not available`,
    "mailbox binding is bridge-side only: send 「绑定邮箱」 in chat; the bridge verifies the address against your own Feishu account",
  )
} else if (command === "list") {
  await list(args, Boolean(args.raw))
} else if (command === "get" && positional[0]) {
  await get(positional[0], Boolean(args.raw))
} else if (command === "mark") {
  // 实测：飞书用户邮箱接口没有消息状态修改端点（PUT/PATCH messages/:id 均 404），
  // 已读/星标只能由用户在邮箱客户端里操作。明确报错，不静默失败。
  fail(
    "mark is not supported: the Feishu user-mailbox API is read-only (no message-update endpoint; PUT returns 404)",
    "tell the user honestly that marking read/starred is not possible via the API — suggest doing it in the Feishu Mail app, and never pretend a mark succeeded",
  )
} else {
  console.log("usage: node mail.mjs list [--unread] [--folder INBOX] [--label FLAGGED] [--size N] [--page_token T] [--raw]")
  console.log("       node mail.mjs get <message_id> [--raw]")
  console.log("       (binding: send 「绑定邮箱」 to the bot — bridge-side only)")
  console.log("       (mark: not supported — the Feishu user-mailbox API is read-only)")
}

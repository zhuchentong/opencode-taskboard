// Worker 会话上下文读取：bun:sqlite 只读打开 opencode 自身的会话库（message/part 表），
// 分页归一化为看板「上下文」标签的数据源。
//
// 设计要点（探路验证 2026-10-19，见 test/context.test.ts）：
// - 复合游标 (time_created, id) 翻页：同毫秒多条消息不漏不重（opencode 自身的
//   message_session_time_created_id_idx 索引正是这个序）；
// - 首页为最新一页：验收场景先看「最近干了什么、最终答复」；
// - 只读连接 + 惰性打开：不碰写路径、无会话查询不产生 IO；
// - schema 防御：文件缺失/表缺失一律归一为 StoreError("not_found")，绝不崩服务
//   （仓库钉死 opencode 版本，schema 漂移风险已被锁死，这里只兜意外）。
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { StoreError } from "./types"

/** opencode 会话库默认路径（production channel；非 production 的 channel 变体暂不支持，兜底用 TASKBOARD_DB 覆盖） */
export function defaultContextDbPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local/share")
  return process.env.TASKBOARD_DB || join(dataHome, "opencode", "opencode.db")
}

/** 单个文本载荷（text/reasoning/output）截断上限：防单个工具输出撑爆折叠条渲染 */
const PART_TEXT_CAP = 8 * 1024
/** 工具输入摘要截断上限 */
const PART_INPUT_CAP = 1024

export interface ContextPart {
  type: "text" | "reasoning" | "tool" | "patch" | "file" | "other"
  /** text/reasoning 的文本（截断后） */
  text?: string
  /** 工具名 */
  tool?: string
  /** 工具执行状态（completed/running/error/...） */
  state?: string
  /** 工具输入 JSON 摘要（截断后） */
  input?: string
  /** 工具输出（截断后） */
  output?: string
  /** patch 涉及的文件列表 */
  files?: string[]
  /** file 附件名 */
  filename?: string
  /** 该 part 是否发生截断 */
  truncated?: boolean
}

export interface ContextMessage {
  id: string
  role: string
  time: number
  parts: ContextPart[]
}

export interface ContextPage {
  /** 任务关联的 worker 会话 ID；任务无会话（未领取/human claim）为 null */
  sessionID: string | null
  /** 会话消息总数（无会话为 0） */
  total: number
  /** 当前页消息，时间倒序（最新在前） */
  page: ContextMessage[]
  /** 下一页游标；没有更多为 null */
  nextCursor: string | null
  hasMore: boolean
}

export interface ContextReadInput {
  sessionID: string
  /** 不透明分页游标（read 返回的 nextCursor 原样传回） */
  cursor?: string
  /** 页大小（服务端已夹紧到 1..200） */
  limit: number
}

export interface ContextReader {
  read(input: ContextReadInput): Promise<ContextPage>
  close(): void
}

const cap = (s: string, n: number): { text: string; truncated: boolean } =>
  s.length > n ? { text: s.slice(0, n), truncated: true } : { text: s, truncated: false }

/** 归一化单个 part 原始 JSON；step-start/step-finish 返回 null（不输出） */
function normalizePart(raw: Record<string, unknown>): ContextPart | null {
  const type = raw.type
  if (type === "step-start" || type === "step-finish") return null
  if (type === "text" || type === "reasoning") {
    const { text, truncated } = cap(typeof raw.text === "string" ? raw.text : "", PART_TEXT_CAP)
    return { type, ...(text ? { text } : {}), ...(truncated ? { truncated } : {}) }
  }
  if (type === "tool") {
    const state = (raw.state ?? {}) as Record<string, unknown>
    const out: ContextPart = { type: "tool", tool: typeof raw.tool === "string" ? raw.tool : "?" }
    if (typeof state.status === "string") out.state = state.status
    if (state.input !== undefined) {
      const { text, truncated } = cap(JSON.stringify(state.input), PART_INPUT_CAP)
      out.input = text
      if (truncated) out.truncated = true
    }
    if (state.output !== undefined) {
      const rawOut = typeof state.output === "string" ? state.output : JSON.stringify(state.output)
      const { text, truncated } = cap(rawOut, PART_TEXT_CAP)
      out.output = text
      if (truncated) out.truncated = true
    }
    return out
  }
  if (type === "patch") {
    const files = Array.isArray(raw.files) ? raw.files.filter((f): f is string => typeof f === "string") : []
    return { type: "patch", ...(files.length ? { files } : {}) }
  }
  if (type === "file") {
    return { type: "file", ...(typeof raw.filename === "string" ? { filename: raw.filename } : {}) }
  }
  return { type: "other" }
}

/** 游标编码：不透明字符串 base64url(`${time_created}:${id}`) */
const encodeCursor = (tc: number, id: string): string => btoa(`${tc}:${id}`)

function decodeCursor(cursor: string): { tc: number; id: string } {
  let decoded: string
  try {
    decoded = atob(cursor)
  } catch {
    throw new StoreError("invalid_input", "无效的上下文分页游标")
  }
  const sep = decoded.indexOf(":")
  const tc = Number(decoded.slice(0, sep))
  if (sep <= 0 || !Number.isSafeInteger(tc)) throw new StoreError("invalid_input", "无效的上下文分页游标")
  const id = decoded.slice(sep + 1)
  if (!id) throw new StoreError("invalid_input", "无效的上下文分页游标")
  return { tc, id }
}

export function createContextReader(opts: { dbPath?: string } = {}): ContextReader {
  const dbPath = opts.dbPath ?? defaultContextDbPath()
  /** 页大小默认值（路由层会夹紧请求参数，reader 自身也要有兜底默认） */
  const DEFAULT_LIMIT = 50
  // 惰性连接：首次 read 才打开（无会话查询零 IO；构造期不抛错）
  let db: Database | undefined

  function open(): Database {
    if (db) return db
    if (!existsSync(dbPath)) {
      throw new StoreError("not_found", `会话数据库不存在：${dbPath}`)
    }
    try {
      db = new Database(dbPath, { readonly: true })
      return db
    } catch {
      throw new StoreError("not_found", `会话数据库不可读：${dbPath}`)
    }
  }

  function query<T>(sql: string, ...params: unknown[]): T[] {
    try {
      return open().query<T, unknown[]>(sql).all(...params)
    } catch (e) {
      if (e instanceof StoreError) throw e
      // 表缺失 / schema 漂移等一律归一 not_found，带原始错误便于诊断
      throw new StoreError("not_found", `会话数据不可读：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    async read({ sessionID, cursor, limit = DEFAULT_LIMIT }): Promise<ContextPage> {
      const total = query<{ n: number }>("SELECT COUNT(*) AS n FROM message WHERE session_id = ?", sessionID)[0]!.n
      if (total === 0) {
        return { sessionID, total: 0, page: [], nextCursor: null, hasMore: false }
      }

      // 一页消息：复合游标 + (time_created, id) 倒序（索引 message_session_time_created_id_idx 正好支撑）
      const rows = cursor
        ? (() => {
            const { tc, id } = decodeCursor(cursor)
            return query<{ id: string; time_created: number; role: string }>(
              `SELECT id, time_created, JSON_EXTRACT(data, '$.role') AS role FROM message
                 WHERE session_id = ? AND (time_created < ? OR (time_created = ? AND id < ?))
                 ORDER BY time_created DESC, id DESC LIMIT ?`,
              sessionID, tc, tc, id, limit,
            )
          })()
        : query<{ id: string; time_created: number; role: string }>(
            `SELECT id, time_created, JSON_EXTRACT(data, '$.role') AS role FROM message
               WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?`,
            sessionID, limit,
          )

      // 一页 parts 一次取回（索引 part_message_id_id_idx），消息内按时间序
      let partsByMsg = new Map<string, ContextPart[]>()
      if (rows.length) {
        const placeholders = rows.map(() => "?").join(",")
        const rawParts = query<{ message_id: string; data: string }>(
          `SELECT message_id, data FROM part WHERE message_id IN (${placeholders}) ORDER BY time_created, id`,
          ...rows.map((r) => r.id),
        )
        for (const rp of rawParts) {
          let raw: Record<string, unknown>
          try {
            raw = JSON.parse(rp.data) as Record<string, unknown>
          } catch {
            continue // 坏数据跳过，不让整页失败
          }
          const part = normalizePart(raw)
          if (!part) continue
          const list = partsByMsg.get(rp.message_id) ?? []
          list.push(part)
          partsByMsg.set(rp.message_id, list)
        }
      }

      const page: ContextMessage[] = rows.map((r) => ({
        id: r.id,
        role: typeof r.role === "string" ? r.role : "unknown",
        time: r.time_created,
        parts: partsByMsg.get(r.id) ?? [],
      }))
      const hasMore = rows.length === limit
      const last = rows[rows.length - 1]
      return {
        sessionID,
        total,
        page,
        nextCursor: hasMore && last ? encodeCursor(last.time_created, last.id) : null,
        hasMore,
      }
    },
    close() {
      db?.close()
      db = undefined
    },
  }
}

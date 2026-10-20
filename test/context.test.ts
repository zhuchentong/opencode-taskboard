import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContextReader, normalizePart, type ContextPage } from "../src/context"
import { createStore, memoryBackend } from "../src/store"
import { createServer, type ServerHandle } from "../src/server"

// ---------- 临时文件库种子工具 ----------

const tmpDirs: string[] = []

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

function makeDb(): { db: Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "taskboard-ctx-"))
  tmpDirs.push(dir)
  const path = join(dir, "opencode.db")
  const db = new Database(path)
  db.run(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  db.run(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  return { db, path }
}

function seedMsg(db: Database, id: string, sid: string, tc: number, role = "user"): void {
  db.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", [id, sid, tc, tc, JSON.stringify({ role })])
}

function seedPart(db: Database, id: string, mid: string, sid: string, tc: number, data: unknown): void {
  db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", [id, mid, sid, tc, tc, JSON.stringify(data)])
}

/** 落盘库路径（reader 按路径打开）；临时目录在 afterEach 统一清理 */
const persist = (path: string): string => path

// ---------- reader 单测 ----------

describe("createContextReader", () => {
  test("构造时不打开连接；db 文件不存在 → read 抛 not_found", () => {
    const reader = createContextReader({ dbPath: "/nonexistent/opencode.db" })
    expect(async () => await reader.read({ sessionID: "ses_x" })).toThrow(/会话数据/)
  })

  test("首页返回最新 limit 条消息，时间倒序", async () => {
    const { db, path } = makeDb()
    for (let i = 0; i < 120; i++) seedMsg(db, `m${String(i).padStart(3, "0")}`, "ses_a", 1000 + i)
    const reader = createContextReader({ dbPath: persist(path) })
    const page = await reader.read({ sessionID: "ses_a", limit: 50 })
    expect(page.total).toBe(120)
    expect(page.page).toHaveLength(50)
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).not.toBeNull()
    // 最新一条在前
    expect(page.page[0]!.id).toBe("m119")
    expect(page.page[49]!.id).toBe("m070")
  })

  test("翻页游标接力遍历全部消息，不漏不重", async () => {
    const { db, path } = makeDb()
    for (let i = 0; i < 120; i++) seedMsg(db, `m${String(i).padStart(3, "0")}`, "ses_a", 1000 + i)
    const reader = createContextReader({ dbPath: persist(path) })
    const seen: string[] = []
    let cursor: string | undefined
    let guard = 0
    while (guard++ < 10) {
      const page = await reader.read({ sessionID: "ses_a", cursor, limit: 50 })
      seen.push(...page.page.map((m) => m.id))
      if (!page.hasMore) {
        expect(page.nextCursor).toBeNull()
        break
      }
      cursor = page.nextCursor ?? undefined
    }
    expect(seen).toHaveLength(120)
    expect(new Set(seen).size).toBe(120)
    // 时间倒序全集：m119 → m000
    expect(seen[0]).toBe("m119")
    expect(seen[119]).toBe("m000")
  })

  test("同毫秒多条消息跨页不漏不重（复合游标）", async () => {
    const { db, path } = makeDb()
    // 10 条同毫秒 + 前后各 45 条普通消息，页大小 50 恰好把同毫秒组切在页界
    let tc = 1000
    for (let i = 0; i < 45; i++) seedMsg(db, `a${String(i).padStart(3, "0")}`, "ses_a", tc++)
    for (let i = 0; i < 10; i++) seedMsg(db, `b${String(i).padStart(3, "0")}`, "ses_a", 2000)
    for (let i = 0; i < 45; i++) seedMsg(db, `c${String(i).padStart(3, "0")}`, "ses_a", tc++)
    const reader = createContextReader({ dbPath: persist(path) })
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page = await reader.read({ sessionID: "ses_a", cursor, limit: 50 })
      seen.push(...page.page.map((m) => m.id))
      if (!page.hasMore) break
      cursor = page.nextCursor ?? undefined
    }
    expect(seen).toHaveLength(100)
    expect(new Set(seen).size).toBe(100)
  })

  test("游标无效 → invalid_input", async () => {
    const { db, path } = makeDb()
    seedMsg(db, "m0", "ses_a", 1000)
    const reader = createContextReader({ dbPath: persist(path) })
    expect(async () => await reader.read({ sessionID: "ses_a", cursor: "!!not-base64!!" })).toThrow(/游标/)
    expect(async () => await reader.read({ sessionID: "ses_a", cursor: btoa("no-colon") })).toThrow(/游标/)
    expect(async () => await reader.read({ sessionID: "ses_a", cursor: btoa("abc:m0") })).toThrow(/游标/)
  })

  test("parts 归一化：文本/推理/工具/补丁/附件，step-start/step-finish 跳过", async () => {
    const { db, path } = makeDb()
    seedMsg(db, "m1", "ses_a", 1000, "user")
    seedPart(db, "p1", "m1", "ses_a", 1000, { type: "file", filename: "notes.md" })
    seedMsg(db, "m2", "ses_a", 2000, "assistant")
    seedPart(db, "p2", "m2", "ses_a", 2000, { type: "step-start" })
    seedPart(db, "p3", "m2", "ses_a", 2001, { type: "reasoning", text: "想一想" })
    seedPart(db, "p4", "m2", "ses_a", 2002, { type: "tool", tool: "read", state: { status: "completed", input: { path: "a.ts" }, output: "内容" } })
    seedPart(db, "p5", "m2", "ses_a", 2003, { type: "patch", files: ["/x/a.ts", "/x/b.ts"] })
    seedPart(db, "p6", "m2", "ses_a", 2004, { type: "text", text: "结论" })
    seedPart(db, "p7", "m2", "ses_a", 2005, { type: "step-finish" })
    const reader = createContextReader({ dbPath: persist(path) })
    const page = await reader.read({ sessionID: "ses_a" })
    expect(page.total).toBe(2)
    const [first, second] = page.page
    // 消息倒序：m2 在前
    expect(first!.id).toBe("m2")
    expect(first!.role).toBe("assistant")
    // step-start/step-finish 不输出
    expect(first!.parts.map((p) => p.type)).toEqual(["reasoning", "tool", "patch", "text"])
    const tool = first!.parts[1]!
    expect(tool.tool).toBe("read")
    expect(tool.state).toBe("completed")
    expect(tool.input).toContain("a.ts")
    expect(tool.output).toBe("内容")
    // patch → files 列表
    expect(first!.parts[2]!.files).toEqual(["/x/a.ts", "/x/b.ts"])
    // user 消息的附件
    expect(second!.parts[0]!.type).toBe("file")
    expect(second!.parts[0]!.filename).toBe("notes.md")
  })

  test("超长文本 part 截断并带 truncated 标记", async () => {
    const { db, path } = makeDb()
    seedMsg(db, "m1", "ses_a", 1000, "assistant")
    seedPart(db, "p1", "m1", "ses_a", 1000, { type: "tool", tool: "bash", state: { status: "completed", input: {}, output: "x".repeat(20_000) } })
    const reader = createContextReader({ dbPath: persist(path) })
    const page = await reader.read({ sessionID: "ses_a" })
    const tool = page.page[0]!.parts[0]!
    expect(tool.truncated).toBe(true)
    expect((tool.output ?? "").length).toBeLessThan(20_000)
    // 短文本不受影响
    seedPart(db, "p2", "m1", "ses_a", 1001, { type: "text", text: "短" })
    const page2 = await reader.read({ sessionID: "ses_a" })
    expect(page2.page[0]!.parts.find((p) => p.type === "text")?.truncated).toBeUndefined()
  })

  test("无 parts 的消息 parts 为空数组；其他会话消息不串", async () => {
    const { db, path } = makeDb()
    seedMsg(db, "m1", "ses_a", 1000)
    seedMsg(db, "m2", "ses_b", 1000)
    seedPart(db, "p1", "m2", "ses_b", 1000, { type: "text", text: "别的会话" })
    const reader = createContextReader({ dbPath: persist(path) })
    const page = await reader.read({ sessionID: "ses_a" })
    expect(page.total).toBe(1)
    expect(page.page[0]!.parts).toEqual([])
  })

  test("表缺失（schema 漂移）→ read 抛 not_found 而非崩服务", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskboard-ctx-"))
    const path = join(dir, "empty.db")
    const raw = new Database(path)
    raw.run("CREATE TABLE other (x TEXT)")
    raw.close()
    const reader = createContextReader({ dbPath: path })
    expect(async () => await reader.read({ sessionID: "ses_x" })).toThrow(/会话数据/)
  })
})

// ---------- 路由集成 ----------

const started: ServerHandle[] = []
afterEach(() => {
  while (started.length) started.pop()?.stop()
})

async function setup(readContext?: Parameters<typeof createServer>[1]["readContext"]) {
  const store = createStore(memoryBackend(), { requireAnalysisConfirm: false })
  await store.setSettings({ modelAnalyze: "test/analyze", modelExecute: "test/execute" })
  const handle = createServer(store, {
    port: 0,
    token: "tok123",
    webDir: "test/.webroot-fixture",
    primary: true,
    projectID: "proj-test",
    readContext,
  })
  started.push(handle)
  return { base: `http://127.0.0.1:${handle.actualPort}`, store }
}

describe("GET /api/tasks/:id/context", () => {
  test("任务不存在 → 404", async () => {
    const { base } = await setup()
    const r = await fetch(`${base}/api/tasks/nope/context`)
    expect(r.status).toBe(404)
  })

  test("任务无 claim → sessionID null 空页", async () => {
    const { base, store } = await setup()
    const t = await store.create({ title: "没领取" })
    const r = await fetch(`${base}/api/tasks/${t.id}/context`)
    expect(r.status).toBe(200)
    const body = (await r.json()) as ContextPage
    expect(body.sessionID).toBeNull()
    expect(body.total).toBe(0)
    expect(body.page).toEqual([])
    expect(body.hasMore).toBe(false)
  })

  test("有 claim → 分页参数透传注入的 reader；limit 非法时夹紧默认", async () => {
    const calls: Array<{ sessionID: string; cursor?: string; limit: number }> = []
    const { base, store } = await setup(async (input) => {
      calls.push(input)
      return { sessionID: input.sessionID, total: 1, page: [], nextCursor: null, hasMore: false }
    })
    const t = await store.create({ title: "有会话" })
    await store.patch(t.id, { status: "pending" })
    await store.claim({ id: t.id, sessionID: "ses_w", agent: "build" })

    await fetch(`${base}/api/tasks/${t.id}/context?cursor=abc&limit=10`)
    expect(calls[0]).toEqual({ sessionID: "ses_w", cursor: "abc", limit: 10 })

    // 非法/越界 limit 夹紧：NaN→默认 50，0/负→1，超 200→200
    await fetch(`${base}/api/tasks/${t.id}/context?limit=abc`)
    expect(calls[1]!.limit).toBe(50)
    await fetch(`${base}/api/tasks/${t.id}/context?limit=0`)
    expect(calls[2]!.limit).toBe(1)
    await fetch(`${base}/api/tasks/${t.id}/context?limit=9999`)
    expect(calls[3]!.limit).toBe(200)
  })

  test("不传 limit → 走默认 50 条（缺省不得被解析成 1：前端首页只显示 1 条消息）", async () => {
    const calls: Array<{ sessionID: string; cursor?: string; limit: number }> = []
    const { base, store } = await setup(async (input) => {
      calls.push(input)
      return { sessionID: input.sessionID, total: 1, page: [], nextCursor: null, hasMore: false }
    })
    const t = await store.create({ title: "有会话" })
    await store.patch(t.id, { status: "pending" })
    await store.claim({ id: t.id, sessionID: "ses_w", agent: "build" })

    // 前端 fetchTaskContext 从不传 limit（webapp/src/lib/api.ts）：这一路必须落默认 50
    await fetch(`${base}/api/tasks/${t.id}/context`)
    expect(calls[0]!.limit).toBe(50)

    // 只带 cursor（翻页）同样不传 limit
    await fetch(`${base}/api/tasks/${t.id}/context?cursor=abc`)
    expect(calls[1]!.limit).toBe(50)
    expect(calls[1]!.cursor).toBe("abc")
  })

  test("human claim（sessionID 为空串）→ 视为无会话", async () => {
    const { base, store } = await setup()
    const t = await store.create({ title: "人工" })
    await store.patch(t.id, { status: "pending" })
    await store.claim({ id: t.id, sessionID: "", agent: "human" })
    const r = await fetch(`${base}/api/tasks/${t.id}/context`)
    const body = (await r.json()) as ContextPage
    expect(body.sessionID).toBeNull()
  })
})

// ---------- v2 schema（session_message 内联 content；2026-10-20 真机实测形状）----------

function makeDbV2(): { db: Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "taskboard-ctx-v2-"))
  tmpDirs.push(dir)
  const path = join(dir, "opencode.db")
  const db = new Database(path)
  // 只建 v2 表：reader 若误查 legacy 表（message/part）将直接抛错，用例因此具备区分度
  db.run(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  return { db, path }
}

function seedV2(db: Database, id: string, sid: string, tc: number, type: string, data: unknown): void {
  db.run("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)", [id, sid, type, tc, tc, tc, JSON.stringify(data)])
}

describe("createContextReader（v2 schema）", () => {
  test("assistant 内联 content 归一化；user 文本；idle 事件排除", async () => {
    const { db, path } = makeDbV2()
    seedV2(db, "u1", "ses_v2", 1000, "user", { time: { created: 1000 }, text: "任务指令" })
    seedV2(db, "a1", "ses_v2", 2000, "assistant", {
      time: { created: 2000 },
      content: [
        { type: "reasoning", text: "先想一下" },
        { type: "text", text: "结论如下" },
        { type: "tool", id: "t1", name: "shell", executed: false, state: { status: "completed", input: { code: "ls" }, content: [{ type: "text", text: "a.ts" }, { type: "text", text: "b.ts" }] } },
      ],
    })
    seedV2(db, "i1", "ses_v2", 3000, "idle", { outcome: "success", time: 3000 })
    const reader = createContextReader({ dbPath: persist(path) })
    const page = await reader.read({ sessionID: "ses_v2" })
    // idle 是会话状态事件，不是消息
    expect(page.total).toBe(2)
    expect(page.page.map((m) => m.id)).toEqual(["a1", "u1"]) // 最新在前
    expect(page.page[1]!.parts).toEqual([{ type: "text", text: "任务指令" }])
    const parts = page.page[0]!.parts
    expect(parts[0]).toEqual({ type: "reasoning", text: "先想一下" })
    expect(parts[1]).toEqual({ type: "text", text: "结论如下" })
    // v2 工具形状：名字在 name，输出在 state.content 文本数组
    expect(parts[2]).toEqual({ type: "tool", tool: "shell", state: "completed", input: '{"code":"ls"}', output: "a.ts\nb.ts" })
  })

  test("游标翻页：同构复合游标不漏不重（同毫秒组被页界切开）", async () => {
    const { db, path } = makeDbV2()
    // 与 legacy 同款：10 条同毫秒 + 前后各 45 条，页大小 50 恰好把同毫秒组切在页界
    let tc = 1000
    for (let i = 0; i < 45; i++) seedV2(db, `a${String(i).padStart(3, "0")}`, "ses_v2", tc++, "assistant", { time: { created: tc }, content: [{ type: "text", text: "x" }] })
    for (let i = 0; i < 10; i++) seedV2(db, `b${String(i).padStart(3, "0")}`, "ses_v2", 2000, "assistant", { time: { created: 2000 }, content: [{ type: "text", text: "同毫秒" }] })
    for (let i = 0; i < 45; i++) seedV2(db, `c${String(i).padStart(3, "0")}`, "ses_v2", tc++, "assistant", { time: { created: tc }, content: [{ type: "text", text: "y" }] })
    const reader = createContextReader({ dbPath: persist(path) })
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page = await reader.read({ sessionID: "ses_v2", cursor, limit: 50 })
      seen.push(...page.page.map((m) => m.id))
      if (!page.hasMore) break
      cursor = page.nextCursor ?? undefined
    }
    expect(seen).toHaveLength(100)
    expect(new Set(seen).size).toBe(100)
  })

  test("坏数据行降级不炸整页：非对象 JSON（null/数组/标量）一律跳过", async () => {
    const { db, path } = makeDbV2()
    seedV2(db, "ok1", "ses_v2", 1000, "assistant", { time: { created: 1000 }, content: [{ type: "text", text: "正常" }] })
    seedV2(db, "bad1", "ses_v2", 2000, "assistant", null) // SQL NULL 列值
    db.run("UPDATE session_message SET data = 'null' WHERE id = 'bad1'")
    seedV2(db, "bad2", "ses_v2", 3000, "assistant", "123") // 标量 JSON
    seedV2(db, "bad3", "ses_v2", 4000, "assistant", "[1,2]") // 数组 JSON
    seedV2(db, "ok2", "ses_v2", 5000, "user", { time: { created: 5000 }, text: "也正常" })
    const reader = createContextReader({ dbPath: persist(path) })
    const page = await reader.read({ sessionID: "ses_v2" })
    expect(page.total).toBe(5) // 坏行仍计数（与 legacy 的「跳过 part 不丢消息」口径一致）
    expect(page.page.map((m) => m.id)).toEqual(["ok2", "bad3", "bad2", "bad1", "ok1"])
    expect(page.page.find((m) => m.id === "ok1")!.parts).toEqual([{ type: "text", text: "正常" }])
    expect(page.page.find((m) => m.id === "bad1")!.parts).toEqual([])
    expect(page.page.find((m) => m.id === "bad2")!.parts).toEqual([])
    expect(page.page.find((m) => m.id === "bad3")!.parts).toEqual([])
  })

  test("normalizePart 兼容 v2 tool 形状（name 字段 + state.content 文本数组）", () => {
    expect(
      normalizePart({ type: "tool", name: "read", state: { status: "completed", input: { path: "x.ts" }, content: [{ type: "text", text: "行1" }, { type: "text", text: "行2" }] } }),
    ).toEqual({ type: "tool", tool: "read", state: "completed", input: '{"path":"x.ts"}', output: "行1\n行2" })
    // 缺 name 也缺 tool → 问号兜底
    expect(normalizePart({ type: "tool", state: {} })).toEqual({ type: "tool", tool: "?" })
  })
})

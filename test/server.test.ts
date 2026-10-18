import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStore, memoryBackend } from "../src/store"
import { createServer, type ServerHandle } from "../src/server"
import { DEFAULT_PROJECT_ID, type Store } from "../src/types"

const FIXDIR = "test/.webroot-fixture"

const started: ServerHandle[] = []
afterEach(() => {
  while (started.length) started.pop()?.stop()
})

function setup(store: Store, extra: Partial<Parameters<typeof createServer>[1]> = {}) {
  const handle = createServer(store, {
    port: 0,
    token: "tok123",
    webDir: FIXDIR,
    primary: true,
    projectID: "proj-test",
    logs: () => ["line-a", "line-b"],
    ...extra,
  })
  started.push(handle)
  return `http://127.0.0.1:${handle.actualPort}`
}

const H = { "X-Taskboard-Token": "tok123", "Content-Type": "application/json" }

async function toCompletionConfirm(s: Store) {
  const t = await s.create({ title: "t" })
  await s.patch(t.id, { status: "pending" })
  await s.claim({ id: t.id, sessionID: "s1", agent: "build" })
  await s.analyze({ id: t.id, sessionID: "s1", analysis: "方案" })
  return s.complete({ id: t.id, sessionID: "s1", result: "完成" })
}

describe("REST API", () => {
  test("POST 创建 → 列表含之；PATCH 改标题", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const r1 = await fetch(`${base}/api/tasks`, { method: "POST", headers: H, body: JSON.stringify({ title: "新任务" }) })
    expect(r1.status).toBe(201)
    const created = (await r1.json()) as { id: string; status: string }
    expect(created.status).toBe("planning")

    const r2 = await fetch(`${base}/api/tasks`, { method: "GET" })
    const list = (await r2.json()) as { id: string }[]
    expect(list.map((x) => x.id)).toContain(created.id)

    const r3 = await fetch(`${base}/api/tasks/${created.id}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ title: "改名" }),
    })
    expect(((await r3.json()) as { title: string }).title).toBe("改名")
  })

  test("reject 无评论 → 400 comment_required；confirm 于 completion_confirm → done", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const t = await toCompletionConfirm(s)

    const r1 = await fetch(`${base}/api/tasks/${t.id}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ action: "reject" }),
    })
    expect(r1.status).toBe(400)
    expect(((await r1.json()) as { error: { code: string } }).error.code).toBe("comment_required")

    const r2 = await fetch(`${base}/api/tasks/${t.id}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ action: "confirm" }),
    })
    expect(((await r2.json()) as { status: string }).status).toBe("done")
  })

  test("无 token → 403；token 对但非 JSON Content-Type → 415；GET 免 token", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const r1 = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    })
    expect(r1.status).toBe(403)

    const r2 = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "X-Taskboard-Token": "tok123", "Content-Type": "text/plain" },
      body: JSON.stringify({ title: "x" }),
    })
    expect(r2.status).toBe(415)

    const r3 = await fetch(`${base}/api/tasks`)
    expect(r3.status).toBe(200)
  })

  test("PUT settings 后 GET 返回新值且 store 行为改变", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const r1 = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ requireAnalysisConfirm: true }),
    })
    expect(r1.status).toBe(200)

    const r2 = await fetch(`${base}/api/settings`)
    expect(((await r2.json()) as { requireAnalysisConfirm: boolean }).requireAnalysisConfirm).toBe(true)

    const t = await s.create({ title: "t" })
    await s.patch(t.id, { status: "pending" })
    await s.claim({ id: t.id, sessionID: "s1", agent: "build" })
    const r3 = await s.analyze({ id: t.id, sessionID: "s1", analysis: "a" })
    expect(r3.status).toBe("analysis_confirm")
  })

  test("PUT settings 合并语义：只提交一个字段不抹掉另一个", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    await s.setSettings({ autoDispatch: true })

    const r = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ requireAnalysisConfirm: true }),
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ requireAnalysisConfirm: true, autoDispatch: true })

    // 非布尔 → 400
    const bad = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ autoDispatch: "on" }),
    })
    expect(bad.status).toBe(400)
    // 空 patch → 400
    const empty = await fetch(`${base}/api/settings`, { method: "PUT", headers: H, body: JSON.stringify({}) })
    expect(empty.status).toBe(400)
  })

  test("写操作触发 onWrite 观察者（自动派发器挂点）", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    let calls = 0
    const base = setup(s, { onWrite: () => calls++ })
    await fetch(`${base}/api/tasks`, { method: "POST", headers: H, body: JSON.stringify({ title: "t" }) })
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toBe(1)
  })

  test("health / logs / 未知 API 路径", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const h = await (await fetch(`${base}/api/health`)).json()
    expect(h).toEqual({ ok: true, primary: true, projectID: "proj-test" })
    const l = await (await fetch(`${base}/api/logs`)).json()
    expect(l).toEqual({ logs: ["line-a", "line-b"] })
    const r = await fetch(`${base}/api/nope`)
    expect(r.status).toBe(404)
    expect((await r.json()) as { error: unknown }).toHaveProperty("error")
  })

  test("StoreError 映射：not_found → 404", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const r = await fetch(`${base}/api/tasks/task_nope`, { method: "PATCH", headers: H, body: JSON.stringify({ title: "x" }) })
    expect(r.status).toBe(404)
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("not_found")
  })

  test("DELETE 不带 Content-Type 也成功；错 token 仍 403", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const created = await (await fetch(`${base}/api/tasks`, { method: "POST", headers: H, body: JSON.stringify({ title: "待删" }) })).json()

    const ok = await fetch(`${base}/api/tasks/${created.id}`, { method: "DELETE", headers: { "X-Taskboard-Token": "tok123" } })
    expect(ok.status).toBe(200)

    const again = await fetch(`${base}/api/tasks/${created.id}`, { method: "DELETE", headers: { "X-Taskboard-Token": "tok123" } })
    expect(again.status).toBe(404)

    const deny = await fetch(`${base}/api/tasks/task_x`, { method: "DELETE", headers: { "X-Taskboard-Token": "wrong" } })
    expect(deny.status).toBe(403)
  })

  test("GET /api/tasks/:id 返回单条；未知 id → 404", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const created = await (await fetch(`${base}/api/tasks`, { method: "POST", headers: H, body: JSON.stringify({ title: "单查" }) })).json()

    const one = await fetch(`${base}/api/tasks/${created.id}`)
    expect(one.status).toBe(200)
    expect(((await one.json()) as { id: string }).id).toBe(created.id)

    const miss = await fetch(`${base}/api/tasks/task_nope`)
    expect(miss.status).toBe(404)
    expect(((await miss.json()) as { error: { code: string } }).error.code).toBe("not_found")
  })
})

describe("工具操作代理路由", () => {
  async function setupStore() {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    return { s, base }
  }

  test("POST /api/claim 无 id 领最旧 pending；analyze/complete 闭环", async () => {
    const { s, base } = await setupStore()
    for (const title of ["甲", "乙"]) {
      const t = await s.create({ title })
      await s.patch(t.id, { status: "pending" })
    }
    const pend = (await (await fetch(`${base}/api/tasks`)).json()) as { id: string }[]

    const r1 = await fetch(`${base}/api/claim`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ sessionID: "sess-1" }),
    })
    expect(r1.status).toBe(200)
    const claimed = (await r1.json()) as { id: string; status: string }
    expect(claimed.status).toBe("analyzing")
    expect(pend.map((p) => p.id)).toContain(claimed.id)

    const r2 = await fetch(`${base}/api/tasks/${claimed.id}/analyze`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ sessionID: "sess-1", analysis: "方案" }),
    })
    expect(((await r2.json()) as { status: string }).status).toBe("executing")

    const r3 = await fetch(`${base}/api/tasks/${claimed.id}/complete`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ sessionID: "sess-1", result: "ok" }),
    })
    expect(((await r3.json()) as { status: string }).status).toBe("completion_confirm")
  })

  test("release 与 notes 路由；未领取者 → 400 not_claimer", async () => {
    const { s, base } = await setupStore()
    const t = await s.create({ title: "t" })
    await s.patch(t.id, { status: "pending" })

    const r0 = await fetch(`${base}/api/tasks/${t.id}/analyze`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ sessionID: "nobody", analysis: "x" }),
    })
    expect(r0.status).toBe(400)
    expect(((await r0.json()) as { error: { code: string } }).error.code).toBe("invalid_transition")

    await fetch(`${base}/api/claim`, { method: "POST", headers: H, body: JSON.stringify({ sessionID: "sess-9" }) })

    const r1 = await fetch(`${base}/api/tasks/${t.id}/analyze`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ sessionID: "nobody", analysis: "x" }),
    })
    expect(r1.status).toBe(400)
    expect(((await r1.json()) as { error: { code: string } }).error.code).toBe("not_claimer")

    await fetch(`${base}/api/claim`, { method: "POST", headers: H, body: JSON.stringify({ sessionID: "sess-9" }) })
    const rn = await fetch(`${base}/api/tasks/${t.id}/notes`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ sessionID: "sess-9", result: "进度 30%" }),
    })
    expect(((await rn.json()) as { result: string }).result).toBe("进度 30%")

    const rr = await fetch(`${base}/api/tasks/${t.id}/release`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ sessionID: "sess-9" }),
    })
    expect(((await rr.json()) as { status: string; claim: unknown }).status).toBe("pending")
  })
})

describe("静态页", () => {
  test("GET / 注入 token；不存在文件 404 JSON", async () => {
    mkdirSync(FIXDIR, { recursive: true })
    writeFileSync(
      `${FIXDIR}/index.html`,
      '<html><script>window.__TASKBOARD_TOKEN__ = "__TASKBOARD_TOKEN_VALUE__";</script>TOKEN=__TASKBOARD_TOKEN_VALUE__</html>',
    )
    try {
      const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
      const base = setup(s)
      const r = await fetch(`${base}/`)
      const body = await r.text()
      expect(body).toContain('window.__TASKBOARD_TOKEN__ = "tok123"')
      expect(body).toContain("TOKEN=tok123")
      expect(body).not.toContain("__TASKBOARD_TOKEN_VALUE__")

      const r2 = await fetch(`${base}/no-such.js`)
      expect(r2.status).toBe(404)
      expect((await r2.json()) as { error: unknown }).toHaveProperty("error")
    } finally {
      rmSync(FIXDIR, { recursive: true, force: true })
    }
  })
})

describe("SSE 连接稳定性（idleTimeout 回归守护）", () => {
  // 环境差异说明（终审实测）：Bun 1.4.3 CLI 下，ReadableStream 响应若在 start 后异步入队再短暂
  // 静默，会被设 Content-Length 并立即 EOF——本测试环境无法表达 opencode 运行时的真实 SSE 行为
  // （后者 45s 实测 chunked 持续）。故只做源文本断言钉住配置；行为验证依赖真实浏览器（无头复现脚本
  // 见 /tmp/opencode/switch-debug/）。
  test("Bun.serve 配置 idleTimeout: 255（源文本断言）", () => {
    const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8")
    expect(src).toContain("idleTimeout: 255")
  })
})

describe("模型列表路由", () => {
  test("GET /api/models 返回注入的模型清单(读路径无鉴权,与 tasks/logs 一致)", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s, {
      listModels: async () => ["zhipuai-coding-plan/glm-5.3-flash", "minimax-cn-coding-plan/MiniMax-M3.1"],
    })
    const r = await fetch(`${base}/api/models`).then((x) => x.json())
    expect(r).toEqual({
      models: ["zhipuai-coding-plan/glm-5.3-flash", "minimax-cn-coding-plan/MiniMax-M3.1"],
    })
  })

  test("未注入 listModels 时返回空列表(前端下拉退化+提示)", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const r = await fetch(`${base}/api/models`).then((x) => x.json())
    expect(r).toEqual({ models: [] })
  })
})

describe("项目 API", () => {
  const realDir = () => mkdtempSync(join(tmpdir(), "tb-proj-"))

  test("GET /api/projects 无鉴权返回含合成默认项目", async () => {
    const base = setup(createStore(memoryBackend(), { requireAnalysisConfirm: false }))
    const r = await fetch(`${base}/api/projects`)
    expect(r.status).toBe(200)
    const { projects } = (await r.json()) as { projects: { id: string; name: string }[] }
    expect(projects[0]).toMatchObject({ id: DEFAULT_PROJECT_ID, name: "默认项目" })
  })

  test("POST 无 token → 403", async () => {
    const base = setup(createStore(memoryBackend(), { requireAnalysisConfirm: false }))
    const r = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    expect(r.status).toBe(403)
  })

  test("POST 相对路径/不存在目录/指向文件 → 400 invalid_input 文案含路径", async () => {
    const base = setup(createStore(memoryBackend(), { requireAnalysisConfirm: false }))
    const dir = realDir()
    const file = join(dir, "f.txt")
    writeFileSync(file, "x")
    for (const workspace of ["relative/path", join(dir, "nope"), file]) {
      const r = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ name: `N-${workspace}`, workspace }),
      })
      expect(r.status).toBe(400)
      const body = (await r.json()) as { error: { code: string; message: string } }
      expect(body.error.code).toBe("invalid_input")
      expect(body.error.message).toContain(workspace)
    }
    rmSync(dir, { recursive: true, force: true })
  })

  test("POST 合法目录 → 201 落库;重名 → 400 conflict", async () => {
    const base = setup(createStore(memoryBackend(), { requireAnalysisConfirm: false }))
    const dir = realDir()
    const r1 = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ name: "网关", workspace: dir }),
    })
    expect(r1.status).toBe(201)
    const r2 = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ name: "网关", workspace: dir }),
    })
    expect(r2.status).toBe(400)
    expect(((await r2.json()) as { error: { code: string } }).error.code).toBe("conflict")
    rmSync(dir, { recursive: true, force: true })
  })

  test("PATCH 改名成功;DELETE 非 done 守卫 → 400;仅 done → 200 且任务被级联", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const dir = realDir()
    const p = await s.createProject({ name: "P", workspace: dir })
    const t1 = await s.create({ title: "进行中", projectId: p.id })
    const rd = await fetch(`${base}/api/projects/${p.id}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ name: "P2" }),
    })
    expect(rd.status).toBe(200)
    const rDel = await fetch(`${base}/api/projects/${p.id}`, { method: "DELETE", headers: H })
    expect(rDel.status).toBe(400)
    await s.patch(t1.id, { status: "done" })
    const rDel2 = await fetch(`${base}/api/projects/${p.id}`, { method: "DELETE", headers: H })
    expect(rDel2.status).toBe(200)
    const tasks = (await (await fetch(`${base}/api/tasks`)).json()) as { id: string }[]
    expect(tasks.map((x) => x.id)).not.toContain(t1.id)
    rmSync(dir, { recursive: true, force: true })
  })

  test("SSE 首个 snapshot 事件含 projects 数组(默认项目打头)", async () => {
    const base = setup(createStore(memoryBackend(), { requireAnalysisConfirm: false, directory: "/proj" }))
    const res = await fetch(`${base}/api/events`)
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const { value } = await reader.read()
    const frames = new TextDecoder()
      .decode(value)
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
    const evt = frames.map((f) => JSON.parse(f.slice(6))).find((e) => e.type === "snapshot")
    expect(evt.projects[0]).toMatchObject({ id: DEFAULT_PROJECT_ID, workspace: "/proj" })
    await reader.cancel()
  })

  test("POST /api/tasks 带 projectId 落正确归属;不带落默认项目", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const p = await s.createProject({ name: "P", workspace: realDir() })
    const r1 = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ title: "归属", projectId: p.id }),
    })
    expect(((await r1.json()) as { projectId: string }).projectId).toBe(p.id)
    const r2 = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ title: "缺省" }),
    })
    expect(((await r2.json()) as { projectId: string }).projectId).toBe(DEFAULT_PROJECT_ID)
  })
})

describe("项目 API 补遗(审查 I-1)", () => {
  test("GET /api/projects/:id 返回项目(次要实例代理链依赖)", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const p = await s.createProject({ name: "代理链", workspace: process.cwd() })
    const r = await fetch(`${base}/api/projects/${p.id}`)
    expect(r.status).toBe(200)
    expect(((await r.json()) as { id: string }).id).toBe(p.id)
  })
})

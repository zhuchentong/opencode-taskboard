# 代理链硬化（proxy hardening）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复代理链审查发现的 1 个高危边界漏洞（同项目双主 split-brain）与 2 个健壮性短板（fetch 无超时、网络错误不归一化），顺带完成 3 个低优先级改进（DELETE 免 Content-Type、错误码类型诚实化、任务单查路由）。

**架构：** 保持「写者唯一 + 次要实例全量代理」模型不变。改动集中在四处：错误契约扩两个码（`unreachable`/`forbidden`）；`clientStore` 加请求超时与网络错误归一化；`arbitrate` 对「绑不上」的溢出端口做 health 探测，发现同项目主实例则降级代理而不是自己当主；server 的 `guard` 拆出 body 可空场景。

**技术栈：** Bun + TypeScript，bun:test（仓库既有模式：`port: 0` 随机端口、`started[]`/`try-finally` 清理）。

**规格：** 依据本仓库 `AGENTS.md` 硬约束、`docs/superpowers/specs/2026-10-16-taskboard-plugin-design.md` §9（并发与实例模型），以及 2026-10-17 代理质量审查结论（双主 split-brain、无超时、错误不归一化、DELETE 415、类型谎言、O(n) 单查）。

## 全局约束

- `bun test` 是唯一验收门；每个任务收尾全量 `bun test` 必须全绿（当前基线 228 pass / 18 文件）。
- 新增错误码必须三处同步：`types.ts` 的 `STORE_ERROR_CODES`、`server.ts` 的 `STATUS_BY_CODE`、`tools.ts` 的 `describeError`。
- server 的写路由必须 `await emitSnapshot()`（本计划新增的路由 `GET /api/tasks/:id` 是读，不需要）。
- 注释、测试描述、提交信息一律中文；提交信息走 `commit-message-validate`（≤72 字符、`type: emoji 中文`）。
- 本计划不动 `webapp/`，`src/web/` 产物无需重建。
- 不改「读路径无鉴权、绑定 127.0.0.1」的既定 stance（知情决策，任务 5 写进文档即可）。

## 审查重点（Review Focus）

1. 基准端口被异构服务占用 + 同项目第二实例启动 → 期待：第二实例探测到溢出端口上的同项目主实例后**降级代理**，绝不出现第二个主实例（钉住：任务 3 测试 1）。
2. 主实例进程死亡 → 期待：次要实例的工具调用**快速失败**且文案可操作（提示重启），而非无限悬挂（钉住：任务 1 超时与连接拒绝测试）。
3. 候选溢出端口被异构服务占用 → 期待：仲裁跳过该端口继续上移，不误判不误绑（钉住：任务 3 测试 2）。
4. 令牌失配（storage 重置等）→ 期待：Agent 收到保留 403 语义的可操作文案，而非被吞成「任务冲突」（钉住：任务 1 forbidden 映射测试）。
5. 无 body 的 DELETE 请求 → 期待：200 成功，不被介质类型校验误拒（钉住：任务 2 测试）。

---

### 任务 1：错误契约扩展 + `clientStore` 超时与网络错误归一化

**文件：**
- 修改：`src/types.ts`（`StoreErrorCode` 段，约 64-72 行）
- 修改：`src/server.ts:22-30`（`STATUS_BY_CODE`）
- 修改：`src/tools.ts:198-222`（`describeError`）
- 修改：`src/client.ts`（`clientStore` 全体）
- 测试：`test/client.test.ts`、`test/tools.test.ts`

- [ ] **步骤 1：编写失败的测试**

`test/client.test.ts` 末尾追加（沿用该文件既有的 `Bun.serve` + try/finally 风格）：

```ts
test("连接拒绝 → unreachable；响应悬挂 → 超时归一为 unreachable", async () => {
  // 连接拒绝：先起后停，拿到确定拒绝的端口
  const dead = Bun.serve({ port: 0, fetch: () => new Response("x") })
  const deadPort = dead.port
  dead.stop(true)
  const s1 = clientStore(`http://127.0.0.1:${deadPort}`, "t")
  try { await s1.list(); expect.unreachable() }
  catch (e) { expect((e as { code?: string }).code).toBe("unreachable") }

  // 响应悬挂：服务延迟 300ms，客户端超时 50ms
  const slow = Bun.serve({ port: 0, fetch: async () => { await Bun.sleep(300); return Response.json([]) } })
  try {
    const s2 = clientStore(`http://127.0.0.1:${slow.port}`, "t", { timeoutMs: 50 })
    try { await s2.list(); expect.unreachable() }
    catch (e) { expect((e as { code?: string }).code).toBe("unreachable") }
  } finally { slow.stop(true) }
})

test("服务端未知错误码还原为 conflict；forbidden 保留语义", async () => {
  const weird = Bun.serve({ port: 0, fetch: () => Response.json({ error: { code: "weird", message: "怪码" } }, { status: 400 }) })
  try {
    const s = clientStore(`http://127.0.0.1:${weird.port}`, "t")
    try { await s.list(); expect.unreachable() }
    catch (e) { expect((e as { code?: string; message?: string }).message).toContain("怪码") }
  } finally { weird.stop(true) }

  const deny = Bun.serve({ port: 0, fetch: () => Response.json({ error: { code: "forbidden", message: "令牌错" } }, { status: 403 }) })
  try {
    const s = clientStore(`http://127.0.0.1:${deny.port}`, "t")
    try { await s.list(); expect.unreachable() }
    catch (e) { expect((e as { code?: string }).code).toBe("forbidden") }
  } finally { deny.stop(true) }
})
```

`test/tools.test.ts` 追加：

```ts
test("describeError：unreachable 与 forbidden 给出可操作文案", () => {
  expect(describeError(new StoreError("unreachable", "连不上"))).toContain("不可达")
  expect(describeError(new StoreError("forbidden", "令牌错"))).toContain("令牌")
})
```

（`tools.test.ts` 若尚未导入 `StoreError`/`describeError`，从 `../src/types`、`../src/tools` 补导入。）

- [ ] **步骤 2：运行测试验证失败**

运行：`bun test test/client.test.ts test/tools.test.ts`
预期：FAIL——`unreachable`/`forbidden` 断言拿到的是 `conflict`；`timeoutMs` 选项不存在导致悬挂用例超时失败。

- [ ] **步骤 3：实现**

`src/types.ts`——把现有 `StoreErrorCode` 联合改为「常量数组派生」，并加类型守卫（单一事实源）：

```ts
export const STORE_ERROR_CODES = [
  "not_found", "invalid_transition", "conflict", "not_claimer",
  "comment_required", "no_pending", "invalid_input", "unreachable", "forbidden",
] as const
export type StoreErrorCode = (typeof STORE_ERROR_CODES)[number]
export function isStoreErrorCode(c: unknown): c is StoreErrorCode {
  return typeof c === "string" && (STORE_ERROR_CODES as readonly string[]).includes(c)
}
```

`src/server.ts` 的 `STATUS_BY_CODE` 增加：`unreachable: 503, forbidden: 403`。

`src/tools.ts` 的 `describeError` switch 增加两个 case：

- `unreachable` → `` `看板服务不可达：${msg}（主实例可能已退出，请让用户重启 OpenCode 会话）` ``
- `forbidden` → `` `访问被拒绝：令牌不匹配。${msg}（请让用户重启会话以重新同步令牌）` ``

`src/client.ts`——`clientStore` 签名加第三参：

```ts
export function clientStore(base: string, token: string, opts?: { timeoutMs?: number }): Store
```

`call()` 内：`const timeoutMs = opts?.timeoutMs ?? 10_000`；fetch 挂 `signal: AbortSignal.timeout(timeoutMs)`，并把 fetch 调用包进 try/catch，网络层异常（含超时中断）统一抛 `new StoreError("unreachable", \`无法连接主实例 ${base}\`)`。响应错误映射处用类型守卫替换撒谎的 as：`isStoreErrorCode(err?.code) ? err.code : "conflict"`。

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test`（全量）
预期：PASS，全绿（基线 228 例 + 本任务新增约 3 例）。

- [ ] **步骤 5：Commit**

```bash
git add -A && git commit
```

提交信息：`fix: 🐛 代理链健壮化——unreachable/forbidden 错误契约与请求超时`

---

### 任务 2：`guard` 拆分——无 body 的 DELETE 免 Content-Type

**文件：**
- 修改：`src/server.ts:63-72`（`guard`）与 `:266-272`（DELETE 分支）
- 测试：`test/server.test.ts`

- [ ] **步骤 1：编写失败的测试**

`test/server.test.ts` 的 `REST API` describe 内追加：

```ts
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`bun test test/server.test.ts`
预期：FAIL——首个 DELETE 返回 415。

- [ ] **步骤 3：实现**

`guard` 加第二参 `json = true`：token 校验恒做；Content-Type 校验仅 `json` 为真时做。DELETE 分支改为 `guard(req, false)`，其余调用点不变。

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test`（全量）
预期：PASS，全绿。

- [ ] **步骤 5：Commit**

提交信息：`fix: 🐛 无 body 的 DELETE 不再强制 Content-Type`

---

### 任务 3：`arbitrate` 重构——忙端口探测，杜绝同项目双主

**文件：**
- 修改：`src/index.ts:35-97`（`arbitrate`，改为导出）与 `:129-139`（setup 调用点，去掉 `proxyStore` 实参）
- 测试：`test/index.test.ts`

- [ ] **步骤 1：编写失败的测试**

`test/index.test.ts` 追加（该文件只测纯函数，新增用例自备服务器并负责清理）：

```ts
test("双主防治：基准端口异构占用时，第二实例探测溢出端口上的同项目主实例后降级代理", async () => {
  const foreign = Bun.serve({ port: 0, fetch: () => new Response("foreign") })
  const base = foreign.port
  const mkStore = () => createStore(memoryBackend(), { requireAnalysisConfirm: false })
  const opts = { port: base, token: "tok", webDir: "test", projectID: "proj-arb", log: () => {}, logs: () => [] as string[], hooks: {} }
  try {
    const A = await arbitrate({ ...opts, localStore: mkStore() })
    expect(A.primary).toBe(true)
    expect(A.primaryPort).toBeGreaterThan(base)

    const B = await arbitrate({ ...opts, localStore: mkStore() })
    expect(B.primary).toBe(false)
    // B 的写必须落到 A 的存储（代理目标是被上移的 A，不是基准端口）
    const t = await B.store.create({ title: "经 B 写" })
    expect((await A.store.list()).map((x) => x.id)).toContain(t.id)
    const health = await (await fetch(`http://127.0.0.1:${B.handle.actualPort}/api/health`)).json()
    expect(health).toMatchObject({ ok: true, primary: false, projectID: "proj-arb" })
    A.handle.stop(); B.handle.stop()
  } finally { foreign.stop(true) }
})

test("异构服务占用基准与首个溢出端口 → 主实例跳过继续上移", async () => {
  const foreign = Bun.serve({ port: 0, fetch: () => new Response("f") })
  let squatter: Bun.Server | undefined
  try {
    // 在基准端口的下一个端口放一个异构占位者；被占则整体换起点重试
    for (let attempt = 0; attempt < 10 && !squatter; attempt++) {
      const p = foreign.port + 1 + attempt
      try { squatter = Bun.serve({ port: p, fetch: () => new Response("s") }) } catch { /* 被占，换下一个 */ }
    }
    const A = await arbitrate({ port: foreign.port, token: "tok", webDir: "test", projectID: "proj-arb2", localStore: createStore(memoryBackend(), { requireAnalysisConfirm: false }), log: () => {}, logs: () => [] as string[], hooks: {} })
    expect(A.primary).toBe(true)
    expect(A.primaryPort).toBeGreaterThanOrEqual(squatter!.port + 1)
    A.handle.stop()
  } finally { foreign.stop(true); squatter?.stop(true) }
})

test("基准端口空闲 → 直接当主（回归）", async () => {
  const free = Bun.serve({ port: 0, fetch: () => new Response("x") })
  const port = free.port
  free.stop(true)
  const A = await arbitrate({ port, token: "tok", webDir: "test", projectID: "proj-arb3", localStore: createStore(memoryBackend(), { requireAnalysisConfirm: false }), log: () => {}, logs: () => [] as string[], hooks: {} })
  expect(A.primary).toBe(true)
  expect(A.primaryPort).toBe(port)
  A.handle.stop()
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`bun test test/index.test.ts`
预期：FAIL——`arbitrate` 未导出（编译期即可见），或测试 1 中 B 变成第二个主实例（`B.primary === true`）。

- [ ] **步骤 3：实现**

`src/index.ts`：

1. `arbitrate` 加 `export`；签名删掉 `proxyStore` 参数（`clientStore` 已在文件顶部导入，代理实例改为在 `arbitrate` 内部按探测到的主实例地址构造）。
2. 抽出探测助手（信号超时 2s，失败返回 `undefined`）：

```ts
async function probeHealth(port: number): Promise<{ ok?: boolean; primary?: boolean; projectID?: string } | undefined>
```

3. 仲裁流程改为：

```
tryBind(base, local, primary) 成功 → 主实例 @base（原样）
否则 probeHealth(base)：
  - shouldProxy(health, projectID) 为真 → 次要实例，扫描 base+1..base+19 绑代理实例，代理目标 base（原样）
  - 否则（异构/无响应）→ 扫描 p = base+1..base+19：
      tryBind(p, local, primary) 成功 → 主实例 @p（空闲端口无需探测）
      绑定失败（端口忙）→ hp = probeHealth(p)：
          shouldProxy(hp, projectID) 为真 → 次要实例：扫描 base+1..base+19 找空闲口，
            绑定代理实例，代理目标 `http://127.0.0.1:${p}`，日志注明「发现同项目主实例上移端口 p」
          否则 → 继续扫描下一个 p
      扫描耗尽 → throw（文案沿用现有「无法找到可用端口」）
```

4. setup() 调用点删掉 `proxyStore: clientStore(...)` 实参；日志文案把「写操作代理到」的目标端口改为实际主实例端口。

实现提示：`tryBind` 失败的端口必然有服务占用，探测只发生在「绑定失败」之后，空闲端口零探测开销；`probeHealth` 对非 JSON 响应要 catch（异构服务可能返回任意内容）。

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test`（全量）
预期：PASS，全绿。`shouldProxy`/`safeRegister` 既有用例不受影响（签名未动）。

- [ ] **步骤 5：Commit**

提交信息：`fix: 🐛 仲裁探测溢出端口——杜绝同项目双主 split-brain`

---

### 任务 4（低优先，可裁剪）：任务单查路由 `GET /api/tasks/:id`

**文件：**
- 修改：`src/server.ts:256-273`（`taskMatch` 分支）
- 修改：`src/client.ts`（`get`）
- 测试：`test/server.test.ts`

- [ ] **步骤 1：编写失败的测试**

`test/server.test.ts` 追加：

```ts
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`bun test test/server.test.ts`
预期：FAIL——当前该路径 GET 落到 404「未知 API 路径」。

- [ ] **步骤 3：实现**

`taskMatch` 分支加：`if (method === "GET") return Response.json(await store.get(id))`（读路径，不加 guard）。`client.ts` 的 `get` 改为 `call<Task>(\`/api/tasks/${encodeURIComponent(id)}\`)`——四处同步点中接口与本地实现本就存在，此改动覆盖 client 与 server 两处。

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test`（全量）
预期：PASS，全绿。

- [ ] **步骤 5：Commit**

提交信息：`feat: ✨ 任务单查路由 GET /api/tasks/:id——代理 get 不再全量拉列表`

---

### 任务 5：文档同步 + 终验

**文件：**
- 修改：`AGENTS.md`（「写者唯一 + 三向端口仲裁」条目）
- 修改：`docs/superpowers/specs/2026-10-16-taskboard-plugin-design.md`（§9 末尾追加一段）

- [ ] **步骤 1：更新 AGENTS.md 硬约束条目**

「写者唯一 + 三向端口仲裁」改为「写者唯一 + 四向端口仲裁」，要点：基准端口空闲→主实例；被同项目主实例占用→次要实例全量代理；被异构服务占用→**上移扫描时对绑定失败的端口做 health 探测（2s 超时），发现同项目主实例则降级代理到它**，否则上移当主。同一条目补两句：代理请求统一 10s 超时、网络层错误归一为 `unreachable`（Agent 收到「看板服务不可达」文案）；读路径无鉴权属知情决策（127.0.0.1 绑定 + 写凭 token）。

- [ ] **步骤 2：更新 spec §9**

在 §9 末尾追加一小段，记录四向仲裁与「忙端口探测」规则、`unreachable`/`forbidden` 错误码、代理超时 10s。口径与 AGENTS.md 一致，不展开实现细节。

- [ ] **步骤 3：终验**

运行：`bun test`（全量）
预期：全绿，用例数 > 228。

用户手动验收（本计划不执行——`opencode service restart` 会重启用户正在使用的服务）：重启后开同项目第二个会话，`GET /api/logs` 确认次要实例日志出现「发现同项目主实例上移端口」或既有「写操作代理到」文案，两窗口看板均实时刷新。

- [ ] **步骤 4：Commit**

提交信息：`docs: 📝 代理四向仲裁与超时错误契约同步文档`

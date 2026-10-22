import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { shouldProxy, safeRegister, arbitrate } from "../src/index"
import { listModels, stripJsonComments, providerAllowedByPolicies } from "../src/models"
import { createStore, memoryBackend } from "../src/store"

describe("shouldProxy（端口仲裁：仅同项目主实例才降级为次要实例）", () => {
  test("同项目主实例 → 代理", () => {
    expect(shouldProxy({ ok: true, projectID: "p1" }, "p1")).toBe(true)
  })
  test("不同项目 → 不代理（上移端口当主实例）", () => {
    expect(shouldProxy({ ok: true, projectID: "p2" }, "p1")).toBe(false)
  })
  test("health 无 projectID（旧版本/异构服务）→ 不代理", () => {
    expect(shouldProxy({ ok: true }, "p1")).toBe(false)
  })
  test("非 taskboard 服务 → 不代理", () => {
    expect(shouldProxy({ ok: false }, "p1")).toBe(false)
    expect(shouldProxy({ hello: "world" }, "p1")).toBe(false)
  })
})

describe("safeRegister（注册失败时停掉已绑定的服务）", () => {
  test("全部成功 → 不停服", async () => {
    let stopped = false
    await safeRegister({ stop: () => (stopped = true) }, [async () => 1, async () => 2])
    expect(stopped).toBe(false)
  })
  test("中途抛错 → 停服且异常继续上抛", async () => {
    let stopped = false
    const boom = new Error("register failed")
    try {
      await safeRegister({ stop: () => (stopped = true) }, [
        async () => 1,
        async () => {
          throw boom
        },
      ])
      expect.unreachable()
    } catch (e) {
      expect(e).toBe(boom)
    }
    expect(stopped).toBe(true)
  })
})

describe("arbitrate（忙端口探测：杜绝同项目双主）", () => {
  const ARB_OPTS = {
    token: "tok",
    webDir: "test",
    projectID: "proj-arb",
    log: () => {},
    logs: () => [] as string[],
    hooks: {},
  }
  const mkStore = async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    // 建任务门禁:先配齐阶段模型
    await s.setSettings({ modelAnalyze: "test/analyze", modelExecute: "test/execute" })
    return s
  }

  test("基准端口异构占用 → 首实例上移当主；第二实例探测到同项目主实例后降级代理", async () => {
    const foreign = Bun.serve({ port: 0, fetch: () => new Response("foreign") })
    // Bun 1.4 类型里 Server.port 因 unix socket 监听场景可空；此处 TCP port:0 必有实际端口，非空断言收窄
    const foreignPort = foreign.port!
    try {
      const A = await arbitrate({ ...ARB_OPTS, port: foreignPort, localStore: await mkStore() })
      expect(A.primary).toBe(true)
      expect(A.primaryPort).toBeGreaterThan(foreignPort)

      const B = await arbitrate({ ...ARB_OPTS, port: foreignPort, localStore: await mkStore() })
      expect(B.primary).toBe(false)
      // B 的写必须落到 A 的存储（代理目标是被上移的 A，不是基准端口）
      const t = await B.store.create({ title: "经 B 写" })
      expect((await A.store.list()).map((x) => x.id)).toContain(t.id)
      const health = await (await fetch(`http://127.0.0.1:${B.handle.actualPort}/api/health`)).json()
      expect(health).toMatchObject({ ok: true, primary: false, projectID: "proj-arb" })
      A.handle.stop()
      B.handle.stop()
    } finally {
      foreign.stop(true)
    }
  })

  test("异构服务占用基准与首个溢出端口 → 主实例跳过继续上移", async () => {
    const foreign = Bun.serve({ port: 0, fetch: () => new Response("f") })
    // 同上：TCP port:0 必有实际端口，非空断言收窄
    const foreignPort = foreign.port!
    // 泛型参数与 src/server.ts 的 ServerHandle 一致（Bun 1.4 的 Server 必须带 WebSocketData 类型参数）
    let squatter: Bun.Server<{ sessionID?: string }> | undefined
    try {
      for (let attempt = 0; attempt < 10 && !squatter; attempt++) {
        const p = foreignPort + 1 + attempt
        try {
          squatter = Bun.serve({ port: p, fetch: () => new Response("s") })
        } catch {
          // 被占，换下一个
        }
      }
      const A = await arbitrate({ ...ARB_OPTS, port: foreignPort, projectID: "proj-arb2", localStore: await mkStore() })
      expect(A.primary).toBe(true)
      // squatter 由循环守卫保证已绑定；TCP 监听 port 必有值，两处非空断言仅收窄类型
      expect(A.primaryPort).toBeGreaterThanOrEqual(squatter!.port! + 1)
      A.handle.stop()
    } finally {
      foreign.stop(true)
      squatter?.stop(true)
    }
  })

  test("基准端口空闲 → 直接当主（回归）", async () => {
    const free = Bun.serve({ port: 0, fetch: () => new Response("x") })
    // 同上：TCP port:0 必有实际端口，非空断言收窄
    const port = free.port!
    free.stop(true)
    const A = await arbitrate({ ...ARB_OPTS, port, projectID: "proj-arb3", localStore: await mkStore() })
    expect(A.primary).toBe(true)
    expect(A.primaryPort).toBe(port)
    A.handle.stop()
  })
})

describe("stripJsonComments（状态机剥注释：字符串内 // 与转义原样保留）", () => {
  test("行注释/块注释移除,字符串内 // 保留", () => {
    const src = `{
      // 行注释
      /* 块注释 */
      "url": "https://opencode.ai/config.json",
      "note": "转义 \\" 引号 // 不是注释",
      "n": 1
    }`
    const out = stripJsonComments(src)
    expect(() => JSON.parse(out)).not.toThrow()
    const parsed = JSON.parse(out)
    expect(parsed.url).toBe("https://opencode.ai/config.json")
    expect(parsed.note).toBe(`转义 " 引号 // 不是注释`)
  })
})

describe("listModels（三路并集:opencode 配置 ∪ auth.json ∪ env 命中;jsonc 兼容）", () => {
  let home = ""
  beforeEach(async () => {
    home = await mkdtemp(join("/tmp/opencode", "tb-models-"))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  const META = JSON.stringify({
    "prov-a": { models: { "m-1": {}, "m-2": {} } },
    "prov-b": { models: { "m-9": {} } },
    "prov-env": { env: ["PROV_ENV_KEY"], models: { "m-e": {} } },
  })

  async function writeFiles(files: Record<string, string>) {
    for (const [rel, content] of Object.entries(files)) {
      const p = join(home, rel)
      await mkdir(join(p, ".."), { recursive: true })
      await writeFile(p, content)
    }
  }

  test("读 opencode.json × 元数据交集展开", async () => {
    await writeFiles({
      ".config/opencode/opencode.json": JSON.stringify({ providers: { "prov-a": { models: {} } } }),
      ".cache/opencode/models.json": META,
    })
    expect(await listModels({ home, env: {} })).toEqual(["prov-a/m-1", "prov-a/m-2"])
  })

  test("jsonc 回退:注释与字符串内 // 不被误剥", async () => {
    await writeFiles({
      ".config/opencode/opencode.jsonc": `{
        // 行注释
        /* 块注释 */
        "$schema": "https://opencode.ai/config.json",
        "note": "转义 \\" 引号 // 不是注释",
        "providers": { "prov-a": { "models": {} } }
      }`,
      ".cache/opencode/models.json": META,
    })
    expect(await listModels({ home, env: {} })).toEqual(["prov-a/m-1", "prov-a/m-2"])
  })

  test(".json 解析失败 → 回退 .jsonc", async () => {
    await writeFiles({
      ".config/opencode/opencode.json": "{ 已损坏",
      ".config/opencode/opencode.jsonc": JSON.stringify({ providers: { "prov-a": { models: {} } } }),
      ".cache/opencode/models.json": META,
    })
    expect(await listModels({ home, env: {} })).toEqual(["prov-a/m-1", "prov-a/m-2"])
  })

  test("自定义 provider:模型直接来自配置自带 models(元数据无此 provider)", async () => {
    await writeFiles({
      ".config/opencode/opencode.json": JSON.stringify({ providers: { "prov-x": { models: { "glm-x": {} } } } }),
      ".cache/opencode/models.json": META,
    })
    expect(await listModels({ home, env: {} })).toEqual(["prov-x/glm-x"])
  })

  test("auth.json 键 × 元数据展开(只读键名不读凭据值)", async () => {
    await writeFiles({
      ".local/share/opencode/auth.json": JSON.stringify({ "prov-b": { type: "api", key: "sk-敏感值" } }),
      ".cache/opencode/models.json": META,
    })
    expect(await listModels({ home, env: {} })).toEqual(["prov-b/m-9"])
  })

  test("env 命中:元数据 env 数组变量存在于注入 env → provider 入选", async () => {
    await writeFiles({ ".cache/opencode/models.json": META })
    expect(await listModels({ home, env: { PROV_ENV_KEY: "k" } })).toEqual(["prov-env/m-e"])
    expect(await listModels({ home, env: {} })).toEqual([])
  })

  test("disabled 剔除(对元数据∪配置自带并集生效)", async () => {
    await writeFiles({
      ".config/opencode/opencode.json": JSON.stringify({
        providers: { "prov-a": { models: { "m-2": { disabled: true }, "m-cfg": {} } } },
      }),
      ".cache/opencode/models.json": META,
    })
    expect(await listModels({ home, env: {} })).toEqual(["prov-a/m-1", "prov-a/m-cfg"])
  })

  test("去重排序(跨 provider 字典序)", async () => {
    await writeFiles({
      ".config/opencode/opencode.json": JSON.stringify({
        providers: { "prov-b": { models: { "m-9": {} } }, "prov-a": { models: {} } },
      }),
      ".cache/opencode/models.json": META,
    })
    expect(await listModels({ home, env: {} })).toEqual(["prov-a/m-1", "prov-a/m-2", "prov-b/m-9"])
  })

  test("三路并集:配置+auth+env 同时命中", async () => {
    await writeFiles({
      ".config/opencode/opencode.json": JSON.stringify({ providers: { "prov-a": { models: {} } } }),
      ".local/share/opencode/auth.json": JSON.stringify({ "prov-b": { type: "api" } }),
      ".cache/opencode/models.json": META,
    })
    expect(await listModels({ home, env: { PROV_ENV_KEY: "k" } })).toEqual([
      "prov-a/m-1",
      "prov-a/m-2",
      "prov-b/m-9",
      "prov-env/m-e",
    ])
  })

  test("配置/元数据/auth 全缺 → 空列表不抛", async () => {
    expect(await listModels({ home, env: {} })).toEqual([])
  })
})

describe("listModels policies 白名单(provider.use 过滤,对齐 opencode「被拒 provider 从模型选择消失」)", () => {
  let home = ""
  beforeEach(async () => {
    home = await mkdtemp(join("/tmp/opencode", "tb-policy-"))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  const META = JSON.stringify({
    "prov-a": { models: { "m-1": {}, "m-2": {} } },
    "prov-b": { models: { "m-9": {} } },
  })

  async function writeConfigWithPolicies(policies: unknown, extra: Record<string, unknown> = {}) {
    const meta = JSON.stringify({
      "prov-a": { models: { "m-1": {}, "m-2": {} } },
      "prov-b": { models: { "m-9": {} } },
      "company-us": { models: { "m-c": {} } },
      "company-eu": { models: { "m-e2": {} } },
      "other": { models: { "m-o": {} } },
    })
    await mkdir(join(home, ".cache/opencode"), { recursive: true })
    await mkdir(join(home, ".config/opencode"), { recursive: true })
    await writeFile(join(home, ".cache/opencode/models.json"), meta)
    await writeFile(
      join(home, ".config/opencode/opencode.json"),
      JSON.stringify({
        providers: {
          "prov-a": { models: {} },
          "prov-b": { models: {} },
          "company-us": { models: {} },
          "company-eu": { models: {} },
          "other": { models: {} },
        },
        ...extra,
        ...(policies === undefined ? {} : { policies }),
      }),
    )
  }

  async function readList(env: Record<string, string> = {}) {
    return listModels({ home, env })
  }

  test("deny * + allow 指定 → 只显示允许的 provider", async () => {
    await writeConfigWithPolicies([
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "prov-a", effect: "allow" },
    ])
    expect(await readList()).toEqual(["prov-a/m-1", "prov-a/m-2"])
  })

  test("last-match-wins:allow * 打头 + deny 指定 → 指定被拒", async () => {
    await writeConfigWithPolicies([
      { action: "provider.use", resource: "*", effect: "allow" },
      { action: "provider.use", resource: "prov-b", effect: "deny" },
    ])
    expect(await readList()).toEqual(["company-eu/m-e2", "company-us/m-c", "other/m-o", "prov-a/m-1", "prov-a/m-2"])
  })

  test("通配:company-* 拒两家,? 单字符匹配", async () => {
    await writeConfigWithPolicies([
      { action: "provider.use", resource: "*", effect: "allow" },
      { action: "provider.use", resource: "company-*", effect: "deny" },
      { action: "provider.use", resource: "prov-?", effect: "deny" },
    ])
    expect(await readList()).toEqual(["other/m-o"])
  })

  test("非法语句跳过(坏 effect / 坏 resource 类型 / 缺 action),其余照常", async () => {
    await writeConfigWithPolicies([
      { action: "provider.use", resource: "prov-a", effect: "nonsense" },
      { action: "provider.use", resource: 42, effect: "deny" },
      { resource: "prov-a", effect: "deny" },
    ])
    expect(await readList()).toEqual([
      "company-eu/m-e2",
      "company-us/m-c",
      "other/m-o",
      "prov-a/m-1",
      "prov-a/m-2",
      "prov-b/m-9",
    ])
  })

  test("非 provider.use 语句(action 不同)不影响模型清单", async () => {
    await writeConfigWithPolicies([{ action: "tool.use", resource: "*", effect: "deny" }])
    expect(await readList()).toEqual([
      "company-eu/m-e2",
      "company-us/m-c",
      "other/m-o",
      "prov-a/m-1",
      "prov-a/m-2",
      "prov-b/m-9",
    ])
  })

  test("experimental.policies 旧键合并,canonical policies 后写优先", async () => {
    await writeConfigWithPolicies([{ action: "provider.use", resource: "prov-a", effect: "deny" }], {
      experimental: { policies: [{ action: "provider.use", resource: "prov-b", effect: "deny" }] },
    })
    expect(await readList()).toEqual(["company-eu/m-e2", "company-us/m-c", "other/m-o"])
  })

  test("无匹配语句 → 默认放行(行为不变)", async () => {
    await writeConfigWithPolicies([{ action: "provider.use", resource: "company-*", effect: "deny" }])
    expect(await readList()).toEqual(["other/m-o", "prov-a/m-1", "prov-a/m-2", "prov-b/m-9"])
  })
})

describe("providerAllowedByPolicies(单测:last-match-wins 与非法语句语义)", () => {
  const P = (resource: string, effect: "allow" | "deny") => ({ action: "provider.use", resource, effect })

  test("无语句/无匹配 → 放行", () => {
    expect(providerAllowedByPolicies("prov-a", [])).toBe(true)
    expect(providerAllowedByPolicies("prov-a", [P("other", "deny")])).toBe(true)
  })

  test("last-match-wins:后面的语句覆盖前面的", () => {
    expect(providerAllowedByPolicies("prov-a", [P("*", "deny"), P("prov-a", "allow")])).toBe(true)
    expect(providerAllowedByPolicies("prov-a", [P("*", "allow"), P("prov-a", "deny")])).toBe(false)
  })

  test("非法语句(action/effect/resource 不合法)视为不存在", () => {
    expect(providerAllowedByPolicies("prov-a", [{ action: "provider.use", resource: "prov-a", effect: "ask" }])).toBe(true)
    expect(providerAllowedByPolicies("prov-a", [{ action: "provider.use", resource: 42, effect: "deny" }])).toBe(true)
    expect(providerAllowedByPolicies("prov-a", [{ resource: "prov-a", effect: "deny" }])).toBe(true)
    expect(providerAllowedByPolicies("prov-a", ["junk", null, 42])).toBe(true)
  })

  test("通配:* 零或多字符,? 恰一字符,模式中 . 按字面量", () => {
    expect(providerAllowedByPolicies("company-us", [P("company-*", "deny")])).toBe(false)
    expect(providerAllowedByPolicies("company-", [P("company-*", "deny")])).toBe(false)
    expect(providerAllowedByPolicies("prov-a", [P("prov-?", "deny")])).toBe(false)
    expect(providerAllowedByPolicies("prov-ab", [P("prov-?", "deny")])).toBe(true)
    expect(providerAllowedByPolicies("ab", [P("a?", "deny")])).toBe(false)
    expect(providerAllowedByPolicies("a.c", [P("a?", "deny")])).toBe(true)
    expect(providerAllowedByPolicies("a.b", [P("a.b", "deny")])).toBe(false)
    expect(providerAllowedByPolicies("axb", [P("a.b", "deny")])).toBe(true)
  })
})

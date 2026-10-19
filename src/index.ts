import { Plugin } from "@opencode/plugin"
import { createStore, storageBackend, type Store } from "./store"
import { createServer, type ServerHandle } from "./server"
import { registerTools } from "./tools"
import { registerCommands } from "./commands"
import { clientStore } from "./client"
import { createContextReader } from "./context"
import { initDispatcher, DISPATCH_CAPS } from "./dispatcher"
import type { Task } from "./types"

const BASE_PORT_DEFAULT = 4370
const MAX_LOGS = 500
const PORT_SCAN_TRIES = 20

/**
 * 端口归属裁决（spec §9）：
 * - 绑定基准端口成功 → 主实例（唯一写者，本地 store）
 * - 基准端口被本插件主实例占用 → 次要实例（写操作经 clientStore 代理）
 * - 基准端口被其他服务占用 → 上移端口作为主实例
 */
/** 仅当基准端口上确为本项目的主实例时，才降级为次要实例（跨项目一律上移端口当主实例） */
export function shouldProxy(health: unknown, projectID: string): boolean {
  const h = health as { ok?: boolean; projectID?: string } | null
  return h?.ok === true && h.projectID === projectID
}

/** 依次执行注册；任一失败则停掉已绑定的服务并把异常上抛（避免僵尸端口） */
export async function safeRegister(handle: { stop(): void }, fns: Array<() => Promise<unknown>>): Promise<void> {
  try {
    for (const f of fns) await f()
  } catch (e) {
    handle.stop()
    throw e
  }
}

/** 探测端口上的 taskboard health（2s 超时）；非 JSON / 无响应 / 拒绝连接一律 undefined */
async function probeHealth(port: number): Promise<{ ok?: boolean; primary?: boolean; projectID?: string } | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
    return (await res.json()) as { ok?: boolean; primary?: boolean; projectID?: string }
  } catch {
    return undefined
  }
}

/** 模型清单缓存(模块级,主次实例共用):阶段模型下拉的数据源。
 * ⚠️ 实证(2026-10-18):daemon 进程内 exec `opencode` CLI 会导致 daemon 重启(子进程 CLI
 * 干预 service 生命周期),严禁在插件进程内起 opencode 子进程 —— 本实现只读本地文件。
 * 数据源三路并集(等价 `opencode auth list` 的完整口径,但零 CLI 调用):
 * ① 全局 opencode 配置(providers 键;兼容 .json / .jsonc)——含自定义 provider 自带 models;
 * ② auth.json(~/.local/share/opencode/auth.json)已存凭据的 provider——只读键名,凭据值绝不读入;
 * ③ models.dev 元数据缓存(~/.cache/opencode/models.json)里 env 数组变量在环境中的知名 provider。
 * 模型展开 = 元数据 models ∪ 配置自带 models,剔 disabled(仅配置里显式声明的生效)。
 * 最后按全局配置的 policies(provider.use,last-match-wins)过滤——对齐 opencode
 * 「被拒 provider 从 catalog 与模型选择中消失,无论它从何而来」;项目级/系统级/Console
 * 政策不在本插件可见范围(只读全局文件),属已知边界。 */
let modelsCache: { at: number; list: string[] } | null = null

/** 剥 JSONC 注释(状态机):字符串外的行注释与块注释移除,字符串内(含 \" 转义)原样保留 */
export function stripJsonComments(text: string): string {
  let out = ""
  let i = 0
  const n = text.length
  let inStr = false
  while (i < n) {
    const c = text[i]
    if (inStr) {
      out += c
      if (c === "\\") {
        out += text[i + 1] ?? ""
        i += 2
        continue
      }
      if (c === `"`) inStr = false
      i++
      continue
    }
    if (c === `"`) {
      inStr = true
      out += c
      i++
      continue
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++
      continue
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/** 读全局 opencode 配置:.json 优先,解析失败回退 .jsonc(剥注释);都没有/都坏 → undefined */
async function readOpencodeConfig(
  home: string,
): Promise<{ providers?: unknown; policies?: unknown; experimental?: { policies?: unknown } } | undefined> {
  const base = `${home}/.config/opencode/opencode`
  try {
    return await Bun.file(`${base}.json`).json()
  } catch {
    // 回退 jsonc
  }
  try {
    return JSON.parse(stripJsonComments(await Bun.file(`${base}.jsonc`).text()))
  } catch {
    return undefined
  }
}

/** auth.json 只取 provider 键名(等价 `opencode auth list` 的 stored 行);缺文件/坏格式 → 空 */
async function readAuthProviderIDs(home: string): Promise<string[]> {
  try {
    const auth = await Bun.file(`${home}/.local/share/opencode/auth.json`).json()
    return Object.keys(auth ?? {})
  } catch {
    return []
  }
}

/** permissions 同款整值通配:* 匹配零或多字符,? 恰一字符,其余字符按字面量 */
function wildcardToRegExp(pattern: string): RegExp {
  const src = [...pattern]
    .map((c) => {
      if (c === "*") return ".*"
      if (c === "?") return "."
      return c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    })
    .join("")
  return new RegExp(`^${src}$`)
}

/** provider.use 政策求值(语义对齐 opencode V2 文档 /v2/docs/policies):
 * 有序语句 **last-match-wins**(无特异度规则);无匹配 → 默认放行;
 * 非法语句(缺字段 / effect 非 allow|deny / resource 非字符串)按「被丢弃」处理,不参与匹配;
 * 只认 action === "provider.use",tool.use / integration.use 与模型清单无关。 */
export function providerAllowedByPolicies(providerID: string, statements: unknown[]): boolean {
  let allowed = true
  for (const s of statements) {
    if (typeof s !== "object" || s === null) continue
    const st = s as { action?: unknown; resource?: unknown; effect?: unknown }
    if (st.action !== "provider.use") continue
    if (typeof st.resource !== "string") continue
    if (st.effect !== "allow" && st.effect !== "deny") continue
    if (wildcardToRegExp(st.resource).test(providerID)) allowed = st.effect === "allow"
  }
  return allowed
}

/** 可注入 home/env 的模型清单;注入 opts(测试)绕过模块级缓存,避免跨 fixture 串数据 */
export async function listModels(opts?: { home?: string; env?: Record<string, string> }): Promise<string[]> {
  if (!opts && modelsCache && Date.now() - modelsCache.at < 300_000) return modelsCache.list
  const home = opts?.home ?? process.env.HOME ?? ""
  const env: Record<string, string | undefined> = opts?.env ?? process.env
  let list: string[] = []
  try {
    const cfg = await readOpencodeConfig(home)
    let meta: Record<string, { env?: string[]; models?: Record<string, unknown> }> | undefined
    try {
      meta = await Bun.file(`${home}/.cache/opencode/models.json`).json()
    } catch {
      // 元数据缺失只影响元数据来源,配置自带模型仍可用
    }
    const providers = (cfg?.providers ?? {}) as Record<string, { models?: Record<string, { disabled?: boolean }> }>
    // 政策语句:experimental.policies(旧键)在前,canonical policies 在后(last-match-wins 下后者有最终决定权)
    const policyStatements: unknown[] = [
      ...(Array.isArray(cfg?.experimental?.policies) ? (cfg.experimental.policies as unknown[]) : []),
      ...(Array.isArray(cfg?.policies) ? (cfg.policies as unknown[]) : []),
    ]
    const ids = new Set<string>([
      ...Object.keys(providers),
      ...(await readAuthProviderIDs(home)),
      ...Object.entries(meta ?? {})
        .filter(([, m]) => (m.env ?? []).some((e) => env[e] !== undefined && env[e] !== ""))
        .map(([id]) => id),
    ])
    for (const providerID of ids) {
      if (!providerAllowedByPolicies(providerID, policyStatements)) continue
      const cfgModels = providers[providerID]?.models ?? {}
      const disabled = new Set(Object.entries(cfgModels).filter(([, v]) => v?.disabled).map(([k]) => k))
      const modelIDs = new Set([...Object.keys(meta?.[providerID]?.models ?? {}), ...Object.keys(cfgModels)])
      for (const modelID of modelIDs) {
        if (!disabled.has(modelID)) list.push(`${providerID}/${modelID}`)
      }
    }
    list.sort()
  } catch {
    // 配置/元数据不可读:空列表,前端提示
    list = []
  }
  if (!opts) modelsCache = { at: Date.now(), list }
  return list
}

export async function arbitrate(opts: {
  port: number
  token: string
  webDir: string
  projectID: string
  localStore: Store
  log: (m: string) => void
  logs: () => readonly string[]
  hooks: { onWrite?: (tasks: Task[]) => void }
}): Promise<{ handle: ServerHandle; store: Store; primary: boolean; primaryPort: number }> {
  /** 会话上下文读取器：只读打开 opencode 会话库，惰性连接（构造零 IO），主/次实例共用同一实例 */
  const contextReader = createContextReader()

  const tryBind = (p: number, store: Store, primary: boolean): ServerHandle | undefined => {
    try {
      return createServer(store, {
        port: p,
        token: opts.token,
        webDir: opts.webDir,
        primary,
        projectID: opts.projectID,
        logs: opts.logs,
        listModels,
        readContext: (input) => contextReader.read(input),
        onWrite: (tasks) => opts.hooks.onWrite?.(tasks),
      })
    } catch {
      return undefined
    }
  }

  /** 在代理目标 primaryPort 上构造次要实例（代理 Store 就地构造，目标可能是上移后的主实例端口） */
  const bindSecondary = (primaryPort: number) => {
    const proxyStore = clientStore(`http://127.0.0.1:${primaryPort}`, opts.token)
    for (let p = opts.port + 1; p < opts.port + PORT_SCAN_TRIES; p++) {
      const h = tryBind(p, proxyStore, false)
      if (h) {
        opts.log(`次要实例：写操作代理到 ${primaryPort}，本实例端口 ${p}`)
        return { handle: h, store: proxyStore, primary: false, primaryPort }
      }
    }
    throw new Error(`[taskboard] 无法为次要实例找到可用端口（${opts.port + 1}..${opts.port + PORT_SCAN_TRIES - 1}）`)
  }

  const first = tryBind(opts.port, opts.localStore, true)
  if (first) {
    opts.log(`主实例绑定基准端口 ${opts.port}`)
    return { handle: first, store: opts.localStore, primary: true, primaryPort: opts.port }
  }

  // 基准端口忙：若确为本项目主实例 → 降级次要实例（spec §9）
  const baseHealth = await probeHealth(opts.port)
  if (shouldProxy(baseHealth, opts.projectID)) return bindSecondary(opts.port)

  // 基准端口被异构服务占用：上移扫描。绑不上的忙端口先探测——
  // 若是同项目主实例（可能它自己也曾上移）则降级代理到它，避免同项目双主 split-brain
  for (let p = opts.port + 1; p < opts.port + PORT_SCAN_TRIES; p++) {
    const h = tryBind(p, opts.localStore, true)
    if (h) {
      opts.log(`基准端口 ${opts.port} 被其他服务占用，主实例上移到 ${p}`)
      return { handle: h, store: opts.localStore, primary: true, primaryPort: p }
    }
    const hp = await probeHealth(p)
    if (hp?.ok === true && hp.primary === true && hp.projectID === opts.projectID) {
      opts.log(`端口 ${p} 发现同项目主实例（上移端口），降级为次要实例`)
      return bindSecondary(p)
    }
  }
  throw new Error(`[taskboard] 无法找到可用端口（${opts.port}..${opts.port + PORT_SCAN_TRIES - 1}）`)
}

export default Plugin.define({
  id: "taskboard",
  async setup(ctx) {
    const logs: string[] = []
    const log = (m: string) => {
      const line = `[${new Date().toISOString()}] ${m}`
      logs.push(line)
      if (logs.length > MAX_LOGS) logs.shift()
      console.log(`[taskboard] ${m}`)
    }

    const rawOpts = (ctx.options ?? {}) as Record<string, unknown>
    const port = Number(rawOpts.port) > 0 ? Number(rawOpts.port) : BASE_PORT_DEFAULT
    const requireAnalysisConfirm = rawOpts.requireAnalysisConfirm === true
    const projectID = ctx.location.project.id

    log(`启动：project=${projectID} port=${port} requireAnalysisConfirm=${requireAnalysisConfirm}`)

    const localStore = createStore(storageBackend(ctx.storage, `${projectID}/`), {
      requireAnalysisConfirm,
      // 默认项目合成 workspace 的来源:worker 会话工作目录(不传则显示"(未配置)"占位)
      directory: ctx.location.directory,
    })

    // token 持久化：重启与多实例之间共享同一令牌
    let token = (await ctx.storage.get(`${projectID}/settings/token`)) as string | undefined
    if (!token) {
      token = crypto.randomUUID().replaceAll("-", "").slice(0, 16)
      await ctx.storage.set(`${projectID}/settings/token`, token)
    }

    const webDir = new URL("./web/", import.meta.url).pathname

    const hooks: { onWrite?: (tasks: Task[]) => void } = {}
    const arb = await arbitrate({
      port,
      token,
      webDir,
      projectID,
      localStore,
      log,
      logs: () => logs,
      hooks,
    })
    log(`就绪：${arb.primary ? "主实例" : "次要实例"} board=http://127.0.0.1:${arb.primaryPort}/`)

    // worker 会话模型:opencode 对无 model 的后台会话创建即挂起(回合永不启动),
    // 必须显式指定。来源:环境变量 TASKBOARD_MODEL(推荐,daemon 环境继承)> opencode.json 的 plugin.taskboard.model。
    const pluginOptions = (rawOpts as { plugin?: { taskboard?: { model?: string } } }).plugin?.taskboard
    const taskboardModelSpec = process.env.TASKBOARD_MODEL ?? pluginOptions?.model ?? (rawOpts as { model?: string }).model
    const taskboardModel = taskboardModelSpec
      ? (() => {
          const idx = taskboardModelSpec.indexOf("/")
          return idx > 0
            ? {
                providerID: taskboardModelSpec.slice(0, idx),
                id: taskboardModelSpec.slice(idx + 1),
              }
            : undefined
        })()
      : undefined
    if (taskboardModelSpec && !taskboardModel) log(`TASKBOARD model 配置格式错误(应为 provider/model):${taskboardModelSpec}`)
    log(`插件 options: ${JSON.stringify(rawOpts)} | worker model: ${taskboardModel ? taskboardModelSpec : "未配置(用 opencode 默认解析,已知会挂起)"}`)

    // 自动派发器仅主实例装配（写都串行到主实例，次要实例派发会双派）
    let dispatcher: ReturnType<typeof initDispatcher> | null = null
    if (arb.primary) {
      dispatcher = initDispatcher(
        {
          session: ctx.session as never,
          storage: ctx.storage,
          projectID,
          // worker 会话必须在项目目录里工作；不传 location 会回退到服务进程 cwd
          // （实测曾落到 .debug/playground，worker 根本不在用户项目里）
          directory: ctx.location.directory,
          ...(taskboardModel ? { model: taskboardModel } : {}),
        },
        {
          store: arb.store,
          log,
          onWrite: (fn) => (hooks.onWrite = fn),
          // recordUsage 走 store 层、不经 HTTP 路由，故 emitSnapshot 不会触发；
          // 消耗统计要上看板必须由这里显式广播快照
          broadcast: async () => {
            await arb.handle.emit({
              type: "snapshot",
              tasks: await arb.store.list(),
              settings: await arb.store.getSettings(),
            })
          },
        },
      )
    }

    await safeRegister(arb.handle, [
      () => registerTools(ctx as never, arb.store),
      () =>
        registerCommands(ctx as never, arb.store, {
          port: arb.primaryPort,
          dispatcherText: dispatcher
            ? () => {
                const st = dispatcher.status()
                if (st.state === "disabled") return "🤖 自动领取：关（网页看板右上角开关可开启）"
                const label = { idle: "空闲", cooldown: `冷却中（剩 ${Math.round(st.cooldownRemainMs / 1000)}s）`, paused: "已暂停（连续失败）", disabled: "关" }[st.state]
                return `🤖 自动领取：${label}（今日 ${st.todayCount} 次${st.failStreak > 0 ? `，连败 ${st.failStreak}` : ""}）`
              }
            : undefined,
        }),
    ])

    return () => {
      dispatcher?.dispose()
      arb.handle.stop()
      log("已卸载，HTTP 服务停止")
    }
  },
})

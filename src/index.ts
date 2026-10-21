import { Plugin } from "@opencode/plugin"
import { createStore, storageBackend, type Store } from "./store"
import { createServer, type ServerHandle } from "./server"
import { registerTools } from "./tools"
import { registerCommands } from "./commands"
import { clientStore } from "./client"
import { initDispatcher, DISPATCH_CAPS } from "./dispatcher"
import { parseModelRef } from "./dispatcher/model"
import { listModels } from "./models"
import { createTerminalBridge, type TerminalBridge } from "./terminal"
import { BASE_PORT_DEFAULT, MAX_LOGS, PORT_SCAN_TRIES } from "./constants"
import type { Task } from "./types"

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

export async function arbitrate(opts: {
  port: number
  token: string
  webDir: string
  projectID: string
  localStore: Store
  log: (m: string) => void
  logs: () => readonly string[]
  hooks: { onWrite?: (tasks: Task[]) => void }
  /**
   * 终端桥（WebSocket 通道）。
   * 仅**主实例**注入：次要实例的终端路由直接 404（终端是本机单写者语义，
   * 两个实例各起一份 tmux 终端会打架）。
   */
  terminal?: TerminalBridge
}): Promise<{ handle: ServerHandle; store: Store; primary: boolean; primaryPort: number }> {
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
        onWrite: (tasks) => opts.hooks.onWrite?.(tasks),
        // 终端桥只装主实例（次要实例终端路由 404）
        terminal: primary ? opts.terminal : undefined,
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
    if (shouldProxy(hp, opts.projectID) && hp?.primary === true) {
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

    let arb: Awaited<ReturnType<typeof arbitrate>>
    let dispatcher: ReturnType<typeof initDispatcher> | null = null
    // 终端桥（WebSocket 通道）：构造零 IO（服务发现/建会话都发生在浏览器连上来的那一刻）。
    // 会话存在性校验走 opencode SDK（ctx.session.get）——会话不存在时终端桥**绝不**启动 TUI。
    const sessionApi = ctx.session as unknown as {
      get(input: { sessionID: string }): Promise<unknown>
    }
    const terminal = createTerminalBridge({
      checkSession: async (sessionID: string) => {
        try {
          const info = await sessionApi.get({ sessionID })
          if (!info) return { ok: false, message: `会话不存在：${sessionID}` }
          const directory = (info as { location?: { directory?: unknown } }).location?.directory
          return { ok: true, directory: typeof directory === "string" ? directory : undefined }
        } catch {
          return { ok: false, message: `会话不存在或无法访问：${sessionID}` }
        }
      },
      logger: {
        info: (m: string) => log(`终端：${m}`),
        warn: (m: string) => log(`终端：${m}`),
        error: (m: string) => log(`终端：${m}`),
      },
      // 纵深防御：看板 token 也不许出现在日志里
      redact: [token],
    })
    arb = await arbitrate({
      port,
      token,
      webDir,
      projectID,
      localStore,
      log,
      logs: () => logs,
      hooks,
      // 终端桥：只注入主实例（次要实例终端路由 404）
      terminal,
    })
    log(`就绪：${arb.primary ? "主实例" : "次要实例"} board=http://127.0.0.1:${arb.primaryPort}/`)

    // worker 会话模型:opencode 对无 model 的后台会话创建即挂起(回合永不启动),
    // 必须显式指定。来源:环境变量 TASKBOARD_MODEL(推荐,daemon 环境继承)> opencode.json 的 plugin.taskboard.model。
    const pluginOptions = (rawOpts as { plugin?: { taskboard?: { model?: string } } }).plugin?.taskboard
    const taskboardModelSpec = process.env.TASKBOARD_MODEL ?? pluginOptions?.model ?? (rawOpts as { model?: string }).model
    // 与派发侧 parseModelRef 同一口径（拒绝 a/b/c、空段等非法格式），非法即视为未配置
    const taskboardModel = parseModelRef(taskboardModelSpec) ?? undefined
    if (taskboardModelSpec && !taskboardModel) log(`TASKBOARD model 配置格式错误(应为 provider/model):${taskboardModelSpec}`)
    log(`插件 options: ${JSON.stringify(rawOpts)} | worker model: ${taskboardModel ? taskboardModelSpec : "未配置(用 opencode 默认解析,已知会挂起)"}`)

    // 自动派发器仅主实例装配（写都串行到主实例，次要实例派发会双派）
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
          // recordUsage 走 store 层、不经 HTTP 路由，故 emitSnapshot 不会自动触发；
          // 消耗统计要上看板必须由这里显式广播。统一走服务端的快照装配
          //（补齐手拼版曾漏掉的 projects 字段）；notify=false 防评估回环。
          broadcast: () => arb.handle.emitSnapshot(false),
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

    return async () => {
      dispatcher?.dispose()
      // 终端桥：只关自身连接与子进程，**不动 tmux 会话**（跨重启持久是设计目标）
      await terminal.close()
      arb.handle.stop()
      log("已卸载，HTTP 服务停止")
    }
  },
})

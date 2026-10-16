import { Plugin } from "@opencode/plugin"
import { createStore, storageBackend, type Store } from "./store"
import { createServer, type ServerHandle } from "./server"
import { registerTools } from "./tools"
import { registerCommands } from "./commands"
import { clientStore } from "./client"
import { initDispatcher, DISPATCH_CAPS } from "./dispatcher"

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

async function arbitrate(opts: {
  port: number
  token: string
  webDir: string
  projectID: string
  localStore: Store
  proxyStore: Store
  log: (m: string) => void
  logs: () => readonly string[]
  /** 延迟绑定的写观察者（自动派发器在仲裁后装配） */
  hooks: { onWrite?: () => void }
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
        onWrite: () => opts.hooks.onWrite?.(),
      })
    } catch {
      return undefined
    }
  }

  const first = tryBind(opts.port, opts.localStore, true)
  if (first) {
    opts.log(`主实例绑定基准端口 ${opts.port}`)
    return { handle: first, store: opts.localStore, primary: true, primaryPort: opts.port }
  }

  let secondary = false
  try {
    const res = await fetch(`http://127.0.0.1:${opts.port}/api/health`)
    const health = await res.json()
    secondary = shouldProxy(health, opts.projectID)
  } catch {
    secondary = false
  }

  if (secondary) {
    for (let p = opts.port + 1; p < opts.port + PORT_SCAN_TRIES; p++) {
      const h = tryBind(p, opts.proxyStore, false)
      if (h) {
        opts.log(`次要实例：写操作代理到 ${opts.port}，本实例端口 ${p}`)
        return { handle: h, store: opts.proxyStore, primary: false, primaryPort: opts.port }
      }
    }
    throw new Error(`[taskboard] 无法为次要实例找到可用端口（${opts.port + 1}..${opts.port + PORT_SCAN_TRIES - 1}）`)
  }

  for (let p = opts.port + 1; p < opts.port + PORT_SCAN_TRIES; p++) {
    const h = tryBind(p, opts.localStore, true)
    if (h) {
      opts.log(`基准端口 ${opts.port} 被其他服务占用，主实例上移到 ${p}`)
      return { handle: h, store: opts.localStore, primary: true, primaryPort: p }
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

    const localStore = createStore(storageBackend(ctx.storage, `${projectID}/`), { requireAnalysisConfirm })

    // token 持久化：重启与多实例之间共享同一令牌
    let token = (await ctx.storage.get(`${projectID}/settings/token`)) as string | undefined
    if (!token) {
      token = crypto.randomUUID().replaceAll("-", "").slice(0, 16)
      await ctx.storage.set(`${projectID}/settings/token`, token)
    }

    const webDir = new URL("./web/", import.meta.url).pathname

    const hooks: { onWrite?: () => void } = {}
    const arb = await arbitrate({
      port,
      token,
      webDir,
      projectID,
      localStore,
      proxyStore: clientStore(`http://127.0.0.1:${port}`, token),
      log,
      logs: () => logs,
      hooks,
    })
    log(`就绪：${arb.primary ? "主实例" : "次要实例"} board=http://127.0.0.1:${arb.primaryPort}/`)

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
                return `🤖 自动领取：${label}（今日 ${st.todayCount}/${DISPATCH_CAPS.dailyCap} 次${st.failStreak > 0 ? `，连败 ${st.failStreak}` : ""}）`
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

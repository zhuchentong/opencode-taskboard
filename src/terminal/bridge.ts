// 看板内置终端桥：把 opencode TUI 装进 tmux 会话，用 WebSocket 桥到浏览器 xterm。
//
// 职责（与已退役的 sidecar 同构，但跑在看板服务进程里，用户零配置）：
// - 会话存在性校验（先于一切 exec：会话不存在绝不启动 TUI）；
// - daemon 地址与凭据发现（只读本地 service.json，**不 exec 任何 opencode CLI**）；
// - tmux 承载：`board-<sessionID>` 会话里跑 `opencode mini --server <url> --session <id> --replay`
//   （mini 极简界面：无 session tabs 顶栏；--replay 让重连/resize 时回放最近历史）；
// - 帧桥接：二进制=终端字节流，文本=JSON 控制消息（resize / error / exit / ping）；
// - 空闲回收：客户端归零 30 分钟后 kill 掉 tmux 会话。
//
// ⚠️ 红线：插件进程**只**起 tmux 子进程；opencode TUI 由 tmux server 拉起
// （祖先链 opencode ← tmux:server ← systemd，daemon 不在链中），不干预 daemon 生命周期。
//
// 所有外部依赖（外部命令、pty 启动、时钟、日志、会话校验）都走注入点，单测全假实现。

import { existsSync as nodeExistsSync } from "node:fs"
import { homedir } from "node:os"
import { IdleReaper, systemClock } from "./idle"
import type { Clock } from "./idle"
import { CONTROL, encodeControl, isValidSize, parseControl } from "./protocol"
import { ScriptProbe, defaultSpawnPty } from "./pty"
import type { PtyLike, SpawnPty } from "./pty"
import { discoverDaemon } from "./service"
import type { DaemonInfo } from "./service"
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  TMUX_TERM,
  TmuxManager,
  defaultRunCmd,
  isValidSessionID,
  sessionName,
} from "./tmux"
import type { RunCmd } from "./tmux"

/** 应用层心跳间隔：WS idleTimeout 120s，25s 一跳保活（浏览器收到 ping 帧直接忽略） */
export const PING_INTERVAL_MS = 25_000

/** 空闲回收超时：客户端归零后多久回收 tmux 会话 */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000

/** 早到帧缓冲上限：pty 未就绪时排队等待（超过上限丢最旧的，防无限增长） */
export const MAX_PENDING_FRAMES = 256

/** 会话存在性校验结果 */
export interface SessionCheckResult {
  /** 会话是否存在 */
  ok: boolean
  /** 会话工作目录（location.directory）；缺失时回退 home */
  directory?: string
  /** 失败原因（中文，直接给浏览器看） */
  message?: string
}

/** 日志器（注入点） */
export interface TerminalLogger {
  info?: (m: string) => void
  warn?: (m: string) => void
  error?: (m: string) => void
  debug?: (m: string) => void
}

/** 桥接用的最小 socket 面（Bun 的 ServerWebSocket 天然满足） */
export interface TerminalSocket {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

/** 桥接依赖（全部可注入，单测用假实现） */
export interface TerminalBridgeDeps {
  /** 外部命令执行器（tmux/stty） */
  runCmd?: RunCmd
  /** pty 启动器 */
  spawnPty?: SpawnPty
  /** 时钟 */
  clock?: Clock
  /** 日志器 */
  logger?: TerminalLogger
  /** 会话存在性校验（index.ts 注入 ctx.session.get 的实现） */
  checkSession: (sessionID: string) => Promise<SessionCheckResult>
  /** daemon 服务发现（默认读本地 service.json） */
  discoverDaemon?: () => Promise<DaemonInfo>
  /** 空闲回收超时（毫秒），0 = 不回收 */
  idleTimeoutMs?: number
  /** 目录存在性校验（注入便于测试） */
  existsSync?: (path: string) => boolean
  /** 用户 home 目录（cwd 回退目标） */
  homeDir?: () => string
  /** 服务注册文件路径（注入便于测试） */
  serviceFilePath?: string
  /**
   * 需要脱敏的机密值（如看板 token）：日志里绝不能出现明文。
   * 纵深防御——当前代码路径本就不会打印 token，但别依赖「调用方自觉」。
   */
  redact?: string[]
}

/** 终端桥句柄 */
export interface TerminalBridge {
  /** 处理一条已升级的 WS 连接（sessionID 来自路由解析） */
  handle(ws: TerminalSocket, sessionID: string): Promise<void>
  /** 收到浏览器帧 */
  onMessage(ws: TerminalSocket, data: string | Uint8Array): void
  /** 连接关闭 */
  onClose(ws: TerminalSocket): void
  /** 关闭桥：只关自身连接与子进程，**不动 tmux 会话** */
  close(): Promise<void>
  /** 观测：当前连接数 */
  stats(): { connections: number }
}

/** 单条连接的状态 */
interface ConnState {
  sessionID: string
  ws: TerminalSocket
  /** pty 未就绪时排队的早到帧 */
  pending: Array<{ data: string | Uint8Array; isBinary: boolean }>
  ptyReady: boolean
  closed: boolean
  idleAttached: boolean
  pty?: PtyLike
  pingTimer?: unknown
  /** 最近一次请求的终端尺寸 */
  size?: { cols: number; rows: number }
  /** 尺寸调整进行中（串行化：last-wins） */
  resizing: boolean
  /** 尺寸调整期间又来了新尺寸 */
  resizeQueued: boolean
}

export function createTerminalBridge(deps: TerminalBridgeDeps): TerminalBridge {
  const logger = deps.logger ?? {}
  const runCmd = deps.runCmd ?? defaultRunCmd
  const spawnPty = deps.spawnPty ?? defaultSpawnPty
  const clock = deps.clock ?? systemClock
  const exists = deps.existsSync ?? nodeExistsSync
  const home = deps.homeDir ?? (() => homedir())
  const serviceFilePath = deps.serviceFilePath
  const discover = deps.discoverDaemon ?? (() => discoverDaemon({ serviceFilePath }))

  /** 机密值脱敏名单（daemon 密码、看板 token 等）：日志里绝不能出现明文 */
  const secrets = new Set<string>()
  for (const s of deps.redact ?? []) {
    if (typeof s === "string" && s.length > 0) secrets.add(s)
  }
  function scrub(text: string): string {
    let out = String(text)
    for (const secret of secrets) {
      if (secret.length < 8) continue // 太短的密钥会把整行日志都替换掉，反而看不清
      out = out.replaceAll(secret, "***")
    }
    return out
  }
  const log = {
    info: (m: string) => logger.info?.(scrub(m)),
    warn: (m: string) => logger.warn?.(scrub(m)),
    error: (m: string) => logger.error?.(scrub(m)),
    debug: (m: string) => logger.debug?.(scrub(m)),
  }

  const tmux = new TmuxManager({ runCmd, logger: log })
  const script = new ScriptProbe(runCmd)
  const idle = new IdleReaper({
    timeoutMs: deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    clock,
    logger: log,
    onExpire: async (sessionID) => {
      await tmux.killSession(sessionName(sessionID))
    },
  })

  /** @type {Map<TerminalSocket, ConnState>} */
  const conns = new Map<TerminalSocket, ConnState>()

  /** 发送控制帧（文本 JSON） */
  function sendControl(ws: TerminalSocket, payload: { type: string; [key: string]: unknown }): void {
    try {
      ws.send(encodeControl(payload))
    } catch {
      // 连接刚好断开，交给 close 收尾
    }
  }

  /** 关闭 socket（幂等） */
  function closeSocket(ws: TerminalSocket, code = 1000, reason = "closed"): void {
    try {
      ws.close(code, reason)
    } catch {
      // 已关闭
    }
  }

  /** 回显用的安全文本：去掉控制字符并截断（会话 ID 非法时不能把控制字符写进日志/前端） */
  function safeEcho(text: string): string {
    return String(text).replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 64)
  }

  /** 报错并断开：发中文 error 帧后关连接 */
  function fail(state: ConnState, message: string): void {
    log.warn(`终端连接失败（${safeEcho(state.sessionID)}）：${message}`)
    sendControl(state.ws, { type: CONTROL.ERROR, message })
    closeSocket(state.ws, 1011, "terminal_failed")
  }

  /** 会话工作目录：拿不到就用用户 home（不报错） */
  function resolveCwd(directory?: string): string {
    if (typeof directory === "string" && directory.length > 0) {
      try {
        if (exists(directory)) return directory
      } catch {
        // 目录不可访问 → 回落 home
      }
    }
    return home()
  }

  /** 调整终端尺寸（串行化，last-wins） */
  async function applyResize(state: ConnState): Promise<void> {
    if (state.resizing) {
      state.resizeQueued = true
      return
    }
    state.resizing = true
    try {
      do {
        state.resizeQueued = false
        const size = state.size
        if (!size || state.closed) break
        const ok = await tmux.resizeClients(sessionName(state.sessionID), size.cols, size.rows)
        if (!ok) log.debug(`终端尺寸调整未生效（tmux 客户端尚未登记）：${state.sessionID}`)
      } while (state.resizeQueued && !state.closed)
    } catch (err) {
      log.warn(`调整终端尺寸失败：${(err as Error)?.message ?? "未知错误"}`)
    } finally {
      state.resizing = false
    }
  }

  /** 处理一帧浏览器消息（二进制=终端输入，文本=JSON 控制消息） */
  function dispatch(state: ConnState, data: string | Uint8Array, isBinary: boolean): void {
    if (isBinary) {
      // 终端输入：原样写进 pty（字节直传，避免非 UTF-8 字节被换成 U+FFFD）
      try {
        state.pty?.write(data)
      } catch (err) {
        log.warn(`写入终端失败：${(err as Error)?.message ?? "未知错误"}`)
      }
      return
    }
    const control = parseControl(data)
    if (!control) {
      log.debug("忽略无法解析的文本控制帧")
      return
    }
    if (control.type === CONTROL.RESIZE) {
      const { cols, rows } = control
      if (!isValidSize(cols, rows)) {
        log.debug(`忽略非法尺寸控制帧：${String(cols)}x${String(rows)}`)
        return
      }
      state.size = { cols: cols as number, rows: rows as number }
      void applyResize(state)
      return
    }
    // 未知类型：忽略即可，不回错误（避免协议演进时的噪声）
    log.debug(`忽略未知控制消息类型：${control.type}`)
  }

  /** 准备连接：校验 → 服务发现 → tmux 会话 → attach 客户端 */
  async function setup(state: ConnState): Promise<void> {
    // 0) sessionID 白名单：非法 ID 一律不碰 tmux（防会话名注入 / 越权建会话）
    if (!isValidSessionID(state.sessionID)) {
      fail(state, `会话 ID 非法：${safeEcho(state.sessionID)}`)
      return
    }

    // 1) 会话存在性校验：先于 exec（会话不存在绝不启动 TUI）
    const check = await deps.checkSession(state.sessionID)
    if (state.closed) return
    if (!check.ok) {
      fail(state, check.message ?? `会话不存在：${state.sessionID}`)
      return
    }

    // 2) daemon 地址与凭据：读不到就明确报错，**绝不 exec**
    let daemon: DaemonInfo
    try {
      daemon = await discover()
    } catch (err) {
      fail(state, (err as Error)?.message ?? "opencode 服务信息读取失败")
      return
    }
    if (daemon.password) secrets.add(daemon.password)

    // 3) tmux 可用性
    if (!(await tmux.available())) {
      fail(state, "未检测到 tmux 命令：终端功能需要 tmux（Linux 环境请先安装 tmux）")
      return
    }

    // 3.5) script 可用性：PTY 靠 script 分配真终端（util-linux 专有，仅 Linux 可用）
    if (!(await script.available())) {
      fail(state, "未检测到 script 命令（util-linux）：终端功能需要 script 分配 PTY（Linux 环境请先安装 util-linux）")
      return
    }

    // 4) 准备 tmux 会话：存在则 attach（刷新/重连不丢 TUI），不存在则新建
    const cwd = resolveCwd(check.directory)
    const name = sessionName(state.sessionID)
    let created = false
    try {
      if (!(await tmux.hasSession(name))) {
        await tmux.createSession({
          name,
          cwd,
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
          env: { TERM: TMUX_TERM, OPENCODE_SERVER_PASSWORD: daemon.password },
          command: "opencode",
          // mini = 极简 TUI（无 session tabs 顶栏）；--replay = 重连/resize 时回放最近历史
          args: ["mini", "--server", daemon.url, "--session", state.sessionID, "--replay"],
        })
        created = true
      }
    } catch (err) {
      fail(state, `准备 tmux 会话失败：${(err as Error)?.message ?? "未知错误"}`)
      return
    }
    if (state.closed) {
      // 连接在准备期间就断了：刚建的 tmux 会话没人会 attach → 回收掉，
      // 否则 TUI 会在 tmux 里空跑到天荒地老（空闲回收器只统计已接入的客户端）。
      if (created) await tmux.killSession(name)
      return
    }

    // 5) 起一个 attach 客户端（每个浏览器连接一个）
    let pty: PtyLike
    try {
      pty = await spawnPty(["tmux", "attach-session", "-t", name], {
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd,
      })
    } catch (err) {
      // 起 attach 客户端失败（没装 script / sessionID 触发白名单 / pty 分配失败）：
      // 刚建出的 tmux 会话（含活 TUI）没人会回收——空闲回收器只统计 attach 过的客户端，
      // 统计不到它 → 这里显式收掉，否则 TUI 会在 tmux 里空跑到天荒地老。
      if (created) await tmux.killSession(name)
      fail(state, `启动 tmux 客户端失败：${(err as Error)?.message ?? "未知错误"}`)
      return
    }
    if (state.closed) {
      try {
        pty.kill()
      } catch {
        // 忽略
      }
      return
    }
    state.pty = pty

    pty.onData((data) => {
      if (state.closed) return
      try {
        state.ws.send(data)
      } catch {
        // 连接刚好断开，交给 close 收尾
      }
    })

    pty.onExit((code) => {
      if (state.closed) return
      sendControl(state.ws, { type: CONTROL.EXIT, code })
      closeSocket(state.ws, 1000, "tui_exited")
    })

    // 6) 就绪：把缓冲的早到帧按序补发（尺寸以最后一条 resize 为准）
    state.ptyReady = true
    for (const frame of state.pending) {
      dispatch(state, frame.data, frame.isBinary)
    }
    state.pending.length = 0

    // 7) 接入空闲计时
    idle.attach(state.sessionID)
    state.idleAttached = true

    log.info(`已接入会话终端：${state.sessionID}（tmux 会话 ${name}）`)
  }

  /** 清理一条连接 */
  function cleanup(ws: TerminalSocket): void {
    const state = conns.get(ws)
    if (!state) return
    conns.delete(ws)
    state.closed = true
    if (state.pingTimer !== undefined) {
      const clear = clock.clearInterval ?? ((h: unknown) => clearInterval(h as never))
      clear(state.pingTimer)
      state.pingTimer = undefined
    }
    if (state.idleAttached) {
      idle.detach(state.sessionID)
      state.idleAttached = false
    }
    if (state.pty) {
      try {
        state.pty.kill()
      } catch {
        // 忽略
      }
      state.pty = undefined
    }
  }

  return {
    async handle(ws: TerminalSocket, sessionID: string): Promise<void> {
      const state: ConnState = {
        sessionID,
        ws,
        pending: [],
        ptyReady: false,
        closed: false,
        idleAttached: false,
        resizing: false,
        resizeQueued: false,
      }
      conns.set(ws, state)

      // 应用层心跳：WS idleTimeout 之外的保活（浏览器收到 ping 帧直接忽略）
      const setInt = clock.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
      state.pingTimer = setInt(() => {
        if (state.closed) return
        sendControl(state.ws, { type: CONTROL.PING })
      }, PING_INTERVAL_MS)

      try {
        await setup(state)
      } catch (err) {
        fail(state, `终端准备失败：${(err as Error)?.message ?? "未知错误"}`)
      }
    },

    onMessage(ws: TerminalSocket, data: string | Uint8Array): void {
      const state = conns.get(ws)
      if (!state) return
      const isBinary = typeof data !== "string"
      if (!state.ptyReady) {
        // 早到的输入/resize 帧先缓冲：pty 还没 attach 好时不能丢
        if (state.pending.length >= MAX_PENDING_FRAMES) state.pending.shift()
        state.pending.push({ data, isBinary })
        return
      }
      dispatch(state, data, isBinary)
    },

    onClose(ws: TerminalSocket): void {
      cleanup(ws)
    },

    async close(): Promise<void> {
      idle.dispose()
      for (const state of [...conns.values()]) {
        closeSocket(state.ws, 1001, "看板服务已停止")
        cleanup(state.ws)
      }
    },

    stats(): { connections: number } {
      return { connections: conns.size }
    },
  }
}

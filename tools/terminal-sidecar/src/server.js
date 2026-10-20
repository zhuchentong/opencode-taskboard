/**
 * terminal-sidecar 主体：HTTP + WebSocket 服务。
 *
 * 职责：
 * - 握手门禁（token + Origin 白名单）→ 先于一切业务逻辑；
 * - 存在性校验（GET daemon /api/session/<id>）→ 先于 exec，绝不在会话不存在时起 opencode；
 * - tmux 承载：`board-<sessionID>` 会话里跑 `opencode --server <url> --session <id>`；
 * - 回收：客户端归零后空闲超时 kill 会话；显式 POST /close/<id> 也 kill。
 *
 * 所有外部依赖（fetch / pty / 外部命令 / 时钟）都走注入点，单测用假实现。
 */

import { createServer } from "node:http"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { WebSocketServer } from "ws"

import { checkHandshake, extractToken, isValidSessionID, REJECT_REASON_TEXT, safeEqual } from "./auth.js"
import { verifySession } from "./session-check.js"
import { TmuxManager, sessionName, DEFAULT_COLS, DEFAULT_ROWS, TMUX_TERM } from "./tmux.js"
import { IdleReaper, systemClock } from "./idle.js"
import { CONTROL, encodeControl, parseControl, isValidSize } from "./protocol.js"
import { createLogger } from "./log.js"
import { defaultSpawnPty } from "./pty.js"
import { SidecarError } from "./errors.js"

const STATUS_TEXT = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  500: "Internal Server Error",
}

/** 写 JSON 响应 */
function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  })
  res.end(body)
}

/** 升级失败：直接回一个 HTTP 响应并断开 */
function rejectUpgrade(socket, status, text) {
  const body = JSON.stringify({ ok: false, error: text })
  try {
    socket.write(
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\n` +
        `Content-Type: application/json; charset=utf-8\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n\r\n${body}`,
    )
  } catch {
    // socket 可能已被对端关闭，忽略
  }
  try {
    socket.destroy()
  } catch {
    // 同上
  }
}

/** 发送控制消息（文本帧） */
function sendControl(ws, payload) {
  if (ws.readyState !== ws.OPEN) return
  try {
    ws.send(encodeControl(payload))
  } catch {
    // 连接可能刚好断开，忽略
  }
}

/**
 * 创建 sidecar 实例。
 * @param {object} options
 * @param {object} options.config {port, token, daemonUrl, daemonPassword, allowOrigins, idleTimeoutMs}
 * @param {Function} [options.fetchImpl] 存在性校验用的 fetch（注入点）
 * @param {Function} [options.spawnPty] pty 启动器（注入点）
 * @param {Function} [options.runCmd] 外部命令执行器（注入点）
 * @param {object} [options.clock] 时间源（注入点）
 * @param {object} [options.logger] 日志器（注入点）
 */
export function createSidecar({
  config,
  fetchImpl = globalThis.fetch,
  spawnPty = defaultSpawnPty,
  runCmd,
  clock = systemClock,
  logger,
} = {}) {
  const log = logger ?? createLogger({ redact: [config.token, config.daemonPassword].filter(Boolean) })

  const tmux = new TmuxManager({ runCmd, spawnPty, logger: log, clock })
  const idle = new IdleReaper({
    timeoutMs: config.idleTimeoutMs,
    clock,
    logger: log,
    onExpire: async (sessionID) => {
      await tmux.killSession(sessionName(sessionID))
    },
  })

  /** 会话工作区：拿不到就用用户 home（不报错） */
  function resolveCwd(directory) {
    const home = homedir()
    if (typeof directory === "string" && directory.length > 0) {
      try {
        if (existsSync(directory)) return directory
      } catch {
        // 目录不可访问 → 回落 home
      }
    }
    return home
  }

  /** tmux 会话里跑的命令：参数数组，不经 shell */
  function tuiCommand(sessionID) {
    return {
      command: "opencode",
      args: ["--server", config.daemonUrl, "--session", sessionID],
    }
  }

  /** 会话环境变量：终端类型 + daemon 凭据（TUI 客户端据此做 Basic 认证） */
  function sessionEnv() {
    const env = { TERM: TMUX_TERM }
    if (config.daemonPassword) env.OPENCODE_SERVER_PASSWORD = config.daemonPassword
    return env
  }

  /**
   * 确保 tmux 会话可用。
   * 生命周期模型：**不设 remain-on-exit** —— TUI 进程退出 → tmux 会话随之消失 →
   * attach 客户端退出 → onExit → 浏览器收到 {"type":"exit"}（不会出现挂死面板的冻屏）。
   * 因此这里只需：会话存在就直接 attach（刷新/重连不丢 TUI），不存在才新建。
   */
  async function ensureSession(sessionID, cwd) {
    const name = sessionName(sessionID)
    if (await tmux.hasSession(name)) {
      return { name, created: false }
    }
    const { command, args } = tuiCommand(sessionID)
    await tmux.createSession({
      name,
      cwd,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      env: sessionEnv(),
      command,
      args,
    })
    return { name, created: true }
  }

  const httpServer = createServer((req, res) => {
    void handleHttp(req, res)
  })
  const wss = new WebSocketServer({ noServer: true })

  async function handleHttp(req, res) {
    let url
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1")
    } catch {
      return json(res, 400, { ok: false, error: "请求地址非法" })
    }

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, {
          ok: true,
          daemon: config.daemonUrl,
          tmux: await tmux.available(),
        })
      }

      if (req.method === "POST" && url.pathname.startsWith("/close/")) {
        const token = extractToken(url, req.headers)
        if (!safeEqual(token, config.token)) {
          return json(res, 401, { ok: false, error: "令牌无效" })
        }
        let sessionID
        try {
          sessionID = decodeURIComponent(url.pathname.slice("/close/".length))
        } catch {
          return json(res, 400, { ok: false, error: "sessionID 非法" })
        }
        if (!isValidSessionID(sessionID)) {
          return json(res, 400, { ok: false, error: "sessionID 非法" })
        }
        const killed = await tmux.killSession(sessionName(sessionID))
        log.info(`显式关闭 tmux 会话：${sessionName(sessionID)}（${killed ? "已结束" : "本就不存在"}）`)
        return json(res, 200, { ok: true, killed })
      }

      return json(res, 404, { ok: false, error: "未知路径" })
    } catch (err) {
      log.error(`请求处理失败：${err?.message ?? "未知错误"}`)
      return json(res, 500, { ok: false, error: "服务端内部错误" })
    }
  }

  httpServer.on("upgrade", (req, socket, head) => {
    void handleUpgrade(req, socket, head)
  })

  async function handleUpgrade(req, socket, head) {
    let url
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1")
    } catch {
      return rejectUpgrade(socket, 400, "请求地址非法")
    }

    const match = /^\/ws\/([^/]+)$/.exec(url.pathname)
    if (!match) return rejectUpgrade(socket, 404, REJECT_REASON_TEXT.unknown_path)

    let sessionID
    try {
      sessionID = decodeURIComponent(match[1])
    } catch {
      return rejectUpgrade(socket, 400, REJECT_REASON_TEXT.invalid_session_id)
    }
    if (!isValidSessionID(sessionID)) {
      log.warn(`拒绝 WebSocket 握手：${REJECT_REASON_TEXT.invalid_session_id}`)
      return rejectUpgrade(socket, 400, REJECT_REASON_TEXT.invalid_session_id)
    }

    const token = extractToken(url, req.headers)
    const origin = req.headers.origin
    const check = checkHandshake({
      token,
      origin,
      expectedToken: config.token,
      allowOrigins: config.allowOrigins,
    })
    if (!check.ok) {
      log.warn(`拒绝 WebSocket 握手：${REJECT_REASON_TEXT[check.reason]}`)
      const status = check.reason === "origin_denied" ? 403 : 401
      return rejectUpgrade(socket, status, REJECT_REASON_TEXT[check.reason])
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, sessionID)
    })
  }

  wss.on("connection", (ws, req, sessionID) => {
    void handleConnection(ws, req, sessionID)
  })

  async function handleConnection(ws, req, sessionID) {
    const fail = (code, reason, message) => {
      sendControl(ws, { type: CONTROL.ERROR, message })
      try {
        ws.close(code, reason)
      } catch {
        // 忽略
      }
    }

    let pty
    // 早到的输入/resize 帧先缓冲：pty 还没 attach 好时不能丢
    const pending = []
    let ptyReady = false

    /** 处理一帧浏览器消息（二进制=终端输入，文本=JSON 控制消息） */
    const handleMessage = (data, isBinary) => {
      if (isBinary) {
        // 终端输入：原样写进 pty（Buffer 直传，避免非 UTF-8 字节被换成 U+FFFD）
        try {
          pty?.write(data)
        } catch (err) {
          log.warn(`写入终端失败：${err?.message ?? "未知错误"}`)
        }
        return
      }
      const control = parseControl(data)
      if (!control) {
        log.debug("忽略无法解析的文本控制帧")
        return
      }
      if (control.type === CONTROL.RESIZE) {
        if (!isValidSize(control.cols, control.rows)) {
          log.debug(`忽略非法尺寸控制帧：${control.cols}x${control.rows}`)
          return
        }
        try {
          pty?.resize(control.cols, control.rows)
        } catch (err) {
          log.warn(`调整终端尺寸失败：${err?.message ?? "未知错误"}`)
        }
        return
      }
      // 未知类型：忽略即可，不回错误（避免协议演进时的噪声）
      log.debug(`忽略未知控制消息类型：${control.type}`)
    }

    // 先注册监听再干活：pty attach 之前到达的帧进 pending，attach 成功后按序补发
    ws.on("message", (data, isBinary) => {
      if (!ptyReady) {
        pending.push([data, isBinary])
        return
      }
      handleMessage(data, isBinary)
    })

    // 1) 存在性校验：先于 exec（会话不存在绝不启动 opencode）
    const check = await verifySession({
      daemonUrl: config.daemonUrl,
      password: config.daemonPassword,
      sessionID,
      fetchImpl,
    })
    if (!check.ok) {
      log.warn(`拒绝执行：${check.message}`)
      fail(4004, "session_check_failed", check.message)
      return
    }

    // 2) tmux 可用性
    if (!(await tmux.available())) {
      const message = "未检测到 tmux：请先安装 tmux（brew install tmux / apt install tmux）后重试"
      log.warn(message)
      fail(4003, "tmux_missing", message)
      return
    }

    // 3) 准备 tmux 会话（不存在则创建；死 pane 则重建）
    const cwd = resolveCwd(check.directory)
    let name
    try {
      ;({ name } = await ensureSession(sessionID, cwd))
    } catch (err) {
      const message = `准备 tmux 会话失败：${err?.message ?? "未知错误"}`
      log.error(message)
      fail(4005, "tmux_prepare_failed", message)
      return
    }

    // 4) 接管连接：接入空闲计时 + 接线
    idle.attach(sessionID)
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      idle.detach(sessionID)
      if (pty) {
        try {
          pty.kill()
        } catch {
          // 忽略
        }
        pty = undefined
      }
    }
    ws.on("close", cleanup)
    ws.on("error", () => {
      // 错误统一由 close 收尾
    })

    try {
      pty = await tmux.attach({
        name,
        cwd,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        env: { TERM: "xterm-256color" },
      })
    } catch (err) {
      const message = `启动 tmux 客户端失败：${err?.message ?? "未知错误"}`
      log.error(message)
      fail(4006, "attach_failed", message)
      return
    }

    if (ws.readyState !== ws.OPEN) {
      cleanup()
      return
    }

    pty.onData((data) => {
      if (ws.readyState !== ws.OPEN) return
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8")
      try {
        ws.send(buf)
      } catch {
        // 连接刚好断开，交给 close 收尾
      }
    })

    pty.onExit(({ exitCode }) => {
      sendControl(ws, { type: CONTROL.EXIT, code: exitCode })
      try {
        ws.close(1000, "tui_exited")
      } catch {
        // 忽略
      }
    })

    // pty 就绪：把缓冲的帧按序补发（输入按序写入，尺寸以最后一条 resize 为准）
    ptyReady = true
    for (const [data, isBinary] of pending) handleMessage(data, isBinary)
    pending.length = 0

    log.info(`已接入会话终端：${sessionID}（tmux 会话 ${name}）`)
  }

  return {
    config,
    tmux,
    idle,
    /** 启动监听（只绑 127.0.0.1：非 localhost 暴露不在本项目范围内） */
    async listen(port = config.port) {
      try {
        await new Promise((resolve, reject) => {
          const onError = (err) => reject(err)
          httpServer.once("error", onError)
          httpServer.listen(port, "127.0.0.1", () => {
            httpServer.off("error", onError)
            resolve()
          })
        })
      } catch (err) {
        // 端口占用是用户最常见的启动失败，给中文提示；原始错误留在 cause 里进 debug 日志
        if (err?.code === "EADDRINUSE") {
          throw new SidecarError(`端口 ${port} 已被占用，请用 --port 换一个端口`, { cause: err })
        }
        throw err
      }
      const address = httpServer.address()
      const actualPort = typeof address === "object" && address ? address.port : port
      return { port: actualPort, url: `http://127.0.0.1:${actualPort}` }
    },
    /** 关闭服务 */
    async close() {
      idle.dispose()
      for (const client of wss.clients) {
        try {
          client.close(1001, "服务关闭")
        } catch {
          // 忽略
        }
      }
      await new Promise((resolve) => wss.close(() => resolve()))
      await new Promise((resolve) => httpServer.close(() => resolve()))
    },
  }
}

/**
 * tmux 会话管理：把 opencode TUI 装进 `board-<sessionID>` 会话里。
 *
 * 设计要点：
 * - 会话名 = `board-<sessionID>`，sessionID 只允许 [A-Za-z0-9_-]（防注入）。
 * - attach 语义：会话不存在才创建，浏览器刷新/断线重连不丢 TUI。
 * - opencode 用**参数数组**执行，不经 shell（防注入）。
 * - remain-on-exit：TUI 退出后留死 pane，重连时能识别并重建。
 */

import { execFile } from "node:child_process"

import { systemClock } from "./idle.js"

/** tmux 会话名前缀 */
export const TMUX_SESSION_PREFIX = "board-"

/** tmux 会话里跑 TUI 用的终端类型 */
export const TMUX_TERM = "tmux-256color"

/** 默认终端尺寸（浏览器连上后会用 resize 消息纠正） */
export const DEFAULT_COLS = 120
export const DEFAULT_ROWS = 30

/** tmux 探测失败的缓存时长：装上 tmux 后无需重启 sidecar */
export const TMUX_PROBE_FAILURE_TTL_MS = 30_000

/** 会话名 → tmux 会话名 */
export function sessionName(sessionID) {
  return `${TMUX_SESSION_PREFIX}${sessionID}`
}

/**
 * 默认的外部命令执行器（execFile，不经 shell）。
 * @returns {Promise<{code:number, stdout:string, stderr:string, error:Error|null}>}
 */
export function defaultRunCmd(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: opts.timeoutMs ?? 5000, env: opts.env, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          error: error ?? null,
        })
      },
    )
  })
}

export class TmuxManager {
  /**
   * @param {object} options
   * @param {Function} [options.runCmd] 外部命令执行器（注入点）
   * @param {Function} [options.spawnPty] pty 启动器（注入点）
   * @param {object} [options.logger] 日志器
   * @param {object} [options.clock] 时间源（注入点）
   */
  constructor({ runCmd = defaultRunCmd, spawnPty, logger, clock = systemClock } = {}) {
    this.runCmd = runCmd
    this.spawnPty = spawnPty
    this.logger = logger
    this.clock = clock
    this._available = undefined
  }

  /**
   * tmux 是否可用。
   * 成功结果永久缓存；失败只缓存一小会儿（TMUX_PROBE_FAILURE_TTL_MS），
   * 这样「先启动 sidecar、后装 tmux」不用重启 sidecar。
   */
  async available() {
    if (this._available?.value === true) return true
    const now = this.clock?.now?.() ?? Date.now()
    if (this._available && now - this._available.at < TMUX_PROBE_FAILURE_TTL_MS) {
      return this._available.value
    }
    const result = await this.runCmd("tmux", ["-V"])
    const value = result.code === 0
    this._available = { value, at: now }
    return value
  }

  /** 会话是否存在 */
  async hasSession(name) {
    const result = await this.runCmd("tmux", ["has-session", "-t", name])
    return result.code === 0
  }

  /**
   * 创建会话并在里面跑命令（detached）。
   * @param {object} options
   * @param {string} options.name tmux 会话名
   * @param {string} options.cwd 工作目录
   * @param {number} options.cols 初始列数
   * @param {number} options.rows 初始行数
   * @param {Record<string,string>} options.env 会话环境变量
   * @param {string} options.command 可执行文件
   * @param {string[]} options.args 参数数组（不经 shell）
   */
  async createSession({ name, cwd, cols = DEFAULT_COLS, rows = DEFAULT_ROWS, env = {}, command, args = [] }) {
    const tmuxArgs = [
      "new-session",
      "-d",
      "-s",
      name,
      "-x",
      String(cols),
      "-y",
      String(rows),
      "-c",
      cwd,
    ]
    for (const [key, value] of Object.entries(env)) {
      tmuxArgs.push("-e", `${key}=${value}`)
    }
    tmuxArgs.push("--", command, ...args)

    const result = await this.runCmd("tmux", tmuxArgs)
    if (result.code !== 0) {
      // 并发建会话时可能撞上「duplicate session」，那说明别人已经建好了
      if (/duplicate session/i.test(result.stderr ?? "")) {
        this.logger?.warn?.(`tmux 会话已存在（并发创建）：${name}`)
        return { created: false }
      }
      throw new Error(`创建 tmux 会话失败：${name}（${(result.stderr || result.stdout || "").trim() || "未知错误"}）`)
    }

    // TUI 退出即会话消失（不设 remain-on-exit）：
    // 否则 attach 客户端会挂在死面板上，浏览器收不到退出通知（冻屏）
    // 面板默认终端类型（与计划一致：tmux-256color）
    await this.runCmd("tmux", ["set-option", "-t", name, "default-terminal", TMUX_TERM])
    return { created: true }
  }

  /** 结束会话（不存在也算成功） */
  async killSession(name) {
    const result = await this.runCmd("tmux", ["kill-session", "-t", name])
    return result.code === 0
  }

  /**
   * attach 到已有会话（每个 WS 连接一个 tmux 客户端进程）。
   * @returns {Promise<object>} pty 实例
   */
  async attach({ name, cwd, cols = DEFAULT_COLS, rows = DEFAULT_ROWS, env = {} }) {
    if (typeof this.spawnPty !== "function") {
      throw new Error("pty 启动器未注入：无法创建 tmux 客户端")
    }
    return await this.spawnPty("tmux", ["attach-session", "-t", name], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", ...env },
    })
  }
}

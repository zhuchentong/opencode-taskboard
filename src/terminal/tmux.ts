// tmux 会话管理：把 opencode TUI 装进 `board-<sessionID>` 会话里。
//
// 设计要点：
// - 会话名 = `board-<sessionID>`；sessionID 只允许 [A-Za-z0-9_-]（防注入，也防会话名越权）。
// - 生命周期模型：**不设 remain-on-exit** —— TUI 退出 → tmux 会话随之消失 →
//   attach 客户端退出 → 桥收到退出码 → 浏览器收到 {"type":"exit"}（不会出现挂死面板的冻屏）。
//   因此重连逻辑退化为：has-session 命中 → attach，未命中 → 新建。
//   ⚠️ 但用户 ~/.tmux.conf 可能把 remain-on-exit 打开（会复现冻屏），
//   所以建会话后**显式**再关一次，兜住这条外部配置。
// - opencode 用**参数数组**执行，不经 shell（防注入）。

/** tmux 会话名前缀 */
export const TMUX_SESSION_PREFIX = "board-"

/** tmux 会话里跑 TUI 用的终端类型 */
export const TMUX_TERM = "tmux-256color"

/** 默认终端尺寸（浏览器连上后会用 resize 消息纠正） */
export const DEFAULT_COLS = 120
export const DEFAULT_ROWS = 30

/** tmux 探测失败的缓存时长：装上 tmux 后无需重启看板服务 */
export const TMUX_PROBE_FAILURE_TTL_MS = 30_000

/** sessionID 白名单：只允许字母数字下划线连字符（同时防 tmux 会话名注入） */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** sessionID 是否合法 */
export function isValidSessionID(id: unknown): boolean {
  return typeof id === "string" && SESSION_ID_PATTERN.test(id)
}

/** 会话名 → tmux 会话名 */
export function sessionName(sessionID: string): string {
  return `${TMUX_SESSION_PREFIX}${sessionID}`
}

/** 外部命令执行结果 */
export interface RunResult {
  /** 退出码（0 = 成功） */
  code: number
  stdout: string
  stderr: string
}

/** 外部命令执行器（注入点）：一律参数数组，不经 shell */
export type RunCmd = (
  file: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: Record<string, string> },
) => Promise<RunResult>

/**
 * 默认的外部命令执行器（Bun.spawn，参数数组，不经 shell）。
 */
export async function defaultRunCmd(
  file: string,
  args: string[],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<RunResult> {
  const proc = Bun.spawn([file, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs ?? 5_000,
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
  ])
  const code = await proc.exited
  return { code, stdout, stderr }
}

export interface TmuxManagerDeps {
  /** 外部命令执行器（注入点） */
  runCmd?: RunCmd
  /** 日志器 */
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; debug?: (m: string) => void }
  /** 等待函数（注入点：resize 重试用） */
  sleep?: (ms: number) => Promise<void>
}

export class TmuxManager {
  private runCmd: RunCmd
  private logger?: TmuxManagerDeps["logger"]
  private sleep: (ms: number) => Promise<void>
  /** tmux 探测结果缓存：成功永久缓存，失败只缓存一小会儿（装上 tmux 后自动恢复） */
  private availableCache?: { value: boolean; at: number }

  constructor({ runCmd = defaultRunCmd, logger, sleep }: TmuxManagerDeps = {}) {
    this.runCmd = runCmd
    this.logger = logger
    this.sleep = sleep ?? ((ms: number) => Bun.sleep(ms))
  }

  /**
   * tmux 是否可用。
   * 成功结果永久缓存；失败只缓存 TMUX_PROBE_FAILURE_TTL_MS，
   * 这样「先开看板、后装 tmux」不用重启服务。
   */
  async available(): Promise<boolean> {
    if (this.availableCache?.value === true) return true
    const now = Date.now()
    if (this.availableCache && now - this.availableCache.at < TMUX_PROBE_FAILURE_TTL_MS) {
      return this.availableCache.value
    }
    const result = await this.runCmd("tmux", ["-V"])
    const value = result.code === 0
    this.availableCache = { value, at: now }
    return value
  }

  /** 会话是否存在 */
  async hasSession(name: string): Promise<boolean> {
    const result = await this.runCmd("tmux", ["has-session", "-t", name])
    return result.code === 0
  }

  /**
   * 创建会话并在里面跑命令（detached）。
   * @param options.name tmux 会话名
   * @param options.cwd 工作目录
   * @param options.cols 初始列数
   * @param options.rows 初始行数
   * @param options.env 会话环境变量（TERM / daemon 密码）
   * @param options.command 可执行文件
   * @param options.args 参数数组（不经 shell）
   */
  async createSession({
    name,
    cwd,
    cols = DEFAULT_COLS,
    rows = DEFAULT_ROWS,
    env = {},
    command,
    args = [],
  }: {
    name: string
    cwd: string
    cols?: number
    rows?: number
    env?: Record<string, string>
    command: string
    args?: string[]
  }): Promise<{ created: boolean }> {
    const tmuxArgs = ["new-session", "-d", "-s", name, "-x", String(cols), "-y", String(rows), "-c", cwd]
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
      throw new Error(
        `创建 tmux 会话失败：${name}（${(result.stderr || result.stdout || "").trim() || "未知错误"}）`,
      )
    }

    // 兜底外部配置：用户 ~/.tmux.conf 若把 remain-on-exit 打开，TUI 退出后会留死面板，
    // attach 客户端挂在死面板上永不退出 → 浏览器收不到退出帧（冻屏）。显式关掉。
    await this.runCmd("tmux", ["set-option", "-t", name, "remain-on-exit", "off"])
    // 面板默认终端类型（与计划一致：tmux-256color）
    await this.runCmd("tmux", ["set-option", "-t", name, "default-terminal", TMUX_TERM])
    return { created: true }
  }

  /** 结束会话（不存在也算成功） */
  async killSession(name: string): Promise<boolean> {
    const result = await this.runCmd("tmux", ["kill-session", "-t", name])
    return result.code === 0
  }

  /** 列出挂在该会话上的客户端 tty 路径 */
  async listClientTtys(name: string): Promise<string[]> {
    const result = await this.runCmd("tmux", ["list-clients", "-t", name, "-F", "#{client_tty}"])
    if (result.code !== 0) return []
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  }

  /**
   * 调整已挂载客户端的终端尺寸。
   *
   * 原理：内核 SIGWINCH → tmux 客户端自适应 → tmux 窗口跟随。
   * 走 `stty -F <tty>` 而不是 node-pty 的 resize（node-pty 在 Bun 下不可用）。
   *
   * 客户端刚 attach 时 tmux 服务端可能还没登记它 → 列表为空。
   * 这时不能把尺寸丢了（浏览器首帧尺寸就错了），所以重试若干次。
   *
   * @returns 是否至少有一个客户端被成功调整
   */
  async resizeClients(
    name: string,
    cols: number,
    rows: number,
    opts: { attempts?: number; delayMs?: number } = {},
  ): Promise<boolean> {
    const attempts = opts.attempts ?? 8
    const delayMs = opts.delayMs ?? 100
    for (let i = 0; i < attempts; i++) {
      const ttys = await this.listClientTtys(name)
      if (ttys.length > 0) {
        let ok = false
        for (const tty of ttys) {
          const result = await this.runCmd("stty", ["-F", tty, "cols", String(cols), "rows", String(rows)])
          if (result.code === 0) ok = true
        }
        return ok
      }
      if (i < attempts - 1) await this.sleep(delayMs)
    }
    return false
  }
}

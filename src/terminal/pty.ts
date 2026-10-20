// PTY 启动器：用 `script` 把一条命令塞进真终端里，替掉 node-pty。
//
// 为什么不用 node-pty：实测在 Bun 1.4.2 下 node-pty 虽然能加载，但 spawn 后
// resize 报 ioctl EBADF、输出恒为 0 字节（不可用）。
//
// 为什么用 `script -qfc`：`script` 会给子命令分配一个真 PTY 并把它的输入输出接过来，
// 于是 tmux attach-session 认为自己挂在一个终端上（TUI 渲染才正常）。
// 尺寸靠命令前缀 `stty rows H cols W` 在 attach 之前定好；
// 运行期改尺寸走 `tmux list-clients` → `stty -F <tty>`（内核 SIGWINCH → tmux 自适应）。
//
// ⚠️ `script -c` 内部走 shell：命令参数必须是白名单安全的。
// 这里用 assertShellSafe 兜住（会话名只允许 [A-Za-z0-9_-]）。

/** pty 启动选项 */
export interface PtyOptions {
  /** 初始列数 */
  cols: number
  /** 初始行数 */
  rows: number
  /** 工作目录 */
  cwd?: string
  /** 附加环境变量 */
  env?: Record<string, string>
}

/** pty 实例（对齐 node-pty 的最小面） */
export interface PtyLike {
  /** 写入终端输入 */
  write(data: Uint8Array | string): void
  /** 订阅终端输出 */
  onData(cb: (data: Uint8Array) => void): void
  /** 订阅进程退出（带退出码） */
  onExit(cb: (code: number) => void): void
  /** 结束进程 */
  kill(): void
}

/** pty 启动器（注入点） */
export type SpawnPty = (cmd: string[], opts: PtyOptions) => PtyLike | Promise<PtyLike>

/** shell 安全字符白名单（参数数组里每个元素都要过这一关） */
const SHELL_SAFE = /^[A-Za-z0-9_\-./:=@,+]*$/

/** 断言参数数组里的每个元素都不会被 shell 解释 */
export function assertShellSafe(args: string[]): void {
  for (const arg of args) {
    if (!SHELL_SAFE.test(arg)) {
      throw new Error(`pty 参数含有 shell 敏感字符，拒绝启动：${arg}`)
    }
  }
}

/**
 * 默认 pty 启动器（生产路径）。
 * @param cmd 命令与参数（不经 shell；内部会拼进 `script -c` 的命令串，故需白名单）
 */
export function defaultSpawnPty(cmd: string[], opts: PtyOptions): PtyLike {
  assertShellSafe(cmd)
  const inner = `stty rows ${opts.rows} cols ${opts.cols}; ${cmd.join(" ")}`
  const proc = Bun.spawn(["script", "-qfc", inner, "/dev/null"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
  })

  const dataCbs: Array<(data: Uint8Array) => void> = []
  const exitCbs: Array<(code: number) => void> = []

  // 终端输出：script 的 stdout 就是 PTY 的输出流
  void (async () => {
    try {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.length > 0) {
          for (const cb of dataCbs) {
            try {
              cb(value)
            } catch {
              // 单个订阅者异常不影响其它订阅者
            }
          }
        }
      }
    } catch {
      // 进程被杀时读流会报错，忽略（退出由 exited 收尾）
    }
  })()

  // 进程退出：script 退出码 = 内层命令退出码
  void (async () => {
    const code = await proc.exited
    for (const cb of exitCbs) {
      try {
        cb(code)
      } catch {
        // 忽略
      }
    }
  })()

  return {
    write(data: Uint8Array | string) {
      try {
        proc.stdin.write(data as never)
      } catch {
        // 进程可能已退出，忽略
      }
    },
    onData(cb: (data: Uint8Array) => void) {
      dataCbs.push(cb)
    },
    onExit(cb: (code: number) => void) {
      exitCbs.push(cb)
    },
    kill() {
      try {
        proc.kill()
      } catch {
        // 已退出
      }
    },
  }
}

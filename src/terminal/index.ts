// 看板内置终端桥（方案 1）：把已验证的 sidecar 终端桥平移进插件，
// 浏览器同源直连看板服务的 WebSocket，用户零配置（不用手起任何进程）。
//
// 模块划分：
// - protocol.ts：帧协议常量与解析（二进制=终端字节流，文本=JSON 控制消息）
// - service.ts ：opencode 服务（daemon）地址与凭据发现（只读本地 service.json）
// - tmux.ts    ：tmux 会话管理（建/挂/回收/改尺寸）
// - pty.ts     ：PTY 启动器（`script` 包装，替掉 Bun 下不可用的 node-pty）
// - idle.ts    ：空闲回收器（客户端归零 30 分钟 → kill tmux 会话）
// - bridge.ts  ：桥接主体（校验 → 会话 → 帧收发 → 退出传播）

export {
  createTerminalBridge,
  DEFAULT_IDLE_TIMEOUT_MS,
  MAX_PENDING_FRAMES,
  PING_INTERVAL_MS,
  type SessionCheckResult,
  type TerminalBridge,
  type TerminalBridgeDeps,
  type TerminalLogger,
  type TerminalSocket,
} from "./bridge"
export { IdleReaper, systemClock } from "./idle"
export type { Clock } from "./idle"
export { CONTROL, encodeControl, isValidSize, parseControl, type ControlType, type ParsedControl } from "./protocol"
export {
  assertShellSafe,
  defaultSpawnPty,
  resolvePtySize,
  ScriptProbe,
  SCRIPT_ARGS,
  SCRIPT_PROBE_FAILURE_TTL_MS,
  type PtyLike,
  type PtyOptions,
  type SpawnPty,
} from "./pty"
export {
  discoverDaemon,
  normalizeDaemonUrl,
  parseServiceJson,
  resolveServiceFilePath,
  TerminalConfigError,
  type DaemonInfo,
} from "./service"
export {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  defaultRunCmd,
  isValidSessionID,
  sessionName,
  TmuxManager,
  TMUX_SESSION_PREFIX,
  TMUX_TERM,
  type RunCmd,
  type RunResult,
} from "./tmux"

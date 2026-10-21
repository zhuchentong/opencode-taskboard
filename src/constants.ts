/** 跨模块配置常量与存储键空间（单一来源）。
 *
 * 收口范围：端口仲裁、HTTP/SSE 服务参数、storage 键前缀、模块级缓存 TTL。
 * 刻意不收口（保持领域内聚）：
 * - terminal/* 的常量（终端子系统自包含，见 src/terminal/ 各模块）；
 * - DISPATCH_CAPS（派发策略常量，见 src/dispatcher/policy.ts，含逐项语义注释）;
 * - CLAIM_STATES / CONFIRM_FROM（store 状态机表，依赖 Status 类型，见 src/store.ts）；
 * - STATUSES / DEFAULT_PROJECT_ID / STORE_ERROR_CODES（领域模型锚，见 src/types.ts，
 *   避免与类型定义互相 import 成环）。
 *
 * ⚠️ 键空间全景（含 projectID 前缀约定）：所有 storage key 必须前置 `${projectID}/`，
 * 常量只定义前缀之后的部分——本文件是核对键空间、防跨项目串数据的入口。
 */

/* ---- 端口仲裁与实例（src/index.ts） ---- */

/** 基准端口：绑上即主实例（唯一写者） */
export const BASE_PORT_DEFAULT = 4370
/** 端口上移扫描尝试数：基准端口被异构服务占用时依次尝试 port+1 .. port+PORT_SCAN_TRIES-1 */
export const PORT_SCAN_TRIES = 20
/** 内存环形日志上限（GET /api/logs 的数据源） */
export const MAX_LOGS = 500

/* ---- HTTP / SSE 服务（src/server.ts） ---- */

/** SSE 心跳间隔：保活用，必须小于 Bun idleTimeout 上限（255s），见 server.ts 的 Bun.serve 注释 */
export const SSE_HEARTBEAT_MS = 25_000
/** SSE 订阅者上限：防泄漏连接堆积 */
export const MAX_SSE_SUBSCRIBERS = 32
/** 目录列表条目上限：超大目录（如 /usr）只回前 N 项，防选择器渲染卡死 */
export const FS_LIST_CAP = 500

/* ---- 存储键空间（store / dispatcher 共用） ---- */

/** 任务键前缀：完整键 = `${projectID}/task/<taskID>` */
export const TASK_PREFIX = "task/"
/** 项目键前缀：完整键 = `${projectID}/project/<projectID>`（默认项目不占键） */
export const PROJECT_PREFIX = "project/"
/** 看板设置键：完整键 = `${projectID}/settings/board` */
export const SETTINGS_KEY = "settings/board"
/** 派发器沿状态 blob 键：完整键 = `${projectID}/dispatcher/along-state`（含 seqCounter） */
export const DISPATCHER_ALONG_SUFFIX = "/dispatcher/along-state"

/* ---- 缓存 TTL ---- */

/** 模型清单缓存时长（src/models.ts 模块级缓存；配置文件改动至多延迟该时长生效） */
export const MODELS_CACHE_TTL_MS = 300_000

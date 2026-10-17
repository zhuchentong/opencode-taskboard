import type { Status } from "./types"

/**
 * 拖拽落点判定：跨泳道返回要 patch 的目标状态；同泳道返回 null（视觉弹回，不发热请求）。
 * 状态转移合法性由服务端校验（invalid_transition 契约），前端不做转移表。
 */
export function dropTask(fromStatus: Status, toStatus: Status): { status: Status } | null {
  return fromStatus === toStatus ? null : { status: toStatus }
}

import type { BoardSettings, Task } from "./types"

// 乐观更新协议状态机：server 快照为唯一事实源，pending 为字段级在途遮罩。
// 全部函数不可变更新——返回新对象，不改入参；组件侧以 $derived 消费 visibleTasks。
export type BoardState = {
  server: Task[] // 最近一次服务器快照（唯一事实源）
  settings: BoardSettings
  pending: Map<string, Partial<Task>> // taskId → 在途遮罩
}

export function emptyState(settings: BoardSettings): BoardState {
  return { server: [], settings, pending: new Map() }
}

// 快照一律先落 server 与 settings；在途遮罩原样保留（在途写期间不被回流覆盖）
export function applySnapshot(
  state: BoardState,
  tasks: Task[],
  settings: BoardSettings,
): BoardState {
  return { server: [...tasks], settings, pending: new Map(state.pending) }
}

// 本地写开始：字段级合并遮罩，同任务连续乐观写时后者字段覆盖前者
export function beginOptimistic(
  state: BoardState,
  taskId: string,
  patch: Partial<Task>,
): BoardState {
  const pending = new Map(state.pending)
  pending.set(taskId, { ...pending.get(taskId), ...patch })
  return { ...state, pending }
}

/**
 * 摘除任务遮罩。时序契约（接线方必须遵守）：
 * 成功路径必须先让服务器快照落地（applySnapshot）再调用 settle(id, true)，
 * 否则摘遮罩瞬间视图会闪回旧值；失败路径 settle(id, false) 直接回滚到 server 最近快照。
 */
export function settle(state: BoardState, taskId: string, ok: boolean): BoardState {
  void ok // 成败都只摘遮罩：成功视图=服务器值，失败自动回滚到 server 最近快照
  if (!state.pending.has(taskId)) return state
  const pending = new Map(state.pending)
  pending.delete(taskId)
  return { ...state, pending }
}

// 合成视图：无遮罩的任务直接用服务器值；有遮罩的任务用遮罩字段覆盖合成。
// server 里不存在的 taskId 其遮罩被忽略。
export function visibleTasks(state: BoardState): Task[] {
  return state.server.map((task) => {
    const mask = state.pending.get(task.id)
    return mask ? { ...task, ...mask } : task
  })
}

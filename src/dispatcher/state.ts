/**
 * 沿驱动状态的纯函数层:沿提取、seq 幂等、blob 序列化。无 IO,同步可测。
 *
 * 净变化语义(可靠性证明,规格 §3.3):lastSeen 每轮链式推进,
 * 「进入需要唤醒的状态」的沿只要最终净状态停在那里就必被提出;
 * 多跳合并只丢「已离开状态」的沿,后果自洽(到达即离开 = 无需唤醒)。
 */

import type { Status, Task } from "../types"
import type { AlongState, TaskBackoff, TaskTransition } from "./types"

/** 运行时形态(Map);持久化形态为 AlongState(Record),两者经 serialize/load 转换 */
export interface AlongMaps {
  lastSeen: Map<string, Status>
  lastActedSeq: Map<string, number>
  rounds: Map<string, number>
  taskBackoff: Map<string, TaskBackoff>
  seqCounter: number
}

/**
 * 对比上一轮 lastSeen 与本轮任务快照,产出转移沿序列并链式推进 lastSeen。
 *
 * 关键规则:**首次观测的新任务只记录不提沿** —— 重启装载后、或新建任务
 * 第一次被看到时,它的「从无到有」不是一次业务转移,提沿会造成误唤醒。
 */
export function extractTransitions(
  lastSeen: Map<string, Status>,
  tasks: Task[],
  takeSeq: () => number,
): TaskTransition[] {
  const along: TaskTransition[] = []
  for (const task of tasks) {
    const prev = lastSeen.get(task.id)
    if (prev === undefined) {
      lastSeen.set(task.id, task.status)
      continue
    }
    if (prev !== task.status) {
      along.push({ taskID: task.id, from: prev, to: task.status, seq: takeSeq() })
      lastSeen.set(task.id, task.status)
    }
  }
  return along
}

/** 该沿是否需要 act:seq 严格大于已处理水位(未知任务视为 0) */
export function shouldAct(lastActed: Map<string, number>, t: TaskTransition): boolean {
  return t.seq > (lastActed.get(t.taskID) ?? 0)
}

/** act 成功后推进水位;act 失败绝不调用 —— 同沿下轮自动重发 */
export function markActed(lastActed: Map<string, number>, t: TaskTransition): void {
  lastActed.set(t.taskID, t.seq)
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** 运行时 Map 形态 → JSON blob(单 key 存 `${projectID}/dispatcher/along-state`) */
export function serializeAlongState(maps: AlongMaps): string {
  return JSON.stringify({
    lastSeen: Object.fromEntries(maps.lastSeen),
    lastActedSeq: Object.fromEntries(maps.lastActedSeq),
    rounds: Object.fromEntries(maps.rounds),
    taskBackoff: Object.fromEntries(maps.taskBackoff),
    seqCounter: maps.seqCounter,
  } satisfies AlongState)
}

/** JSON 结构 → 持久化形态;结构不认得返回空态(宁可重学,不可用假数据) */
export function loadAlongState(raw: unknown): AlongState {
  if (!isRecord(raw)) return emptyAlongState()
  const recordOf = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {})
  return {
    lastSeen: recordOf(raw.lastSeen) as AlongState["lastSeen"],
    lastActedSeq: recordOf(raw.lastActedSeq) as AlongState["lastActedSeq"],
    rounds: recordOf(raw.rounds) as AlongState["rounds"],
    taskBackoff: recordOf(raw.taskBackoff) as AlongState["taskBackoff"],
    seqCounter: typeof raw.seqCounter === "number" && Number.isFinite(raw.seqCounter) ? raw.seqCounter : 0,
  }
}

export function emptyAlongState(): AlongState {
  return { lastSeen: {}, lastActedSeq: {}, rounds: {}, taskBackoff: {}, seqCounter: 0 }
}

/** 持久化 Record 形态 → 运行时 Map 形态(engine 装载用) */
export function toMaps(s: AlongState): AlongMaps {
  return {
    lastSeen: new Map(Object.entries(s.lastSeen)),
    lastActedSeq: new Map(Object.entries(s.lastActedSeq)),
    rounds: new Map(Object.entries(s.rounds)),
    taskBackoff: new Map(Object.entries(s.taskBackoff)),
    seqCounter: s.seqCounter,
  }
}

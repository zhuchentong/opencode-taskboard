<script lang="ts">
  import { STATUSES, STATUS_LABELS, STATUS_HINTS, groupByStatus } from "$lib/board"
  import { drag } from "$lib/drag.svelte"
  import type { Project, Task } from "$lib/types"
  import Lane from "./Lane.svelte"

  let {
    tasks,
    pendingIds,
    flashIds,
    projMap,
    onopen,
    onconfirm,
    onquickreject,
    onmove,
  }: {
    tasks: Task[]
    pendingIds: { has(id: string): boolean }
    flashIds: { has(id: string): boolean }
    /** 项目索引表(卡片项目徽标) */
    projMap: Map<string, Project>
    onopen: (task: Task) => void
    onconfirm?: (task: Task) => void
    onquickreject?: (task: Task) => void
    onmove?: (task: Task, dir: -1 | 1) => void
  } = $props()

  const groups = $derived(groupByStatus(tasks))
  /** 换行列（确认泳道）：卡片换行、泳道高度自适应，等待人工裁决的任务全部可见 */
  const WRAP_STATUSES: ReadonlySet<Status> = new Set(["analysis_confirm", "completion_confirm"])

  // —— done 泳道折叠（localStorage 持久化；bun 测试环境无 DOM，读写都兜底）——
  const DONE_OPEN_KEY = "board.doneOpen"
  function readDoneOpen(): boolean {
    try {
      return JSON.parse(localStorage.getItem(DONE_OPEN_KEY) ?? "false") === true
    } catch {
      return false
    }
  }
  let doneOpen = $state(readDoneOpen())
  function expandDone() {
    doneOpen = true
    try {
      localStorage.setItem(DONE_OPEN_KEY, JSON.stringify(true))
    } catch {
      /* 无 DOM 环境忽略 */
    }
  }

  // —— 拖入折叠 done 泳道成功后自动展开 ——
  // drop 回调在 App 层（initDrag → handleDrop），Board 侧由两次观测推导「成功落位」：
  // ① 拖拽进行中记住被拖任务 id 与最后悬停泳道；拖拽结束时留下记录（含时刻）。
  // ② 该任务真的出现在 done 组（乐观更新与 drop 同一同步链，先于服务端确认）才算成功；
  //    2s 时窗兜底乐观回滚/异步快照，防止旧信号误触发。
  // 仅拖拽路径触发：键盘移动与 Agent 完成任务落 done 不展开，尊重用户折叠意图。
  let dragEnd: { taskId: string; overDone: boolean; at: number } | null = null
  let dragSeen: { taskId: string; overDone: boolean } | null = null
  $effect(() => {
    if (drag.draggingId !== null) {
      dragEnd = null
      dragSeen = { taskId: drag.draggingId, overDone: drag.overStatus === "done" }
    } else if (dragSeen) {
      dragEnd = { ...dragSeen, at: Date.now() }
      dragSeen = null
    }
  })
  $effect(() => {
    const end = dragEnd
    if (!end || !groups.done.some((t) => t.id === end.taskId)) return
    if (end.overDone && Date.now() - end.at < 2000) expandDone()
    dragEnd = null
  })
</script>

<main class="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-2.5 p-4">
  {#each STATUSES as status (status)}
    <Lane
      status={status}
      label={STATUS_LABELS[status]}
      tasks={groups[status]}
      empty={STATUS_HINTS[status]}
      wrap={WRAP_STATUSES.has(status)}
      {onopen}
      {onconfirm}
      {onquickreject}
      {onmove}
      {pendingIds}
      {flashIds}
      {projMap}
      collapsed={status === "done" && !doneOpen}
      onexpand={expandDone}
    />
  {/each}
</main>

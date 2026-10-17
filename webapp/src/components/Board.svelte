<script lang="ts">
  import { STATUSES, STATUS_LABELS, groupByStatus } from "$lib/board"
  import type { Status, Task } from "$lib/types"
  import Lane from "./Lane.svelte"

  let {
    tasks,
    pendingIds,
    flashIds,
    onopen,
    onconfirm,
    onquickreject,
    onmove,
    ondrop,
  }: {
    tasks: Task[]
    pendingIds: { has(id: string): boolean }
    flashIds: { has(id: string): boolean }
    onopen: (task: Task) => void
    onconfirm?: (task: Task) => void
    onquickreject?: (task: Task) => void
    onmove?: (task: Task, dir: -1 | 1) => void
    /** 拖拽落定：跨泳道时回调（App 走乐观写通道） */
    ondrop?: (taskId: string, toStatus: Status) => void
  } = $props()

  const groups = $derived(groupByStatus(tasks))
</script>

<main class="mx-auto flex max-w-7xl flex-col gap-2.5 p-4">
  {#each STATUSES as status (status)}
    <Lane
      status={status}
      label={STATUS_LABELS[status]}
      tasks={groups[status]}
      empty={status === "planning" ? "看板空空如也——点击右上「＋新建任务」创建第一张卡片" : ""}
      {onopen}
      {onconfirm}
      {onquickreject}
      {onmove}
      {ondrop}
      {pendingIds}
      {flashIds}
    />
  {/each}
</main>

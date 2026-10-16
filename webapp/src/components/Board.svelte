<script lang="ts">
  import { STATUSES, STATUS_LABELS, groupByStatus } from "../lib/board"
  import type { Task } from "../lib/types"
  import Lane from "./Lane.svelte"

  let {
    tasks,
    pendingIds,
    flashIds,
    onopen,
    onconfirm,
    onquickreject,
    onmove,
  }: {
    tasks: Task[]
    pendingIds: { has(id: string): boolean }
    flashIds: { has(id: string): boolean }
    onopen: (task: Task) => void
    onconfirm?: (task: Task) => void
    onquickreject?: (task: Task) => void
    onmove?: (task: Task, dir: -1 | 1) => void
  } = $props()

  const groups = $derived(groupByStatus(tasks))
</script>

<main class="board">
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
      {pendingIds}
      {flashIds}
    />
  {/each}
</main>

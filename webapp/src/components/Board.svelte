<script lang="ts">
  import { STATUSES, STATUS_LABELS, groupByStatus } from "../lib/board"
  import type { Task } from "../lib/types"
  import Lane from "./Lane.svelte"

  let {
    tasks,
    onopen,
    onconfirm,
    onquickreject,
  }: {
    tasks: Task[]
    onopen: (task: Task) => void
    onconfirm?: (task: Task) => void
    onquickreject?: (task: Task) => void
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
    />
  {/each}
</main>

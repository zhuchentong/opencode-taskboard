<script lang="ts">
  import { STATUSES, STATUS_LABELS, groupByStatus } from "../lib/board"
  import type { Task } from "../lib/types"
  import Column from "./Column.svelte"

  let {
    tasks,
    onopen,
  }: {
    tasks: Task[]
    onopen: (task: Task) => void
  } = $props()

  const groups = $derived(groupByStatus(tasks))
</script>

<main class="board">
  {#each STATUSES as status (status)}
    <Column status={status} label={STATUS_LABELS[status]} tasks={groups[status]} {onopen} />
  {/each}
</main>

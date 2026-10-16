<script lang="ts">
  import type { Status, Task } from "../lib/types"
  import { drag } from "../lib/drag.svelte"
  import Card from "./Card.svelte"

  let {
    status,
    label,
    tasks,
    onopen,
  }: {
    status: Status
    label: string
    tasks: Task[]
    onopen: (task: Task) => void
  } = $props()

  const isOver = $derived(drag.overStatus === status && drag.draggingId !== null)
  const dropIndex = $derived(isOver ? drag.overIndex : null)
</script>

<section class="column" class:drag-over={isOver} data-status={status}>
  <h2>{label}<span class="count">{tasks.length}</span></h2>
  {#if tasks.length === 0 && !isOver}
    <p class="empty">暂无任务</p>
  {:else}
    <div class="cards">
      {#each tasks as task, i (task.id)}
        {#if dropIndex === i}
          <div class="drop-line" aria-hidden="true"></div>
        {/if}
        <Card {task} {onopen} />
      {/each}
      {#if dropIndex === tasks.length}
        <div class="drop-line" aria-hidden="true"></div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .column {
    background: var(--col);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px;
    min-height: 60vh;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  h2 {
    margin: 0;
    font-size: 13px;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .count {
    background: var(--line);
    color: var(--muted);
    border-radius: 8px;
    padding: 0 6px;
    font-size: 11px;
  }
  .empty {
    color: var(--muted);
    font-size: 12px;
    opacity: 0.7;
    margin: 4px 0;
  }
  .cards {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .column.drag-over {
    outline: 2px dashed var(--accent);
    outline-offset: -2px;
  }
  .drop-line {
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
    margin: -3px 0;
  }
</style>

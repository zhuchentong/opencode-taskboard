<script lang="ts">
  import type { Status, Task } from "../lib/types"
  import { drag } from "../lib/drag.svelte"
  import Card from "./Card.svelte"

  let {
    status,
    label,
    tasks,
    empty,
    pendingIds,
    flashIds,
    onopen,
    onconfirm,
    onquickreject,
  }: {
    status: Status
    label: string
    tasks: Task[]
    empty?: string
    pendingIds: Set<string>
    flashIds: Set<string>
    onopen: (task: Task) => void
    onconfirm?: (task: Task) => void
    onquickreject?: (task: Task) => void
  } = $props()

  const isOver = $derived(drag.overStatus === status && drag.draggingId !== null)
  const dropIndex = $derived(isOver ? drag.overIndex : null)
</script>

<section class="lane" class:drag-over={isOver} data-status={status}>
  <h2><span class="dot"></span>{label}<span class="count">{tasks.length}</span></h2>
  {#if tasks.length === 0 && !isOver}
    <p class="empty">{empty ?? ""}</p>
  {:else}
    <div class="cards">
      {#each tasks as task, i (task.id)}
        {#if dropIndex === i}
          <div class="drop-line" aria-hidden="true"></div>
        {/if}
        <Card {task} {onopen} {onconfirm} {onquickreject} {pendingIds} {flashIds} />
      {/each}
      {#if dropIndex === tasks.length}
        <div class="drop-line" aria-hidden="true"></div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .lane {
    background: var(--col);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 12px;
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
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
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
    margin: 0;
    min-height: 20px;
    display: flex;
    align-items: center;
  }
  .cards {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    min-height: 28px;
  }
  .lane.drag-over {
    outline: 2px dashed var(--accent);
    outline-offset: -2px;
  }
  /* 横向流内的插入指示：竖线 */
  .drop-line {
    width: 3px;
    align-self: stretch;
    border-radius: 2px;
    background: var(--accent);
  }
</style>

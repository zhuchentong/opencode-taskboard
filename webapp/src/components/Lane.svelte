<script lang="ts">
  import { Badge } from "$lib/components/ui/badge"
  import { drag } from "$lib/drag.svelte"
  import type { Status, Task } from "$lib/types"
  import Card from "./Card.svelte"

  let {
    status,
    label,
    tasks,
    empty,
    onopen,
    onconfirm,
    onquickreject,
    onmove,
    pendingIds,
    flashIds,
  }: {
    status: Status
    label: string
    tasks: Task[]
    empty?: string
    onopen: (task: Task) => void
    onconfirm?: (task: Task) => void
    onquickreject?: (task: Task) => void
    onmove?: (task: Task, dir: -1 | 1) => void
    pendingIds: { has(id: string): boolean }
    flashIds: { has(id: string): boolean }
  } = $props()

  const isOver = $derived(drag.overStatus === status && drag.draggingId !== null)
  const dropIndex = $derived(isOver ? drag.overIndex : null)

  // 状态令牌映射（与 Card 的色带/圆点同源）：泳道头圆点
  const DOT_BY_STATUS: Record<string, string> = {
    analyzing: "bg-primary",
    executing: "bg-primary",
    analysis_confirm: "bg-warning",
    completion_confirm: "bg-warning",
    done: "bg-muted-foreground/60",
  }
</script>

<section
  class="lane flex min-h-0 flex-1 flex-col gap-2 rounded-lg border bg-card/50 p-3 {isOver ? 'drag-over' : ''}"
  data-status={status}
  aria-label={`泳道：${label}`}
>
  <h2 class="flex flex-none items-center gap-1.5 text-[13px] font-medium text-foreground">
    <span class="size-2 rounded-full {DOT_BY_STATUS[status] ?? 'bg-muted-foreground/60'}"></span>
    {label}
    <Badge variant="secondary" class="px-1.5 text-[11px] text-muted-foreground">{tasks.length}</Badge>
  </h2>
  {#if tasks.length === 0 && !isOver}
    <p class="flex flex-none min-h-10 items-center text-xs text-muted-foreground/70">{empty ?? ""}</p>
  {/if}
  <!-- 空泳道也保留卡片容器：拖入第一张卡的落点 -->
  <!-- 空泳道也保留卡片容器：拖入第一张卡的落点；等高泳道下溢出在泳道内滚动 -->
  <div class="cards flex min-h-0 flex-1 flex-wrap content-start gap-2.5 overflow-y-auto">
    {#each tasks as task, i (task.id)}
      {#if dropIndex === i}
        <div class="drop-line w-[3px] self-stretch rounded-sm bg-primary" aria-hidden="true"></div>
      {/if}
      <Card {task} {onopen} {onconfirm} {onquickreject} {pendingIds} {flashIds} {onmove} />
    {/each}
    {#if dropIndex === tasks.length}
      <div class="drop-line w-[3px] self-stretch rounded-sm bg-primary" aria-hidden="true"></div>
    {/if}
  </div>
</section>

<style>
  /* 拖拽悬停整泳道描边（drag.svelte.ts 按 .lane[data-status] 命中泳道） */
  .lane.drag-over {
    outline: 2px dashed var(--primary);
    outline-offset: -2px;
  }
</style>

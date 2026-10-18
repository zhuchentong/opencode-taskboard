<script lang="ts">
  import { Badge } from "$lib/components/ui/badge"
  import { drag } from "$lib/drag.svelte"
  import type { Project, Status, Task } from "$lib/types"
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
    projMap,
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
    projMap: Map<string, Project>
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

<!-- 固定高度 + 左右结构：标题条满高贴左边（上下布局），右侧单行卡片流 -->
<section
  class="lane flex h-40 flex-none overflow-hidden rounded-lg border bg-card/50 {isOver ? 'drag-over' : ''}"
  data-status={status}
  aria-label={`泳道：${label}`}
>
  <!-- 左侧标题条：满高贴边、独立背景色；上组（圆点+竖排文字，紧凑）+ 数量贴底 -->
  <h2 class="flex w-9 flex-none flex-col items-center bg-muted py-2 text-[13px] font-medium text-foreground">
    <div class="flex flex-col items-center gap-2">
      <span class="size-2 flex-none rounded-full {DOT_BY_STATUS[status] ?? 'bg-muted-foreground/60'}"></span>
      <span class="vertical-label">{label}</span>
    </div>
    <Badge variant="secondary" class="mt-auto px-1 text-[11px] text-muted-foreground">{tasks.length}</Badge>
  </h2>
  {#if tasks.length === 0 && !isOver}
    <p class="flex flex-none items-center py-3 text-xs text-muted-foreground/70">{empty ?? ""}</p>
  {/if}
  <!-- 空泳道也保留卡片容器：拖入第一张卡的落点 -->
  <!-- 单行卡片流：不换行、卡片撑满泳道高、溢出横向滚动（永不出现纵向滚动条） -->
  <div class="cards flex min-w-0 flex-1 flex-nowrap items-stretch gap-2.5 overflow-x-auto overflow-y-hidden p-3">
    {#each tasks as task, i (task.id)}
      {#if dropIndex === i}
        <div class="drop-line w-[3px] flex-none self-stretch rounded-sm bg-primary" aria-hidden="true"></div>
      {/if}
      <Card {task} {onopen} {onconfirm} {onquickreject} {pendingIds} {flashIds} {onmove} {projMap} />
    {/each}
    {#if dropIndex === tasks.length}
      <div class="drop-line w-[3px] flex-none self-stretch rounded-sm bg-primary" aria-hidden="true"></div>
    {/if}
  </div>
</section>

<style>
  /* 拖拽悬停整泳道描边（drag.svelte.ts 按 .lane[data-status] 命中泳道） */
  .lane.drag-over {
    outline: 2px dashed var(--primary);
    outline-offset: -2px;
  }
  /* 标题文字竖排：中文标签直立竖读，标题条因此收成窄列 */
  .vertical-label {
    writing-mode: vertical-rl;
    text-orientation: upright;
    letter-spacing: 0.1em;
  }
</style>

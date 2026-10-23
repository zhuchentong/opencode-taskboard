<script lang="ts">
  import { Badge } from "$lib/components/ui/badge"
  import { drag } from "$lib/drag.svelte"
  import { STATUS_TOKEN } from "$lib/board"
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
    wrap = false,
    collapsed = false,
    onexpand,
  }: {
    status: Status
    label: string
    tasks: Task[]
    empty?: string
    /** 换行列（确认泳道）：卡片可换行、泳道高度自适应，任务全部可见不横滚 */
    wrap?: boolean
    /** 折叠态：任务非空时收成单行摘要按钮（done 泳道专用） */
    collapsed?: boolean
    /** 折叠态点击摘要按钮展开 */
    onexpand?: () => void
    onopen: (task: Task) => void
    onconfirm?: (task: Task) => void
    onquickreject?: (task: Task) => void
    onmove?: (task: Task, dir: -1 | 1) => void
    pendingIds: { has(id: string): boolean }
    flashIds: { has(id: string): boolean }
    projMap: Map<string, Project>
  } = $props()

  const isOver = $derived(drag.overStatus === status && drag.draggingId !== null)
  // 状态令牌（与 Card 的色带/圆点同源）：泳道头圆点，映射单一来源在 lib/board.ts
  const token = $derived(STATUS_TOKEN[status])
</script>

<!-- 左右结构：标题条满高贴左边（上下布局），右侧卡片流。
     普通列：固定高度 + 单行横滚；换行列（确认泳道）：min-h 自适应 + 卡片换行。 -->
<section
  class="lane flex flex-none rounded-lg border bg-card/50
    {collapsed && tasks.length > 0 ? 'min-h-10' : wrap ? 'min-h-40' : 'h-40 overflow-hidden'}
    {isOver ? 'drag-over' : ''}"
  data-status={status}
  aria-label={`泳道：${label}`}
>
  {#if collapsed && tasks.length > 0}
    <!-- 折叠态：单行摘要（section 保留 lane class + data-status，拖拽悬停整道描边照常命中） -->
    <button
      type="button"
      class="flex flex-1 items-center gap-2 px-3 py-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      onclick={() => onexpand?.()}
    >
      <span class="size-2 flex-none rounded-full {token.dot}"></span>
      <span class="font-medium text-foreground">{label}</span>
      <span>已完成 {tasks.length} · 点击展开</span>
    </button>
  {:else}
  <!-- 左侧标题条：满高贴边、独立背景色；上组（圆点+竖排文字，紧凑）+ 数量贴底 -->
  <h2 class="flex w-9 flex-none flex-col items-center bg-muted py-2 text-[13px] font-medium text-foreground">
    <div class="flex flex-col items-center gap-2">
      <span class="size-2 flex-none rounded-full {token.dot}"></span>
      <span class="vertical-label">{label}</span>
    </div>
    <Badge variant="secondary" class="mt-auto px-1 text-[11px] text-muted-foreground">{tasks.length}</Badge>
  </h2>
  {#if tasks.length === 0 && !isOver}
    <p class="flex flex-none items-center py-3 text-xs text-muted-foreground/70">{empty ?? ""}</p>
  {/if}
  <!-- 空泳道也保留卡片容器：拖入第一张卡的落点 -->
  <!-- 普通列单行横滚（永不出现纵向滚动条）；换行列 flex-wrap，全部任务可见 -->
  <div
    class="cards flex min-w-0 flex-1 items-stretch gap-2.5 p-3
      {wrap ? 'flex-wrap' : 'flex-nowrap overflow-x-auto overflow-y-hidden'}"
  >
    {#each tasks as task (task.id)}
      <Card {task} {onopen} {onconfirm} {onquickreject} {pendingIds} {flashIds} {onmove} {projMap} />
    {/each}
  </div>
  {/if}
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

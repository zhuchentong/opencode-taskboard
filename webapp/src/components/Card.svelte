<script lang="ts">
  import { Badge } from "$lib/components/ui/badge"
  import { Button } from "$lib/components/ui/button"
  import { cardDrag, drag } from "$lib/drag.svelte"
  import { STATUS_LABELS, timeAgo } from "$lib/board"
  import { formatClock, formatDuration, formatPhaseLine, formatPhaseTooltip, queueWaitMs } from "$lib/duration"
  import { ticker } from "$lib/ticker.svelte"
  import { badgeHue, normalizeProjectId } from "$lib/project-options"
  import type { Project, Task } from "$lib/types"

  let {
    task,
    onopen,
    onconfirm,
    onquickreject,
    pendingIds,
    flashIds,
    onmove,
    projMap,
  }: {
    task: Task
    onopen: (task: Task) => void
    /** 确认列快速通过（乐观通道，失败 toast 由 App 负责） */
    onconfirm?: (task: Task) => void
    /** 确认列快速打回：打开详情面板并展开打回表单 */
    onquickreject?: (task: Task) => void
    pendingIds?: { has(id: string): boolean }
    flashIds?: { has(id: string): boolean }
    /** 键盘跨泳道移动（方向 -1 上 / +1 下） */
    onmove?: (task: Task, dir: -1 | 1) => void
    /** 项目索引表(项目徽标;缺省不显示) */
    projMap?: Map<string, Project>
  } = $props()

  // Agent 认领中的分析/执行任务禁止用户拖拽/键盘移动（防误抢）
  const draggable = $derived(
    !(task.claim && task.claim.agent !== "human" && (task.status === "analyzing" || task.status === "executing")),
  )
  const isDragging = $derived(drag.draggingId === task.id)
  const inflight = $derived(pendingIds?.has(task.id) ?? false)
  const failFlash = $derived(flashIds?.has(task.id) ?? false)
  const canConfirm = $derived(
    (task.status === "analysis_confirm" || task.status === "completion_confirm") && (onconfirm || onquickreject),
  )
  // 状态令牌映射：左缘色带与状态签圆点同源（analyzing/executing 蓝、确认列琥珀、done 灰）
  const DOT_BY_STATUS: Record<string, string> = {
    analyzing: "bg-primary",
    executing: "bg-primary",
    analysis_confirm: "bg-warning",
    completion_confirm: "bg-warning",
    done: "bg-muted-foreground/60",
  }
  const BAND_BY_STATUS: Record<string, string> = {
    analyzing: "border-l-primary",
    executing: "border-l-primary",
    analysis_confirm: "border-l-warning",
    completion_confirm: "border-l-warning",
    done: "border-l-muted-foreground/40",
  }
  const dot = $derived(DOT_BY_STATUS[task.status] ?? "bg-muted-foreground/60")
  const band = $derived(BAND_BY_STATUS[task.status] ?? "border-l-transparent")
  // 项目徽标:归属解析 + 确定性着色(缺 projMap 时不显示)
  const proj = $derived(projMap?.get(normalizeProjectId(task)))
  // 两段计时：进行中的段随 ticker 逐秒递增；绝对时间走悬浮提示
  const phaseLine = $derived(formatPhaseLine(task, ticker.now))
  const phaseTitle = $derived(formatPhaseTooltip(task, ticker.now))
  // 排队时长：仅「待领取」显示，让「在排队」与「派发出故障」一眼可辨
  const queueLine = $derived.by(() => {
    const ms = queueWaitMs(task, ticker.now)
    return ms === null ? "" : `⏳ 排队 ${formatDuration(ms)}`
  })
  const queueTitle = $derived.by(() => {
    const ms = queueWaitMs(task, ticker.now)
    if (ms === null) return ""
    return `进入待领取：${formatClock(task.pendingAt ?? task.createdAt, ticker.now)}`
  })
</script>

<article
  data-task-id={task.id}
  class="group/card relative w-60 flex-none rounded-lg border border-l-4 bg-card p-3 text-card-foreground grid gap-1.5 text-sm cursor-pointer content-start {band} {task.status === 'done' ? 'opacity-80' : ''} {inflight ? 'opacity-60 animate-pulse' : ''} {failFlash ? 'fail-flash' : ''} hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring outline-none {draggable ? '' : 'cursor-not-allowed'}"
  class:dragging-source={isDragging}
  data-draggable={draggable ? "yes" : "no"}
  data-status={task.status}
  tabindex="0"
  role="button"
  aria-label={`查看任务：${task.title}`}
  title={[phaseTitle, queueTitle, draggable ? "" : "正由 Agent 处理，不能移动"].filter(Boolean).join("\n") || undefined}
  use:cardDrag={task.id}
  onclick={() => onopen(task)}
  onkeydown={(e) => {
    if (e.key === "Enter") onopen(task)
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && draggable && onmove) {
      e.preventDefault()
      onmove(task, e.key === "ArrowUp" ? -1 : 1)
    }
  }}
>
  <div class="flex flex-wrap items-center gap-1">
    <Badge variant="outline" class="gap-1.5 font-normal text-muted-foreground">
      <span class="size-1.5 rounded-full {dot}"></span>{STATUS_LABELS[task.status]}
    </Badge>
    {#if proj}
      <Badge
        variant="outline"
        class="gap-1.5 font-normal text-muted-foreground"
        title={`所属项目：${proj.name}（工作区：${proj.workspace}）`}>
        <span class="size-1.5 rounded-full" style="background: hsl({badgeHue(proj.name)} 70% 50%)"></span>{proj.name}
      </Badge>
    {/if}
  </div>
  <!-- 固定尺寸：标题钳两行，不足两行也占位 -->
  <div class="line-clamp-2 min-h-10 font-semibold wrap-anywhere">{task.title}</div>
  <!-- 固定尺寸：仅时间类元信息，单行截断；悬浮提示含绝对时刻 -->
  <div
    class="flex h-5 items-center gap-2 overflow-hidden text-xs whitespace-nowrap text-muted-foreground"
    title={[phaseTitle, queueTitle].filter(Boolean).join("\n") || undefined}
  >
    {#if phaseLine}<span class="tabular-nums flex-none">{phaseLine}</span>{/if}
    {#if queueLine}<span class="tabular-nums flex-none text-warning">{queueLine}</span>{/if}
    <span class="truncate">{timeAgo(task.updatedAt)}</span>
  </div>
  {#if canConfirm}
    <div
      class="absolute top-2.5 right-2.5 z-10 hidden group-hover/card:flex group-focus-within/card:flex gap-1.5"
      role="toolbar"
      aria-label="快速操作"
    >
      <Button
        size="xs"
        onclick={(e) => {
          e.stopPropagation()
          onconfirm?.(task)
        }}>通过</Button>
      <Button
        size="xs"
        variant="destructive"
        onclick={(e) => {
          e.stopPropagation()
          onquickreject?.(task)
        }}>打回</Button>
    </div>
  {/if}
</article>

<style>
  /* 拖拽中的原卡片：半透明（ghost 克隆负责跟手视觉） */
  .dragging-source {
    opacity: 0.4;
  }
  /* 失败红闪：乐观写失败的一拍提示（动画结束自动消失，类由 App 在 650ms 后摘除） */
  .fail-flash {
    animation: fail-flash 0.6s ease-out;
  }
  @keyframes fail-flash {
    0%,
    45% {
      box-shadow: 0 0 0 3px var(--destructive);
    }
    100% {
      box-shadow: none;
    }
  }
</style>

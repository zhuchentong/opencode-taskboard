<script lang="ts">
  import { SHADOW_ITEM_MARKER_PROPERTY_NAME } from "svelte-dnd-action"
  import { Badge } from "$lib/components/ui/badge"
  import { Button } from "$lib/components/ui/button"
  import { STATUS_LABELS, timeAgo } from "$lib/board"
  import { formatClock, formatDuration, formatPhaseLine, formatPhaseTooltip, queueWaitMs } from "$lib/duration"
  import { ticker } from "$lib/ticker.svelte"
  import { formatTokens, totalTokens } from "$lib/usage"
  import type { Task } from "$lib/types"

  let {
    task,
    onopen,
    onconfirm,
    onquickreject,
    pendingIds,
    flashIds,
    onmove,
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
  } = $props()

  const claimText = $derived(
    task.claim
      ? task.claim.agent === "human"
        ? "👤 用户执行中"
        : `🤖 ${task.claim.agent} · ${task.claim.sessionID.slice(0, 8)}`
      : "",
  )
  // Agent 认领中的分析/执行任务禁止用户拖拽/键盘移动（防误抢；强制在 Lane 层 finalize 校验）
  const draggable = $derived(
    !(task.claim && task.claim.agent !== "human" && (task.status === "analyzing" || task.status === "executing")),
  )
  // svelte-dnd-action 拖拽预览时塞入的占位影子项流经本组件：
  // 不渲染完整卡片（免得半透明白卡浮着），渲染虚线占位框——同时充当「会插到这里」的位置指示
  const isShadow = $derived((task as Record<symbol, unknown>)[SHADOW_ITEM_MARKER_PROPERTY_NAME] === true)
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
  // 两段计时：进行中的段随 ticker 逐秒递增；绝对时间走悬浮提示
  const phaseLine = $derived(formatPhaseLine(task, ticker.now))
  const phaseTitle = $derived(formatPhaseTooltip(task, ticker.now))
  // 消耗总量（无快照则不显示该行）；随 task prop 变化，无需额外状态
  const usageLine = $derived(task.usage ? `📊 ${formatTokens(totalTokens(task.usage))}` : "")
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

{#if isShadow}
  <!-- 插入位置指示：虚线占位框（高度近似卡片，避免让位跳动过大） -->
  <div class="h-24 w-60 rounded-lg border-2 border-dashed border-primary/50 bg-primary/5" aria-hidden="true"></div>
{:else}
<article
  data-task-id={task.id}
  class="group/card w-60 rounded-lg border border-l-4 bg-card p-3 text-card-foreground grid gap-1.5 text-sm cursor-pointer content-start {band} {task.status === 'done' ? 'opacity-80' : ''} {inflight ? 'opacity-60 animate-pulse' : ''} {isShadow ? 'opacity-50' : ''} {failFlash ? 'fail-flash' : ''} hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring outline-none {draggable ? '' : 'cursor-not-allowed'}"
  data-status={task.status}
  tabindex="0"
  role="button"
  aria-label={`查看任务：${task.title}`}
  title={[phaseTitle, queueTitle, draggable ? "" : "正由 Agent 处理，不能移动"].filter(Boolean).join("\n") || undefined}
  onclick={() => onopen(task)}
  onkeydown={(e) => {
    if (e.key === "Enter") onopen(task)
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && draggable && onmove) {
      e.preventDefault()
      onmove(task, e.key === "ArrowUp" ? -1 : 1)
    }
  }}
>
  <Badge variant="outline" class="self-start gap-1.5 font-normal text-muted-foreground">
    <span class="size-1.5 rounded-full {dot}"></span>{STATUS_LABELS[task.status]}
  </Badge>
  <div class="font-semibold wrap-anywhere">{task.title}</div>
  {#if task.description}
    <div class="text-muted-foreground line-clamp-2 wrap-anywhere">{task.description}</div>
  {/if}
  {#if task.analysis}
    <div class="text-muted-foreground line-clamp-2 wrap-anywhere">📌 {task.analysis}</div>
  {/if}
  {#if task.result}
    <div class="text-muted-foreground line-clamp-2 wrap-anywhere">✅ {task.result}</div>
  {/if}
  <div class="flex flex-wrap gap-2 text-xs text-muted-foreground">
    {#if phaseLine}<span class="tabular-nums">{phaseLine}</span>{/if}
    {#if queueLine}<span class="tabular-nums text-warning">{queueLine}</span>{/if}
    {#if usageLine}<span class="tabular-nums">{usageLine}</span>{/if}
    <span>{timeAgo(task.updatedAt)}</span>
    {#if claimText}<span>{claimText}</span>{/if}
    {#if task.comments.length > 0}<span>💬 {task.comments.length}</span>{/if}
  </div>
  {#if canConfirm && !isShadow}
    <div
      class="hidden group-hover/card:flex group-focus-within/card:flex gap-1.5"
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
{/if}

<style>
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

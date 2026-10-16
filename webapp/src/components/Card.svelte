<script lang="ts">
  import { STATUS_LABELS, timeAgo } from "../lib/board"
  import { cardDrag, drag } from "../lib/drag.svelte"
  import { formatPhaseLine, formatPhaseTooltip } from "../lib/duration"
  import { ticker } from "../lib/ticker.svelte"
  import type { Task } from "../lib/types"

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
  // Agent 认领中的分析/执行任务禁止用户拖拽（防误抢）
  const draggable = $derived(
    !(task.claim && task.claim.agent !== "human" && (task.status === "analyzing" || task.status === "executing")),
  )
  const isDragging = $derived(drag.draggingId === task.id)
  const inflight = $derived(pendingIds?.has(task.id) ?? false)
  const failFlash = $derived(flashIds?.has(task.id) ?? false)
  const canConfirm = $derived(
    (task.status === "analysis_confirm" || task.status === "completion_confirm") && (onconfirm || onquickreject),
  )
  // 两段计时：进行中的段随 ticker 逐秒递增；绝对时间走悬浮提示
  const phaseLine = $derived(formatPhaseLine(task, ticker.now))
  const phaseTitle = $derived(formatPhaseTooltip(task, ticker.now))
</script>

<article
  class="card"
  class:dragging-source={isDragging}
  class:inflight
  class:fail-flash={failFlash}
  data-status={task.status}
  tabindex="0"
  role="button"
  aria-label={`查看任务：${task.title}`}
  data-draggable={draggable ? "yes" : "no"}
  title={phaseTitle || undefined}
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
  <div class="badge">
    <span class="badge-dot"></span>{STATUS_LABELS[task.status]}
  </div>
  <div class="title">{task.title}</div>
  {#if task.description}
    <div class="desc">{task.description}</div>
  {/if}
  {#if task.analysis}
    <div class="desc note">📌 {task.analysis}</div>
  {/if}
  {#if task.result}
    <div class="desc note">✅ {task.result}</div>
  {/if}
  <div class="meta">
    {#if phaseLine}<span class="dur">{phaseLine}</span>{/if}
    <span>{timeAgo(task.updatedAt)}</span>
    {#if claimText}<span>{claimText}</span>{/if}
    {#if task.comments.length > 0}<span>💬 {task.comments.length}</span>{/if}
  </div>
  {#if canConfirm}
    <div class="quick" role="toolbar" aria-label="快速操作">
      <button
        class="quick-ok"
        onclick={(e) => {
          e.stopPropagation()
          onconfirm?.(task)
        }}>通过</button>
      <button
        class="quick-reject"
        onclick={(e) => {
          e.stopPropagation()
          onquickreject?.(task)
        }}>打回</button>
    </div>
  {/if}
</article>

<style>
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 10px;
    cursor: pointer;
    display: grid;
    gap: 6px;
    font-size: 13px;
    width: 240px;
    align-content: start;
  }
  .card:hover,
  .card:focus-visible {
    background: var(--card-hover);
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  /* 状态色签：圆点颜色由 app.css 的 .card[data-status] .badge-dot 规则按状态注入 */
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    align-self: start;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 1px 8px 1px 6px;
    font-size: 11px;
    line-height: 1.6;
    color: var(--muted);
    background: var(--col);
  }
  .badge-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--muted);
    display: inline-block;
  }
  .title {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .desc {
    color: var(--muted);
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    color: var(--muted);
    font-size: 12px;
  }
  /* 逐秒递增时不因数字宽度变化抖动 */
  .dur {
    font-variant-numeric: tabular-nums;
  }
  .card.inflight {
    opacity: 0.6;
    animation: inflight-shimmer 1s infinite;
  }
  @keyframes inflight-shimmer {
    50% {
      border-color: var(--accent);
    }
  }
  .card.fail-flash {
    animation: fail-flash 0.6s ease-out;
  }
  @keyframes fail-flash {
    0%,
    45% {
      box-shadow: 0 0 0 3px var(--danger);
    }
    100% {
      box-shadow: none;
    }
  }
  .quick {
    display: none;
    gap: 6px;
  }
  .card:hover .quick,
  .card:focus-within .quick {
    display: flex;
  }
  .quick button {
    border: none;
    border-radius: 6px;
    padding: 3px 10px;
    font-size: 12px;
    cursor: pointer;
  }
  .quick-ok {
    background: var(--ok);
    color: #fff;
  }
  .quick-reject {
    background: var(--danger);
    color: #fff;
  }
</style>

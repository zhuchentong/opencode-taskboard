<script lang="ts">
  import { STATUS_LABELS, timeAgo } from "../lib/board"
  import type { Task } from "../lib/types"

  let {
    task,
    onopen,
  }: {
    task: Task
    onopen: (task: Task) => void
  } = $props()

  const claimText = $derived(
    task.claim
      ? task.claim.agent === "human"
        ? "👤 用户执行中"
        : `🤖 ${task.claim.agent} · ${task.claim.sessionID.slice(0, 8)}`
      : "",
  )
</script>

<article
  class="card"
  tabindex="0"
  role="button"
  aria-label={`查看任务：${task.title}`}
  onclick={() => onopen(task)}
  onkeydown={(e) => {
    if (e.key === "Enter") onopen(task)
  }}
>
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
    <span>{timeAgo(task.updatedAt)}</span>
    {#if claimText}<span>{claimText}</span>{/if}
    {#if task.comments.length > 0}<span>💬 {task.comments.length}</span>{/if}
  </div>
  <span class="sr-status">{STATUS_LABELS[task.status]}</span>
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
  }
  .card:hover,
  .card:focus-visible {
    background: var(--card-hover);
    outline: 2px solid var(--accent);
    outline-offset: -2px;
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
  .sr-status {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
</style>

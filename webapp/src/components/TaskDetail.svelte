<script lang="ts">
  import { fade, fly } from "svelte/transition"
  import { STATUS_LABELS, timeAgo } from "../lib/board"
  import { formatClock, formatDuration, phaseViews, queueWaitMs } from "../lib/duration"
  import { ticker } from "../lib/ticker.svelte"
  import { confirmDialog } from "../lib/notify"
  import { formatTokens, totalTokens } from "../lib/usage"
  import type { Task, TaskUsage } from "../lib/types"
  import Markdown from "./Markdown.svelte"

  let {
    task,
    onclose,
    onwrite,
    ondelete,
    initialReject,
  }: {
    task: Task
    onclose: () => void
    /** 统一写通道：onwrite(taskId, 乐观遮罩, API patch, 失败提示前缀) */
    onwrite: (taskId: string, mask: Partial<Task>, apiPatch: Record<string, unknown>, failMsg: string) => void
    ondelete: (taskId: string) => void
    /** 打开时直接展开打回表单（卡片快速打回入口） */
    initialReject?: boolean
  } = $props()

  let title = $state(task.title)
  let description = $state(task.description)
  let comment = $state("")
  let rejectOpen = $state(!!initialReject)
  let rejectComment = $state("")
  let rejectInput = $state<HTMLTextAreaElement | null>(null)
  let panel = $state<HTMLElement | null>(null)
  let editing = $state(false) // 任一编辑器持有焦点时，快照不顶掉输入

  // 外部快照更新时同步本地编辑态；用户正在编辑则让路，失焦后由 onchange 提交或还原
  $effect(() => {
    if (!editing) {
      title = task.title
      description = task.description
    }
  })

  $effect(() => {
    panel?.focus()
    if (initialReject) rejectInput?.focus()
  })

  const CONFIRM_COLS = ["analysis_confirm", "completion_confirm"]
  const canConfirm = $derived(CONFIRM_COLS.includes(task.status))
  // 两段计时明细；进行中的段随心跳逐秒递增
  const views = $derived(phaseViews(task, ticker.now))
  const queueMs = $derived(queueWaitMs(task, ticker.now))
  // 消耗明细行（顺序即展示顺序）；合计单列一行
  const USAGE_ROWS: { key: keyof Omit<TaskUsage, "at">; label: string }[] = [
    { key: "input", label: "输入 input" },
    { key: "output", label: "输出 output" },
    { key: "reasoning", label: "推理 reasoning" },
    { key: "cacheRead", label: "缓存读 cache read" },
    { key: "cacheWrite", label: "缓存写 cache write" },
  ]

  function saveTitle() {
    const v = title.trim()
    if (v && v !== task.title) onwrite(task.id, { title: v }, { title: v }, "保存失败")
    else title = task.title
  }

  function saveDescription() {
    const v = description.trim()
    if (v !== task.description) onwrite(task.id, { description: v }, { description: v }, "保存失败")
  }

  function confirm() {
    const nextStatus = task.status === "analysis_confirm" ? "executing" : "done"
    onwrite(task.id, { status: nextStatus }, { action: "confirm" }, "确认失败")
  }

  function reject() {
    const c = rejectComment.trim()
    if (!c) return
    onwrite(
      task.id,
      {
        status: "pending",
        claim: undefined,
        comments: [...task.comments, { author: "user", text: c, createdAt: Date.now() }],
      },
      { action: "reject", comment: c },
      "打回失败",
    )
    rejectComment = ""
    rejectOpen = false
  }

  function addComment() {
    const c = comment.trim()
    if (!c) return
    onwrite(
      task.id,
      { comments: [...task.comments, { author: "user", text: c, createdAt: Date.now() }] },
      { action: "comment", comment: c },
      "评论失败",
    )
    comment = ""
  }
</script>

<div class="overlay" transition:fade={{ duration: 120 }} onclick={onclose} aria-hidden="true"></div>
<aside
  class="panel"
  tabindex="-1"
  bind:this={panel}
  transition:fly={{ x: 420, duration: 200 }}
  onkeydown={(e) => {
    if (e.key === "Escape" && rejectOpen) {
      rejectOpen = false
      return
    }
    if (e.key === "Escape") onclose()
  }}
>
  <header>
    <span class="col-badge">{STATUS_LABELS[task.status]}</span>
    <span class="spacer"></span>
    <button class="ghost" onclick={onclose} aria-label="关闭详情">✕</button>
  </header>

  <label class="field">
    <span>标题</span>
    <input
      bind:value={title}
      aria-label="任务标题"
      onfocus={() => (editing = true)}
      onblur={() => {
        editing = false
        saveTitle()
      }}
      onkeydown={(e) => {
        if (e.key === "Escape") {
          title = task.title
          e.currentTarget.blur()
        }
      }}
      onchange={saveTitle}
    />
  </label>

  <label class="field">
    <span>描述</span>
    <textarea
      rows="3"
      bind:value={description}
      aria-label="任务描述"
      onfocus={() => (editing = true)}
      onblur={() => {
        editing = false
        saveDescription()
      }}
      onkeydown={(e) => {
        if (e.key === "Escape") {
          description = task.description
          e.currentTarget.blur()
        }
      }}
      onchange={saveDescription}
    ></textarea>
  </label>

  {#if task.analysis}
    <!-- 用 div 而非 p：Markdown 渲染块级元素，<p> 会被浏览器提前闭合导致样式失效 -->
    <div class="field"><span>分析</span><div class="readonly"><span aria-hidden="true">📌</span> <Markdown source={task.analysis} /></div></div>
  {/if}
  {#if task.result}
    <div class="field"><span>结果</span><div class="readonly"><span aria-hidden="true">✅</span> <Markdown source={task.result} /></div></div>
  {/if}

  <div class="meta">
    <span>创建 {timeAgo(task.createdAt)}</span>
    <span>更新 {timeAgo(task.updatedAt)}</span>
    {#if queueMs !== null}
      <span>⏳ 排队中 {formatDuration(queueMs)}（{formatClock(task.pendingAt ?? task.createdAt)} 起）</span>
    {/if}
    {#if task.claim}
      <span>
        {task.claim.agent === "human"
          ? "👤 用户执行中"
          : `🤖 ${task.claim.agent} · ${task.claim.sessionID.slice(0, 8)}`}
      </span>
    {/if}
  </div>

  {#if views.length > 0}
    <section class="timing">
      <h3>计时</h3>
      <table>
        <thead>
          <tr>
            <th>阶段</th>
            <th>开始</th>
            <th>结束</th>
            <th>用时</th>
          </tr>
        </thead>
        <tbody>
          {#each views as v (v.phase)}
            <tr>
              <td>{v.label}</td>
              <td>{formatClock(v.startedAt)}</td>
              <td>{v.running ? "进行中" : v.endedAt !== undefined ? formatClock(v.endedAt) : "—"}</td>
              <td class="num">{v.running ? `已 ${formatDuration(v.duration)}` : formatDuration(v.duration)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}

  {#if task.usage}
    <section class="timing">
      <h3>消耗</h3>
      <table>
        <thead>
          <tr>
            <th>项目</th>
            <th>token</th>
          </tr>
        </thead>
        <tbody>
          {#each USAGE_ROWS as row (row.key)}
            <tr>
              <td>{row.label}</td>
              <td class="num">{formatTokens(task.usage[row.key])}</td>
            </tr>
          {/each}
          <tr>
            <td>合计</td>
            <td class="num">{formatTokens(totalTokens(task.usage))}</td>
          </tr>
        </tbody>
      </table>
    </section>
  {/if}

  <section class="actions">
    {#if canConfirm}
      <button class="primary" onclick={confirm}>通过</button>
      <button class="danger" onclick={() => (rejectOpen = !rejectOpen)}>打回</button>
    {/if}
    <button
      class="ghost"
      onclick={() =>
        confirmDialog(`删除「${task.title}」？`, "此操作不可恢复。").then((ok) => ok && ondelete(task.id))}
    >
      删除
    </button>
  </section>

  {#if rejectOpen}
    <div class="reject-form" transition:fly={{ y: 8, duration: 120 }}>
      <textarea
        bind:this={rejectInput}
        placeholder="打回原因（必填，将作为评论保留）"
        rows="2"
        bind:value={rejectComment}></textarea>
      <div class="row">
        <button class="ghost" onclick={() => (rejectOpen = false)}>取消</button>
        <button class="danger" disabled={!rejectComment.trim()} onclick={reject}>打回</button>
      </div>
    </div>
  {/if}

  <section class="comments">
    <h3>评论（{task.comments.length}）</h3>
    {#each task.comments as c (c.createdAt)}
      <div class="comment">
        <span class="who">[{c.author}] {timeAgo(c.createdAt)}</span>
        <p>{c.text}</p>
      </div>
    {:else}
      <p class="empty">暂无评论</p>
    {/each}
    <div class="add-comment">
      <textarea placeholder="添加评论（必填）" rows="2" bind:value={comment}></textarea>
      <button class="primary" disabled={!comment.trim()} onclick={addComment}>评论</button>
    </div>
  </section>
</aside>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 40;
  }
  .panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(420px, 90vw);
    background: var(--col);
    border-left: 1px solid var(--line);
    z-index: 41;
    padding: 16px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
    outline: none;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .col-badge {
    background: var(--line);
    color: var(--text);
    border-radius: 6px;
    padding: 2px 8px;
    font-size: 12px;
  }
  .spacer {
    flex: 1;
  }
  .field {
    display: grid;
    gap: 4px;
    font-size: 13px;
  }
  .field > span {
    color: var(--muted);
    font-size: 12px;
  }
  input,
  textarea {
    width: 100%;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 8px;
    font-size: 13px;
  }
  .readonly {
    margin: 0;
    color: var(--muted);
    overflow-wrap: anywhere;
    /* 图标 + Markdown 内容两列：避免块级内容把图标挤成独立一行 */
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0 4px;
    align-items: start;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    color: var(--muted);
    font-size: 12px;
  }
  .timing {
    display: grid;
    gap: 6px;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 10px;
  }
  .timing h3 {
    margin: 0;
    font-size: 13px;
  }
  .timing table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    color: var(--muted);
  }
  .timing th {
    text-align: left;
    font-weight: 500;
    padding: 0 6px 4px 0;
    opacity: 0.75;
  }
  .timing td {
    padding: 3px 6px 3px 0;
    border-top: 1px solid var(--line);
    white-space: nowrap;
  }
  .timing .num {
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .actions button,
  .reject-form button,
  .add-comment button {
    border: none;
    border-radius: 6px;
    padding: 6px 14px;
    cursor: pointer;
    font-size: 13px;
  }
  .primary {
    background: var(--ok);
    color: #fff;
  }
  .danger {
    background: var(--danger);
    color: #fff;
  }
  .ghost {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--line);
  }
  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .reject-form {
    display: grid;
    gap: 8px;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 10px;
  }
  .row {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .comments h3 {
    margin: 0 0 8px;
    font-size: 13px;
  }
  .comment {
    border-bottom: 1px solid var(--line);
    padding: 6px 0;
  }
  .comment .who {
    color: var(--muted);
    font-size: 12px;
  }
  .comment p {
    margin: 4px 0 0;
    overflow-wrap: anywhere;
  }
  .empty {
    color: var(--muted);
    font-size: 12px;
    opacity: 0.7;
  }
  .add-comment {
    display: grid;
    gap: 8px;
    margin-top: 8px;
  }
  .add-comment button {
    justify-self: end;
  }
</style>

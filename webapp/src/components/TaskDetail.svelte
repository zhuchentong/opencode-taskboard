<script lang="ts">
  import { Badge } from "$lib/components/ui/badge"
  import { Button } from "$lib/components/ui/button"
  import { Input } from "$lib/components/ui/input"
  import { Textarea } from "$lib/components/ui/textarea"
  import * as Dialog from "$lib/components/ui/dialog"
  import * as Tabs from "$lib/components/ui/tabs"
  import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components/ui/table"
  import { STATUS_LABELS, timeAgo } from "$lib/board"
  import { formatClock, formatDuration, phaseViews, queueWaitMs, summarizeSpans } from "$lib/duration"
  import { ticker } from "$lib/ticker.svelte"
  import { confirmDialog } from "$lib/notify"
  import { formatTokens, totalTokens } from "$lib/usage"
  import { badgeHue, normalizeProjectId } from "$lib/project-options"
  import type { Project, Task, TaskUsage } from "$lib/types"
  import Markdown from "./Markdown.svelte"

  let {
    task,
    projMap,
    onclose,
    onwrite,
    ondelete,
    initialReject,
  }: {
    task: Task
    /** 项目索引表(详情头显示归属;缺省不显示) */
    projMap?: Map<string, Project>
    onclose: () => void
    /** 统一写通道：onwrite(taskId, 乐观遮罩, API patch, 失败提示前缀) */
    onwrite: (taskId: string, mask: Partial<Task>, apiPatch: Record<string, unknown>, failMsg: string) => void
    ondelete: (taskId: string) => void
    /** 打开时直接展开打回表单（卡片快速打回入口） */
    initialReject?: boolean
  } = $props()

  const proj = $derived(projMap?.get(normalizeProjectId(task)))

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
  // 分段计时汇总（spanLog 账本：排队/分析/待确认/执行每段独立留存，含问答循环与打回重做）
  const spanSummary = $derived(summarizeSpans(task, ticker.now))
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

  // Esc 分层：打回表单开着时先收表单，否则关闭弹窗
  function handleEscapeKey(e: KeyboardEvent) {
    if (rejectOpen) {
      e.preventDefault()
      rejectOpen = false
    }
  }
</script>

<Dialog.Root open onOpenChange={(o) => !o && onclose()}>
  <Dialog.Content
    class="flex max-h-[85dvh] flex-col gap-3 p-4 sm:max-w-xl"
    onEscapeKeyDown={handleEscapeKey}
  >
    <Dialog.Header class="gap-1">
      {#if proj}
        <div class="flex w-fit items-center gap-1.5 text-xs text-muted-foreground" title={`工作区：${proj.workspace}`}>
          <span class="size-1.5 rounded-full" style="background: hsl({badgeHue(proj.name)} 70% 50%)"></span>
          项目:{proj.name}
        </div>
      {/if}
      <Badge variant="secondary" class="w-fit font-normal text-muted-foreground">{STATUS_LABELS[task.status]}</Badge>
      <Dialog.Title class="text-base wrap-anywhere">{task.title}</Dialog.Title>
      <Dialog.Description class="sr-only">{task.description || "任务详情"}</Dialog.Description>
    </Dialog.Header>

    <Tabs.Root value="content" class="flex min-h-0 flex-1 flex-col gap-2.5">
      <Tabs.List>
        <Tabs.Trigger value="content">内容</Tabs.Trigger>
        <Tabs.Trigger value="stats">统计</Tabs.Trigger>
        <Tabs.Trigger value="comments">评论</Tabs.Trigger>
      </Tabs.List>
      <!-- 焦点锚 + 唯一滚动区：页头/页签/页脚固定，仅本容器内部滚动 -->
      <div class="min-h-0 flex-1 overflow-y-auto outline-none" bind:this={panel} tabindex="-1">
        <Tabs.Content value="content" class="grid gap-4">
          <label class="grid gap-1 text-[13px]">
            <span class="text-xs text-muted-foreground">标题</span>
            <Input
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

          <label class="grid gap-1 text-[13px]">
            <span class="text-xs text-muted-foreground">描述</span>
            <Textarea
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
            ></Textarea>
          </label>

          {#if task.analysis}
            <div class="grid gap-1 text-[13px]">
              <span class="text-xs text-muted-foreground">分析</span>
              <!-- 用 div 而非 p：Markdown 渲染块级元素，<p> 会被浏览器提前闭合导致样式失效 -->
              <div class="grid grid-cols-[auto_1fr] items-start gap-x-1 text-muted-foreground"><span aria-hidden="true">📌</span><div class="prose prose-sm dark:prose-invert max-w-none wrap-anywhere"><Markdown source={task.analysis} /></div></div>
            </div>
          {/if}
          {#if task.result}
            <div class="grid gap-1 text-[13px]">
              <span class="text-xs text-muted-foreground">结果</span>
              <div class="grid grid-cols-[auto_1fr] items-start gap-x-1 text-muted-foreground"><span aria-hidden="true">✅</span><div class="prose prose-sm dark:prose-invert max-w-none wrap-anywhere"><Markdown source={task.result} /></div></div>
            </div>
          {/if}
        </Tabs.Content>

        <Tabs.Content value="stats" class="grid gap-2.5">
          <div class="flex flex-wrap gap-2.5 text-xs text-muted-foreground">
            <span>创建 {timeAgo(task.createdAt)}</span>
            <span>更新 {timeAgo(task.updatedAt)}</span>
            {#if queueMs !== null}
              <span class="text-warning">⏳ 排队中 {formatDuration(queueMs)}（{formatClock(task.pendingAt ?? task.createdAt)} 起）</span>
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
            <section class="grid gap-1.5 rounded-lg border p-2.5">
              <h3 class="text-[13px] font-medium">计时</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>阶段</TableHead>
                    <TableHead>开始</TableHead>
                    <TableHead>结束</TableHead>
                    <TableHead class="text-right">用时</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {#each views as v (v.phase)}
                    <TableRow>
                      <TableCell>{v.label}</TableCell>
                      <TableCell>{formatClock(v.startedAt)}</TableCell>
                      <TableCell>{v.running ? "进行中" : v.endedAt !== undefined ? formatClock(v.endedAt) : "—"}</TableCell>
                      <TableCell class="text-right tabular-nums">{v.running ? `已 ${formatDuration(v.duration)}` : formatDuration(v.duration)}</TableCell>
                    </TableRow>
                  {/each}
                </TableBody>
              </Table>
            </section>
          {/if}

          {#if spanSummary.rows.length > 0}
            <section class="grid gap-1.5 rounded-lg border p-2.5">
              <h3 class="text-[13px] font-medium">分段计时</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>阶段</TableHead>
                    <TableHead>开始</TableHead>
                    <TableHead>结束</TableHead>
                    <TableHead class="text-right">耗时</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {#each spanSummary.rows as r (r.phase + r.start)}
                    <TableRow>
                      <TableCell>
                        {r.label}
                        <span class="ml-1 text-[11px] text-muted-foreground">R{r.round}</span>
                        {#if r.running}<Badge variant="secondary">进行中</Badge>{/if}
                      </TableCell>
                      <TableCell class="text-[12px]">{formatClock(r.start)}</TableCell>
                      <TableCell class="text-[12px]">{r.running ? "—" : formatClock(r.end!)}</TableCell>
                      <TableCell class="text-right tabular-nums">{formatDuration(r.ms)}</TableCell>
                    </TableRow>
                  {/each}
                  <TableRow>
                    <TableCell colspan="4" class="text-right text-[12px] text-muted-foreground">
                      活跃合计 {formatDuration(spanSummary.activeTotal ?? 0)} · 墙钟 {formatDuration(spanSummary.wallClock)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </section>
          {/if}

          {#if task.usage}
            <section class="grid gap-1.5 rounded-lg border p-2.5">
              <h3 class="text-[13px] font-medium">消耗</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>项目</TableHead>
                    <TableHead class="text-right">token</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {#each USAGE_ROWS as row (row.key)}
                    <TableRow>
                      <TableCell>{row.label}</TableCell>
                      <TableCell class="text-right tabular-nums">{formatTokens(task.usage[row.key])}</TableCell>
                    </TableRow>
                  {/each}
                  <TableRow>
                    <TableCell>合计</TableCell>
                    <TableCell class="text-right tabular-nums">{formatTokens(totalTokens(task.usage))}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </section>
          {/if}
        </Tabs.Content>

        <Tabs.Content value="comments" class="grid gap-2">
          <h3 class="text-[13px] font-medium">评论（{task.comments.length}）</h3>
          {#each task.comments as c (c.createdAt)}
            <div class="border-b py-1.5">
              <span class="text-xs text-muted-foreground">[{c.author}] {timeAgo(c.createdAt)}</span>
              <p class="mt-1 text-[13px] wrap-anywhere">{c.text}</p>
            </div>
          {:else}
            <p class="text-xs text-muted-foreground/70">暂无评论</p>
          {/each}
          <div class="mt-1.5 grid gap-2">
            <Textarea placeholder="添加评论（必填）" rows="2" bind:value={comment}></Textarea>
            <Button class="justify-self-end" disabled={!comment.trim()} onclick={addComment}>评论</Button>
          </div>
        </Tabs.Content>
      </div>
    </Tabs.Root>

    {#if rejectOpen}
      <div class="grid gap-2 rounded-lg border p-2.5">
        <Textarea
          bind:this={rejectInput}
          placeholder="打回原因（必填，将作为评论保留）"
          rows="2"
          bind:value={rejectComment}></Textarea>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onclick={() => (rejectOpen = false)}>取消</Button>
          <Button variant="destructive" disabled={!rejectComment.trim()} onclick={reject}>打回</Button>
        </div>
      </div>
    {/if}

    <Dialog.Footer class="flex flex-row justify-end gap-2">
      {#if canConfirm}
        <Button class="bg-success text-success-foreground hover:bg-success/90" onclick={confirm}>通过</Button>
        <Button variant="destructive" onclick={() => (rejectOpen = !rejectOpen)}>打回</Button>
      {/if}
      <Button
        variant="outline"
        onclick={() =>
          confirmDialog(`删除「${task.title}」？`, "此操作不可恢复。").then((ok) => ok && ondelete(task.id))}
      >
        删除
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

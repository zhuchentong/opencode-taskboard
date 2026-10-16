<script lang="ts">
  import type { ConnState } from "../lib/api"
  import type { BoardSettings } from "../lib/types"
  import type { ThemeMode } from "../theme"
  import StatusDot from "./StatusDot.svelte"

  let {
    settings,
    conn,
    mode,
    modeLabel,
    oncreate,
    ontoggle,
    oncyclemode,
  }: {
    settings: BoardSettings
    conn: ConnState
    mode: ThemeMode
    modeLabel: string
    /** 返回 Promise：成功后弹窗关闭并清空；失败（Promise reject）保留输入与弹窗，错误提示由 App 的 toast 负责 */
    oncreate: (title: string, description: string) => Promise<void>
    ontoggle: (requireAnalysisConfirm: boolean) => void
    oncyclemode: () => void
  } = $props()

  let dlg = $state<HTMLDialogElement | null>(null)
  let titleInput = $state<HTMLInputElement | null>(null)
  let title = $state("")
  let description = $state("")
  const canSubmit = $derived(title.trim().length > 0)
  let submitting = $state(false)

  function openCreate() {
    title = ""
    description = ""
    dlg?.showModal()
    titleInput?.focus()
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (!canSubmit || submitting) return
    submitting = true
    try {
      await oncreate(title.trim(), description.trim())
      dlg?.close()
    } catch {
      /* 失败：App 已 toast，保留弹窗与输入供修正 */
    } finally {
      submitting = false
    }
  }
</script>

<header class="app-header">
  <div class="group-left">
    <h1>任务看板</h1>
    <button class="new-btn" onclick={openCreate}>＋ 新建任务</button>
  </div>
  <span class="spacer"></span>
  <div class="group-right">
    <label class="toggle" title="开启后，Agent 提交分析将停在「分析确认」列等待放行">
      <input
        type="checkbox"
        checked={settings.requireAnalysisConfirm}
        onchange={(e) => ontoggle(e.currentTarget.checked)}
      />
      分析需人工确认
    </label>
    <StatusDot state={conn} />
    <button class="ghost" onclick={oncyclemode} title="切换主题（自动 → 浅色 → 深色）">
      {modeLabel}
    </button>
  </div>
</header>

<dialog bind:this={dlg}>
  <form onsubmit={submit}>
    <h3>新建任务</h3>
    <input
      bind:this={titleInput}
      bind:value={title}
      placeholder="标题（必填）"
      aria-label="新任务标题"
      required
    />
    <textarea
      bind:value={description}
      placeholder="描述（可选）"
      aria-label="任务描述"
      rows="3"
    ></textarea>
    <menu>
      <button type="button" class="ghost" onclick={() => dlg?.close()}>取消</button>
      <button type="submit" class="primary" disabled={!canSubmit || submitting}>
        {submitting ? "创建中…" : "创建"}
      </button>
    </menu>
  </form>
</dialog>

<style>
  .group-left,
  .group-right {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .group-right {
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .new-btn {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 13px;
    cursor: pointer;
    white-space: nowrap;
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
    font-size: 13px;
    white-space: nowrap;
    cursor: pointer;
  }
  dialog {
    background: var(--col);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: 10px;
    min-width: 340px;
    padding: 16px;
  }
  dialog::backdrop {
    background: rgba(0, 0, 0, 0.55);
  }
  dialog form {
    display: grid;
    gap: 10px;
  }
  dialog h3 {
    margin: 0;
    font-size: 14px;
  }
  dialog input,
  dialog textarea {
    width: 100%;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 8px;
    font-size: 13px;
  }
  dialog menu {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin: 0;
    padding: 0;
  }
  dialog menu button {
    border: none;
    border-radius: 6px;
    padding: 6px 14px;
    cursor: pointer;
    font-size: 13px;
  }
  dialog menu .primary {
    background: var(--accent);
    color: #fff;
  }
  dialog menu .ghost {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--line);
  }
  dialog menu button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>

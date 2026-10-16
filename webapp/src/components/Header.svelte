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
    oncreate: (title: string, description: string) => void
    ontoggle: (requireAnalysisConfirm: boolean) => void
    oncyclemode: () => void
  } = $props()

  let title = $state("")
  let description = $state("")
  const canSubmit = $derived(title.trim().length > 0)

  function submit(e: SubmitEvent) {
    e.preventDefault()
    if (!canSubmit) return
    oncreate(title.trim(), description.trim())
    title = ""
    description = ""
  }
</script>

<header class="app-header">
  <h1>任务看板</h1>
  <form class="new-task" onsubmit={submit}>
    <input
      placeholder="新任务标题（回车创建）"
      aria-label="新任务标题"
      bind:value={title}
    />
    <input
      placeholder="描述（可选）"
      aria-label="任务描述"
      bind:value={description}
    />
    <button type="submit" disabled={!canSubmit}>创建</button>
  </form>
  <label class="toggle" title="开启后，Agent 提交分析将停在「分析确认」列等待放行">
    <input
      type="checkbox"
      checked={settings.requireAnalysisConfirm}
      onchange={(e) => ontoggle(e.currentTarget.checked)}
    />
    分析需人工确认
  </label>
  <span class="spacer"></span>
  <StatusDot state={conn} />
  <button class="ghost" onclick={oncyclemode} title="切换主题（自动 → 浅色 → 深色）">
    {modeLabel}
  </button>
</header>

<style>
  .new-task {
    display: flex;
    gap: 8px;
    flex: 1;
    max-width: 560px;
  }
  .new-task input {
    flex: 1;
    min-width: 0;
    background: var(--col);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 13px;
  }
  .new-task button {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 6px 14px;
    cursor: pointer;
  }
  .new-task button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
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
</style>

<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog"
  import { Button } from "$lib/components/ui/button"
  import { Input } from "$lib/components/ui/input"
  import { Textarea } from "$lib/components/ui/textarea"
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu"
  import { Switch } from "$lib/components/ui/switch"
  import type { ConnState } from "$lib/api"
  import type { BoardSettings } from "$lib/types"
  import type { ThemeMode } from "../theme"
  import { MODEL_PLACEHOLDER, groupModels } from "$lib/model-options"
  import StatusDot from "./StatusDot.svelte"

  let {
    settings,
    conn,
    mode,
    modeLabel,
    models,
    oncreate,
    ontoggle,
    ondispatch,
    onmodel,
    onsetmode,
  }: {
    settings: BoardSettings
    conn: ConnState
    mode: ThemeMode
    modeLabel: string
    /** 可用模型清单("provider/model" 行;/api/models 不可用时为空 → 下拉只留默认项+提示) */
    models: string[]
    /** 返回 Promise：成功后弹窗关闭并清空；失败（Promise reject）保留输入与弹窗，错误提示由 App 的 toast 负责 */
    oncreate: (title: string, description: string) => Promise<void>
    ontoggle: (requireAnalysisConfirm: boolean) => void
    ondispatch: (autoDispatch: boolean) => void
    /** 阶段模型变更(phase 为设置字段名;空串=跟随 opencode 默认) */
    onmodel: (phase: "modelAnalyze" | "modelExecute", value: string) => void
    /** 主题菜单选择（auto 跟随系统 / light 浅色 / dark 深色） */
    onsetmode: (mode: ThemeMode) => void
  } = $props()

  let open = $state(false)
  let title = $state("")
  let description = $state("")
  const canSubmit = $derived(title.trim().length > 0)
  let submitting = $state(false)

  // 阶段模型下拉:受控值镜像(settings 是 props 不可 bind);选项异步就绪后重申当前值,
  // 防浏览器在 value 不在 option 列表时静默回落到首项
  const modelGroups = $derived(groupModels(models))
  let analyzeSel = $state("")
  let executeSel = $state("")
  $effect(() => {
    void modelGroups
    analyzeSel = settings.modelAnalyze ?? ""
    executeSel = settings.modelExecute ?? ""
  })

  function openCreate() {
    title = ""
    description = ""
    open = true
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (!canSubmit || submitting) return
    submitting = true
    try {
      await oncreate(title.trim(), description.trim())
      open = false
    } catch {
      /* 失败：App 已 toast，保留弹窗与输入供修正 */
    } finally {
      submitting = false
    }
  }

  const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
    { value: "auto", label: "跟随系统" },
    { value: "light", label: "浅色" },
    { value: "dark", label: "深色" },
  ]
</script>

<header class="sticky top-0 z-10 flex flex-wrap items-center gap-4 border-b bg-background px-4 py-2.5">
  <div class="flex min-w-0 items-center gap-3">
    <h1 class="whitespace-nowrap text-base font-semibold">任务看板</h1>
    <Button size="sm" onclick={openCreate}>＋ 新建任务</Button>
  </div>
  <span class="flex-1"></span>
  <div class="flex flex-wrap items-center justify-end gap-2">
    <label
      class="inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 whitespace-nowrap transition-all
        {settings.requireAnalysisConfirm
          ? 'border-emerald-500/40 bg-emerald-500/10'
          : 'border-border bg-card/40 opacity-60'}"
      title="开启后，Agent 提交分析将停在「分析确认」泳道等待放行">
      <Switch checked={settings.requireAnalysisConfirm} onCheckedChange={(v) => ontoggle(v)} aria-label="分析需人工确认" />
      <span class="text-[13px] font-medium">分析需人工确认</span>
      <span
        class="text-[12px] font-bold {settings.requireAnalysisConfirm ? 'text-emerald-400' : 'text-zinc-500'}"
        aria-hidden="true">
        {settings.requireAnalysisConfirm ? "已开启" : "已关闭"}
      </span>
    </label>
    <label
      class="inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 whitespace-nowrap transition-all
        {settings.autoDispatch
          ? 'border-emerald-500/40 bg-emerald-500/10'
          : 'border-border bg-card/40 opacity-60'}"
      title="开启后，待领取出现任务时插件会自动驱动一个 Agent 会话领取并处理">
      <Switch checked={settings.autoDispatch} onCheckedChange={(v) => ondispatch(v)} aria-label="自动领取" />
      <span class="text-[13px] font-medium">自动领取</span>
      <span
        class="text-[12px] font-bold {settings.autoDispatch ? 'text-emerald-400' : 'text-zinc-500'}"
        aria-hidden="true">
        {settings.autoDispatch ? "已开启" : "已关闭"}
      </span>
    </label>
    <label
      class="inline-flex items-center gap-2 rounded-lg border border-border bg-card/40 px-3 py-1.5 whitespace-nowrap"
      title="分析阶段(领取/分析/重析回合)worker 会话使用的模型;「跟随默认」用 opencode 默认解析">
      <span class="text-[13px] font-medium">分析模型</span>
      <select
        bind:value={analyzeSel}
        onchange={() => onmodel("modelAnalyze", analyzeSel)}
        class="max-w-44 rounded-md border border-border bg-background px-1.5 py-1 text-[12px] text-foreground outline-none focus:ring-1 focus:ring-ring"
        aria-label="分析阶段模型">
        <option value="">{MODEL_PLACEHOLDER}</option>
        {#if modelGroups.length === 0}
          <option value="__none__" disabled>(模型列表不可用)</option>
        {/if}
        {#each modelGroups as g (g.provider)}
          <optgroup label={g.provider}>
            {#each g.models as m (m)}
              <option value={`${g.provider}/${m}`}>{m}</option>
            {/each}
          </optgroup>
        {/each}
      </select>
    </label>
    <label
      class="inline-flex items-center gap-2 rounded-lg border border-border bg-card/40 px-3 py-1.5 whitespace-nowrap"
      title="执行阶段(放行后的执行回合)worker 会话使用的模型;与分析模型可不同,同会话按回合切换">
      <span class="text-[13px] font-medium">执行模型</span>
      <select
        bind:value={executeSel}
        onchange={() => onmodel("modelExecute", executeSel)}
        class="max-w-44 rounded-md border border-border bg-background px-1.5 py-1 text-[12px] text-foreground outline-none focus:ring-1 focus:ring-ring"
        aria-label="执行阶段模型">
        <option value="">{MODEL_PLACEHOLDER}</option>
        {#if modelGroups.length === 0}
          <option value="__none__" disabled>(模型列表不可用)</option>
        {/if}
        {#each modelGroups as g (g.provider)}
          <optgroup label={g.provider}>
            {#each g.models as m (m)}
              <option value={`${g.provider}/${m}`}>{m}</option>
            {/each}
          </optgroup>
        {/each}
      </select>
    </label>
    <StatusDot state={conn} />
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="sm" title="切换主题">{modeLabel}</Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        <DropdownMenu.RadioGroup value={mode} onValueChange={(v) => onsetmode(v as ThemeMode)}>
          {#each THEME_OPTIONS as opt (opt.value)}
            <DropdownMenu.RadioItem value={opt.value}>{opt.label}</DropdownMenu.RadioItem>
          {/each}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
</header>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-[380px]">
    <Dialog.Header class="gap-1">
      <Dialog.Title class="text-sm">新建任务</Dialog.Title>
      <Dialog.Description class="sr-only">创建一张新的任务卡片</Dialog.Description>
    </Dialog.Header>
    <form class="grid gap-2.5" onsubmit={submit}>
      <Input bind:value={title} placeholder="标题（必填）" aria-label="新任务标题" required />
      <Textarea bind:value={description} placeholder="描述（可选）" aria-label="任务描述" rows="3"></Textarea>
      <Dialog.Footer class="gap-2">
        <Button type="button" variant="ghost" onclick={() => (open = false)}>取消</Button>
        <Button type="submit" disabled={!canSubmit || submitting}>
          {submitting ? "创建中…" : "创建"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

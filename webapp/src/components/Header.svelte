<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog"
  import { Button } from "$lib/components/ui/button"
  import { Input } from "$lib/components/ui/input"
  import { Textarea } from "$lib/components/ui/textarea"
  import { Switch } from "$lib/components/ui/switch"
  import type { ConnState } from "$lib/api"
  import { DEFAULT_PROJECT_ID, type BoardSettings, type Project } from "$lib/types"
  import type { ThemeMode } from "../theme"
  import { modelsConfigured, groupModels } from "$lib/model-options"
  import { projectFilterOptions } from "$lib/project-options"
  import StatusDot from "./StatusDot.svelte"
  import ProjectsDialog from "./ProjectsDialog.svelte"

  let {
    settings,
    conn,
    mode,
    modeLabel,
    models,
    projects,
    filterOptions,
    projectFilter,
    onfilter,
    onprojectschanged,
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
    /** 可用模型清单("provider/model" 行;/api/models 不可用时为空 → 下拉只剩占位+提示) */
    models: string[]
    /** 项目清单(快照事实源;建任务下拉与项目管理弹窗共用) */
    projects: Project[]
    /** 筛选下拉选项(App 经 projectFilterOptions 纯函数算好,含未完结计数) */
    filterOptions: { id: string; label: string; count: number }[]
    /** 项目筛选(空串=全部) */
    projectFilter: string
    onfilter: (id: string) => void
    /** 项目管理弹窗内任何变更后回调(App.refresh 拉新快照) */
    onprojectschanged: () => void
    /** 返回 Promise：成功后弹窗关闭并清空；失败（Promise reject）保留输入与弹窗，错误提示由 App 的 toast 负责 */
    oncreate: (title: string, description: string, projectId: string) => Promise<void>
    ontoggle: (requireAnalysisConfirm: boolean) => void
    ondispatch: (autoDispatch: boolean) => void
    /** 阶段模型变更(phase 为设置字段名;门禁:两模型都必选,无「跟随默认」) */
    onmodel: (phase: "modelAnalyze" | "modelExecute", value: string) => void
    /** 主题选择（auto 跟随系统 / light 浅色 / dark 深色,入口在设置弹层「外观」） */
    onsetmode: (mode: ThemeMode) => void
  } = $props()

  let open = $state(false)
  let settingsOpen = $state(false)
  let title = $state("")
  let description = $state("")
  let projectSel = $state(DEFAULT_PROJECT_ID)
  const modelsReady = $derived(modelsConfigured(settings))
  const canSubmit = $derived(title.trim().length > 0)
  let submitting = $state(false)
  let projectsOpen = $state(false)

  // 阶段模型下拉:受控值镜像(settings 是 props 不可 bind);选项异步就绪后重申当前值,
  // 防浏览器在 value 不在 option 列表时静默回落到首项。
  // $state 留在本组件顶层——设置弹层关闭时内容卸载,状态不能放进弹层内部
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
    projectSel = DEFAULT_PROJECT_ID
    open = true
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (!canSubmit || submitting) return
    submitting = true
    try {
      await oncreate(title.trim(), description.trim(), projectSel)
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

  const SHORTCUTS: { keys: string; desc: string }[] = [
    { keys: "Alt+↑/↓", desc: "跨泳道移动卡片" },
    { keys: "Enter", desc: "打开详情" },
    { keys: "Esc", desc: "关闭弹层 / 收起打回表单" },
    { keys: "Esc（拖拽中）", desc: "取消拖拽" },
  ]
</script>

<header class="sticky top-0 z-10 flex flex-wrap items-center gap-4 border-b bg-background px-4 py-2.5">
  <div class="flex min-w-0 items-center gap-3">
    <h1 class="whitespace-nowrap text-base font-semibold">任务看板</h1>
    <Button
      size="sm"
      onclick={openCreate}
      disabled={!modelsReady}
      title={modelsReady ? "新建任务" : "请先在 ⚙ 设置中选择分析模型与执行模型"}>
      ＋ 新建任务
    </Button>
    <label
      class="inline-flex items-center gap-2 rounded-lg border border-border bg-card/40 px-3 py-1.5 whitespace-nowrap"
      title="按所属项目筛选看板卡片">
      <span class="text-[13px] font-medium">项目</span>
      <select
        value={projectFilter}
        onchange={(e) => onfilter((e.currentTarget as HTMLSelectElement).value)}
        class="max-w-40 rounded-md border border-border bg-background px-1.5 py-1 text-[12px] text-foreground outline-none focus:ring-1 focus:ring-ring"
        aria-label="按项目筛选">
        {#each filterOptions as opt (opt.id)}
          <option value={opt.id}>{opt.label}（{opt.count}）</option>
        {/each}
      </select>
    </label>
    <Button size="sm" variant="outline" onclick={() => (projectsOpen = true)} title="管理项目与工作区">管理项目</Button>
  </div>
  <span class="flex-1"></span>
  <div class="flex flex-wrap items-center justify-end gap-2">
    <StatusDot state={conn} />
    <Button size="sm" variant="outline" onclick={() => (settingsOpen = true)} title="打开设置">⚙ 设置</Button>
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
      <label class="grid gap-1">
        <span class="text-[12px] font-medium text-muted-foreground">所属项目（worker 将在项目工作区运行）</span>
        <select
          bind:value={projectSel}
          class="rounded-md border border-border bg-background px-2 py-1.5 text-[13px] text-foreground outline-none focus:ring-1 focus:ring-ring"
          aria-label="所属项目">
          {#each projects as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
      </label>
      <Dialog.Footer class="gap-2">
        <Button type="button" variant="ghost" onclick={() => (open = false)}>取消</Button>
        <Button type="submit" disabled={!canSubmit || submitting}>
          {submitting ? "创建中…" : "创建"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={settingsOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header class="gap-1">
      <Dialog.Title class="text-sm">设置</Dialog.Title>
      <Dialog.Description class="sr-only">看板流转、模型、外观与快捷键设置</Dialog.Description>
    </Dialog.Header>
    <div class="grid gap-5">
      <!-- 流转 -->
      <section class="grid gap-2.5" aria-label="流转设置">
        <h3 class="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">流转</h3>
        <label class="flex cursor-pointer items-start gap-2.5">
          <Switch
            class="mt-0.5"
            checked={settings.requireAnalysisConfirm}
            onCheckedChange={(v) => ontoggle(v)}
            aria-label="分析需人工确认" />
          <span class="grid gap-0.5">
            <span class="text-[13px] font-medium">分析需人工确认</span>
            <span class="text-[12px] leading-relaxed text-muted-foreground">
              Agent 提交分析后将停在「分析确认」泳道，等待人工放行
            </span>
          </span>
        </label>
        <label class="flex cursor-pointer items-start gap-2.5">
          <Switch
            class="mt-0.5"
            checked={settings.autoDispatch}
            onCheckedChange={(v) => ondispatch(v)}
            aria-label="自动领取" />
          <span class="grid gap-0.5">
            <span class="text-[13px] font-medium">自动领取</span>
            <span class="text-[12px] leading-relaxed text-muted-foreground">
              待领取出现任务时，插件自动驱动一个 Agent 会话领取并处理
            </span>
          </span>
        </label>
      </section>
      <!-- 模型 -->
      <section class="grid gap-2.5" aria-label="模型设置">
        <h3 class="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">模型</h3>
        <label class="grid gap-1">
          <span class="text-[13px] font-medium">分析模型</span>
          <select
            bind:value={analyzeSel}
            onchange={() => onmodel("modelAnalyze", analyzeSel)}
            class="w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px] text-foreground outline-none focus:ring-1 focus:ring-ring"
            aria-label="分析阶段模型">
            <option value="" disabled>请选择模型</option>
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
          <span class="text-[12px] leading-relaxed text-muted-foreground">
            分析阶段（领取/分析/重析回合）worker 会话使用的模型
          </span>
        </label>
        <label class="grid gap-1">
          <span class="text-[13px] font-medium">执行模型</span>
          <select
            bind:value={executeSel}
            onchange={() => onmodel("modelExecute", executeSel)}
            class="w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px] text-foreground outline-none focus:ring-1 focus:ring-ring"
            aria-label="执行阶段模型">
            <option value="" disabled>请选择模型</option>
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
          <span class="text-[12px] leading-relaxed text-muted-foreground">
            执行阶段（放行后的执行回合）worker 会话使用的模型，与分析模型可不同
          </span>
        </label>
      </section>
      <!-- 外观 -->
      <section class="grid gap-2.5" aria-label="外观设置">
        <h3 class="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">
          外观<span class="ml-2 text-[12px] font-normal normal-case">当前：{modeLabel}</span>
        </h3>
        <div class="flex gap-2" role="radiogroup" aria-label="主题">
          {#each THEME_OPTIONS as opt (opt.value)}
            <Button
              size="sm"
              variant={mode === opt.value ? "default" : "outline"}
              aria-pressed={mode === opt.value}
              onclick={() => onsetmode(opt.value)}>
              {opt.label}
            </Button>
          {/each}
        </div>
      </section>
      <!-- 快捷键 -->
      <section class="grid gap-2" aria-label="快捷键说明">
        <h3 class="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">快捷键</h3>
        <ul class="grid gap-1.5">
          {#each SHORTCUTS as sc (sc.keys)}
            <li class="flex items-center gap-2 text-[12px] text-muted-foreground">
              <kbd
                class="inline-flex items-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap text-foreground">
                {sc.keys}
              </kbd>
              <span>{sc.desc}</span>
            </li>
          {/each}
        </ul>
      </section>
    </div>
  </Dialog.Content>
</Dialog.Root>

<ProjectsDialog bind:open={projectsOpen} {projects} onchanged={onprojectschanged} />

<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog"
  import { Button } from "$lib/components/ui/button"
  import { Input } from "$lib/components/ui/input"
  import { Textarea } from "$lib/components/ui/textarea"
  import { Badge } from "$lib/components/ui/badge"
  import { createProject, updateProject, deleteProject } from "$lib/api"
  import { confirmDialog, notify } from "$lib/notify"
  import type { Project } from "$lib/types"

  let {
    projects,
    open = $bindable(false),
    onchanged,
  }: {
    projects: Project[]
    open?: boolean
    /** 任何项目变更成功后回调(App.refresh 拉新快照,SSE 亦会广播) */
    onchanged: () => void
  } = $props()

  // null = 列表视图;对象 = 编辑;"" 标记新建 —— 用 formProject 区分视图与目标
  let formProject = $state<Project | "new" | null>(null)
  let name = $state("")
  let workspace = $state("")
  let description = $state("")
  let submitting = $state(false)
  const canSubmit = $derived(name.trim().length > 0 && workspace.trim().length > 0 && !submitting)

  function openNew() {
    formProject = "new"
    name = ""
    workspace = ""
    description = ""
  }

  function openEdit(p: Project) {
    formProject = p
    name = p.name
    workspace = p.workspace
    description = p.description ?? ""
  }

  function friendly(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (!canSubmit) return
    submitting = true
    const payload = { name: name.trim(), workspace: workspace.trim(), description: description.trim() || undefined }
    try {
      if (formProject === "new") {
        await createProject(payload)
        notify("success", `项目已创建（${payload.name}）`)
      } else if (formProject) {
        await updateProject(formProject.id, payload)
        notify("success", `项目已更新（${payload.name}）`)
      }
      formProject = null
      onchanged()
    } catch (err) {
      notify("error", `保存失败：${friendly(err)}`)
    } finally {
      submitting = false
    }
  }

  async function remove(p: Project) {
    const ok = await confirmDialog(
      `删除项目「${p.name}」？`,
      "仅当项目下没有未完成任务时才能删除；该项目的已完结任务将一并清除。",
    )
    if (!ok) return
    try {
      await deleteProject(p.id)
      notify("success", `项目已删除（${p.name}）`)
      onchanged()
    } catch (err) {
      notify("error", `删除失败：${friendly(err)}`)
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-[640px]">
    <Dialog.Header class="gap-1">
      <Dialog.Title class="text-sm">项目管理</Dialog.Title>
      <Dialog.Description class="sr-only">管理项目与 worker 工作区目录</Dialog.Description>
    </Dialog.Header>

    {#if formProject === null}
      <div class="grid max-h-[60vh] grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
        {#each projects as p (p.id)}
          <div class="flex flex-col gap-1.5 rounded-lg border p-3">
            <div class="flex items-center gap-2">
              <span class="truncate text-sm font-medium">{p.name}</span>
              {#if p.builtin}
                <Badge variant="secondary" class="font-normal text-muted-foreground">内置</Badge>
              {/if}
            </div>
            <div class="truncate text-xs text-muted-foreground" title={p.workspace}>{p.workspace}</div>
            {#if p.description}
              <div class="line-clamp-2 text-xs text-muted-foreground" title={p.description}>{p.description}</div>
            {/if}
            {#if !p.builtin}
              <div class="mt-auto flex justify-end gap-1 border-t pt-2">
                <Button size="sm" variant="ghost" onclick={() => openEdit(p)}>编辑</Button>
                <Button size="sm" variant="ghost" class="text-destructive" onclick={() => remove(p)}>删除</Button>
              </div>
            {/if}
          </div>
        {/each}
      </div>
      <Dialog.Footer class="gap-2">
        <Button type="button" variant="ghost" onclick={() => (open = false)}>关闭</Button>
        <Button onclick={openNew}>＋ 新建项目</Button>
      </Dialog.Footer>
    {:else}
      <form class="grid gap-2.5" onsubmit={submit}>
        <Input bind:value={name} placeholder="项目名称（必填）" aria-label="项目名称" required />
        <Input bind:value={workspace} placeholder="工作区绝对路径（必填，如 /home/me/repos/gateway）" aria-label="工作区目录" required />
        <Textarea bind:value={description} placeholder="描述（可选）" aria-label="项目描述" rows="2"></Textarea>
        <p class="text-xs text-muted-foreground">工作区必须是本机存在的绝对路径目录；该项目的任务将由 worker 在此目录内执行。</p>
        <Dialog.Footer class="gap-2">
          <Button type="button" variant="ghost" onclick={() => (formProject = null)}>取消</Button>
          <Button type="submit" disabled={!canSubmit}>
            {submitting ? "保存中…" : "保存"}
          </Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>

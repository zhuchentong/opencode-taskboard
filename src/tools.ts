import type { StoreError, Task } from "./types"
import type { Store } from "./store"

/** OpenCode 插件上下文中与工具注册相关的最小结构（避免耦合完整类型） */
interface ToolEditor {
  namespace(ns: { name: string; description: string }): void
  add(tool: {
    name: string
    description: string
    input: Record<string, unknown>
    options?: Record<string, unknown>
    execute: (input: Record<string, unknown>, context: { sessionID: string }) => Promise<{ content: string }>
  }): void
}

interface ToolCtx {
  tool: {
    transform(cb: (editor: ToolEditor) => void): Promise<{ dispose(): Promise<void> }>
  }
}

const NO_PROPS = { type: "object", properties: {}, additionalProperties: false }
const ID_PROPS = {
  type: "object",
  properties: { id: { type: "string", description: "任务 ID" } },
  required: ["id"],
  additionalProperties: false,
}

const ID_STATUS_ENUM = ["planning", "pending", "analyzing", "analysis_confirm", "executing", "completion_confirm", "done"]

/** 注册 taskboard 命名空间下的七个 Agent 工具（生效名 taskboard_<短名>） */
export async function registerTools(ctx: ToolCtx, store: Store): Promise<{ dispose(): Promise<void> }> {
  return ctx.tool.transform((editor) => {
    editor.namespace({ name: "taskboard", description: "任务看板：领取、分析、执行、完成任务" })

    editor.add({
      name: "list",
      description: "列出看板任务（可按状态过滤）",
      input: {
        type: "object",
        properties: { status: { type: "string", enum: ID_STATUS_ENUM, description: "按状态过滤" } },
        additionalProperties: false,
      },
      options: { namespace: "taskboard" },
      execute: async (input) => {
        try {
          const status = typeof input.status === "string" ? input.status : undefined
          const tasks = await store.list()
          const filtered = status ? tasks.filter((t) => t.status === status) : tasks
          if (filtered.length === 0) return { content: `看板上没有${status ? `状态为 ${status} 的` : ""}任务` }
          return { content: filtered.map(renderTask).join("\n\n") }
        } catch (e) {
          return { content: describeError(e) }
        }
      },
    })

    editor.add({
      name: "get",
      description: "查看任务详情",
      input: ID_PROPS,
      options: { namespace: "taskboard" },
      execute: async (input) => {
        try {
          return { content: renderTask(await store.get(String(input.id))) }
        } catch (e) {
          return { content: describeError(e) }
        }
      },
    })

    editor.add({
      name: "claim",
      description: "原子领取一个待领取任务（不带 id 时领取最旧的任务），领取后进入分析中",
      input: {
        type: "object",
        properties: { id: { type: "string", description: "可选：指定任务 ID" } },
        additionalProperties: false,
      },
      options: { namespace: "taskboard" },
      execute: async (input, context) => {
        try {
          const task = await store.claim({
            id: typeof input.id === "string" ? input.id : undefined,
            sessionID: context.sessionID,
            agent: "agent",
          })
          const settings = await store.getSettings()
          const hint = settings.requireAnalysisConfirm
            ? "看板要求：分析完成后需用户在「分析确认」放行，才能进入执行中。"
            : "看板设置：分析提交后将自动进入执行中。"
          return { content: `领取成功。\n${renderTask(task)}\n${hint}` }
        } catch (e) {
          return { content: describeError(e) }
        }
      },
    })

    editor.add({
      name: "analyze",
      description: "提交任务分析结论（必须先 claim）。按看板设置进入分析确认或直接执行中",
      input: {
        type: "object",
        properties: { id: { type: "string", description: "任务 ID" }, analysis: { type: "string", description: "分析结论与实施计划" } },
        required: ["id", "analysis"],
        additionalProperties: false,
      },
      options: { namespace: "taskboard" },
      execute: async (input, context) => {
        try {
          const task = await store.analyze({
            id: String(input.id),
            sessionID: context.sessionID,
            analysis: String(input.analysis),
          })
          return { content: `分析已提交，任务进入 ${task.status}。\n${renderTask(task)}` }
        } catch (e) {
          return { content: describeError(e) }
        }
      },
    })

    editor.add({
      name: "complete",
      description: "提交任务完成（必须处于执行中），任务进入完成确认等待用户确认",
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "任务 ID" },
          result: { type: "string", description: "执行结果备注" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      options: { namespace: "taskboard" },
      execute: async (input, context) => {
        try {
          const task = await store.complete({
            id: String(input.id),
            sessionID: context.sessionID,
            result: typeof input.result === "string" ? input.result : undefined,
          })
          return { content: `执行完成已提交，任务进入 completion_confirm，等待用户确认。\n${renderTask(task)}` }
        } catch (e) {
          return { content: describeError(e) }
        }
      },
    })

    editor.add({
      name: "release",
      description: "放弃当前任务（分析中/执行中），任务回到待领取队列",
      input: ID_PROPS,
      options: { namespace: "taskboard" },
      execute: async (input, context) => {
        try {
          const task = await store.release({ id: String(input.id), sessionID: context.sessionID })
          return { content: `已放弃任务，任务回到待领取。\n${renderTask(task)}` }
        } catch (e) {
          return { content: describeError(e) }
        }
      },
    })

    editor.add({
      name: "update",
      description: "更新任务的分析/结果备注（不改变状态）",
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "任务 ID" },
          analysis: { type: "string", description: "分析备注" },
          result: { type: "string", description: "结果备注" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      options: { namespace: "taskboard" },
      execute: async (input, context) => {
        try {
          const task = await store.updateNotes({
            id: String(input.id),
            sessionID: context.sessionID,
            analysis: typeof input.analysis === "string" ? input.analysis : undefined,
            result: typeof input.result === "string" ? input.result : undefined,
          })
          return { content: `备注已更新。\n${renderTask(task)}` }
        } catch (e) {
          return { content: describeError(e) }
        }
      },
    })
  })
}

/** 把异常转成给 Agent 看的中文可读文案（不抛出） */
export function describeError(e: unknown): string {
  const err = e as StoreError
  if (err && typeof err === "object" && typeof err.code === "string") {
    const msg = err instanceof Error ? err.message : String(e)
    switch (err.code) {
      case "not_found":
        return `任务已不存在（可能已被删除），请放弃该任务。(${msg})`
      case "invalid_transition":
        return `操作被拒绝：任务当前状态不允许该操作。${msg}`
      case "conflict":
        return `操作被拒绝：任务冲突。${msg}`
      case "not_claimer":
        return `操作被拒绝：${msg}。请改用 taskboard_claim 认领其他待领取任务。`
      case "comment_required":
        return `操作被拒绝：${msg}`
      case "no_pending":
        return `看板当前没有待领取的任务。${msg}`
      case "invalid_input":
        return `参数不合法：${msg}`
      case "unreachable":
        return `看板服务不可达：${msg}（主实例可能已退出，请让用户重启 OpenCode 会话）`
      case "forbidden":
        return `访问被拒绝：令牌不匹配。${msg}（请让用户重启会话以重新同步令牌）`
      default:
        return `看板操作失败：${msg}`
    }
  }
  return `看板操作失败：${e instanceof Error ? e.message : String(e)}`
}

/** 任务的可读摘要（中文，多行） */
export function renderTask(t: Task): string {
  const lines: string[] = []
  lines.push(`任务 ${t.id} [${t.status}] ${t.title}`)
  if (t.description) lines.push(`描述：${t.description}`)
  if (t.analysis) lines.push(`分析：${t.analysis}`)
  if (t.result) lines.push(`结果：${t.result}`)
  if (t.claim) {
    lines.push(
      t.claim.agent === "human"
        ? "领取者：用户本人（Agent 不可操作）"
        : `领取者：会话 ${t.claim.sessionID}（agent=${t.claim.agent}）`,
    )
  } else {
    lines.push("领取者：无")
  }
  lines.push(`评论：${t.comments.length} 条`)
  for (const c of t.comments.slice(-5)) {
    lines.push(`  - [${c.author}] ${c.text}`)
  }
  if (t.status === "analysis_confirm") lines.push("该任务正在等待用户确认分析，请提醒用户在看板上放行或打回。")
  if (t.status === "completion_confirm") lines.push("该任务正在等待用户确认完成，请提醒用户在看板上确认或打回。")
  return lines.join("\n")
}

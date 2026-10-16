import type { Store } from "./store"

/** OpenCode 插件上下文中与命令注册相关的最小结构 */
interface CommandEditor {
  add(cmd: {
    name: string
    description?: string
    execute: (input: { sessionID: string; prompt: { text: string }; delivery: "steer" | "queue" }) => Promise<void>
  }): void
}

interface CommandSessionCtx {
  command: { transform(cb: (editor: CommandEditor) => void): Promise<{ dispose(): Promise<void> }> }
  session: {
    prompt(input: { sessionID: string; text: string; delivery: "steer" | "queue" }): Promise<unknown>
    synthetic(input: { sessionID: string; text: string }): Promise<unknown>
  }
}

export function buildBoardText(url: string): string {
  return `📋 任务看板已就绪：${url}\n在浏览器打开上述地址即可查看与操作任务看板（仅限本机访问）。`
}

export function buildClaimPrompt(): string {
  return [
    "请完成一个看板任务的完整闭环。taskboard 工具在代码工具目录的 taskboard 命名空间下（tools.taskboard.claim 等），也可能以原生 taskboard_* 工具出现；找不到时先在工具目录里搜索 taskboard。",
    "1. 领取：taskboard_claim 领取一个待领取任务（不带 id 自动领最旧；失败则按提示重试或停止）；",
    "2. 分析：阅读代码与任务描述，用 taskboard_analyze 提交分析结论与实施计划；",
    "3. 若看板要求分析确认（领取返回的提示会说明），提醒用户在「分析确认」列放行后再继续，不要跳过；",
    "4. 执行：按计划完成修改，期间可用 taskboard_update 更新进度；",
    "5. 提交：完成后用 taskboard_complete 提交执行结果，任务进入完成确认，等用户在网页确认；",
    "6. 若任务被打回（评论里写明原因），根据评论修正后重新提交完成。",
  ].join("\n")
}

export function registerCommands(
  ctx: CommandSessionCtx,
  _store: Store,
  opts: { port: number },
): Promise<{ dispose(): Promise<void> }> {
  const url = `http://127.0.0.1:${opts.port}/`
  return ctx.command.transform((editor) => {
    editor.add({
      name: "taskboard",
      description: "打开任务看板网页",
      execute: async ({ sessionID }) => {
        try {
          Bun.spawn(["xdg-open", url])
        } catch {
          // 打不开浏览器时仅输出地址
        }
        await ctx.session.synthetic({ sessionID, text: buildBoardText(url) })
      },
    })
    editor.add({
      name: "taskboard-claim",
      description: "让 Agent 领取一个待领取任务并按分析→执行→完成确认闭环处理",
      execute: async ({ sessionID, delivery }) => {
        await ctx.session.prompt({ sessionID, text: buildClaimPrompt(), delivery })
      },
    })
  })
}

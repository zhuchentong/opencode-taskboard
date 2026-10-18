/**
 * 派发与唤醒的提示词模板(参数化,独立成模块:未来按任务类型分策略只改这里)。
 */

/**
 * 派发提示词:指定唯一任务,让 worker 按任务本身的需要选择工作流。
 * 历史版本曾用「不要加载或执行任何 skill」压制流程,为的是秒级领取小任务;
 * 代价是复杂任务被强行走最短路径。现在放开,并把 taskID 写死进提示词:
 * 并发场景下 worker 不再自己去「找一个待领取任务」,避免多个 worker 抢同一批任务、
 * 以及 pending 少于并发数时出现无任务可领的空派。
 */
export function buildDispatchPrompt(
  task: { id: string; title: string },
  project?: { name: string; workspace: string },
): string {
  return [
    `【自动派发】这是看板插件的后台自动任务,本次只处理这一个任务:`,
    `  任务 ID:${task.id}`,
    `  任务标题:${task.title}`,
    ...(project ? [`  所属项目:${project.name}（工作区:${project.workspace}）`] : []),
    "",
    "领取前请先读任务描述,如实评估它的复杂度与真实工作量,再动手:任务可能是简单修改,也可能是需要完整设计、实现与验证的复杂工作,请按任务本身的需要自行选择合适的工作流与做法,不要预设流程。",
    "",
    `第 1 步(立即执行):调用 taskboard_claim 领取任务 ${task.id}(工具在代码工具目录 tools.taskboard.claim,找不到就在工具目录搜 taskboard)。`,
    "第 2 步:用 taskboard_analyze 提交分析与实施计划(复杂任务要把方案讲清楚,简单任务不必过度工程化);若看板要求分析确认,领取返回的提示会说明,此时停下等待放行,不要继续。",
    "第 3 步:按计划完成任务。怎么做由你按任务本身的需要判断:需要设计、需要拆步骤、需要更多验证,或反之直接改完,都由你决定。",
    "第 4 步:用 taskboard_complete 提交完成结果,任务进入完成确认。",
    "",
    "完成提交后立即停止。若领取失败(invalid_transition 等),等待即可,不要重试。",
  ].join("\n")
}

/** 执行唤醒:曾停在分析确认、现已放行 executing,同会话继续 */
export function buildExecuteNudgePrompt(task: { title: string }): string {
  return `看板任务「${task.title}」已放行进入执行。请继续完成它并用 taskboard_complete 提交;完成后停止。`
}

/**
 * 重析唤醒:人工把 analysis_confirm 拖回 analyzing(claim 保留、同会话),
 * 附带用户最近评论作为答复 —— 问答循环的「确认并继续分析」。
 */
export function buildReanalyzePrompt(task: { title: string }, latestComment: string | null): string {
  const feedback = latestComment ?? "(无评论,请复查分析)"
  return `看板任务「${task.title}」已退回分析中。请根据用户反馈继续分析:${feedback};完成后用 taskboard_analyze 再次提交并等待确认。`
}

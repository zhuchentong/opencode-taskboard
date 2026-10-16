/**
 * 看板渲染守卫：把任务列表与设置压成一个内容指纹。
 * 前端轮询时比较指纹，内容未变则跳过 innerHTML 重建，避免打断进行中的拖拽。
 */

/**
 * @param {import("../types").Task[]} tasks
 * @param {import("../types").BoardSettings} settings
 * @returns {string}
 */
export function boardKey(tasks, settings) {
  return JSON.stringify({
    s: settings?.requireAnalysisConfirm === true,
    t: tasks.map((t) => [
      t.id,
      t.status,
      t.title,
      t.description ?? "",
      t.analysis ?? "",
      t.result ?? "",
      t.claim?.sessionID ?? "",
      t.claim?.agent ?? "",
      t.updatedAt,
      t.comments.map((c) => `${c.author}|${c.text}`).join("§"),
    ]),
  })
}

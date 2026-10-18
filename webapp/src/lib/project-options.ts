import { DEFAULT_PROJECT_ID, type Project, type Task } from "./types"

/**
 * 项目维度纯函数(筛选选项/徽标着色/归属归一)——交互逻辑不进组件。
 */

/** 任务归属归一:缺省(老任务)按默认项目 */
export function normalizeProjectId(t: { projectId?: string }): string {
  return t.projectId ?? DEFAULT_PROJECT_ID
}

/**
 * 项目筛选下拉选项:首项「全部」(id 空串),其余按传入顺序;
 * count = 未完结任务数(done 不计)。
 */
export function projectFilterOptions(
  projects: Project[],
  tasks: Task[],
): { id: string; label: string; count: number }[] {
  const active = tasks.filter((t) => t.status !== "done")
  return [
    { id: "", label: "全部", count: active.length },
    ...projects.map((p) => ({
      id: p.id,
      label: p.name,
      count: active.filter((t) => normalizeProjectId(t) === p.id).length,
    })),
  ]
}

/** 项目徽标着色:名称确定性 hash → 色相 0-359 */
export function badgeHue(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return h % 360
}

/** 项目清单 → id 索引表(徽标/详情解析用) */
export function projectMap(projects: Project[]): Map<string, Project> {
  return new Map(projects.map((p) => [p.id, p]))
}

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// 组件级 DOM 断言在 bun 无 DOM 环境跑不了，以源文本断言钉住这两处回归基线载体：
// 它们分别支撑「关闭详情焦点返还卡片」与「详情关闭按钮唯一（Dialog 内置 ✕）」。
const card = readFileSync(new URL("../src/components/Card.svelte", import.meta.url), "utf8")
const detail = readFileSync(new URL("../src/components/TaskDetail.svelte", import.meta.url), "utf8")

const lane = readFileSync(new URL("../src/components/Lane.svelte", import.meta.url), "utf8")

describe("回归基线载体标记", () => {
  test("Card 根元素带 data-task-id（closeDetail 焦点返还的查询锚点）", () => {
    expect(card).toContain('data-task-id={task.id}')
  })
  test("TaskDetail 关闭按钮唯一（用 Dialog 内置 ✕，不自绘第二个）", () => {
    expect(detail).toContain("<Dialog.Content")
    expect(detail).not.toContain("showCloseButton={false}")
    expect(detail).not.toContain(".Close")
  })
  test("手写拖拽接线恢复（cardDrag action + 插入指示线）", () => {
    expect(card).toContain("use:cardDrag={task.id}")
    expect(lane).toContain('class="drop-line')
  })
})

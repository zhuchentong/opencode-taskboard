import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// 组件级 DOM 断言在 bun 无 DOM 环境跑不了，以源文本断言钉住这两处回归基线载体：
// 它们分别支撑「关闭详情焦点返还卡片」与「详情关闭按钮唯一（Dialog 内置 ✕）」。
const card = readFileSync(new URL("../src/components/Card.svelte", import.meta.url), "utf8")
const detail = readFileSync(new URL("../src/components/TaskDetail.svelte", import.meta.url), "utf8")

const lane = readFileSync(new URL("../src/components/Lane.svelte", import.meta.url), "utf8")

// 终端组件的连接判定：组件级 DOM 断言同样跑不了，
// 这里以源文本断言钉住「判定外置到纯函数 + 不出现失效的合取守卫」（C1 的回归防线）。
const terminal = readFileSync(new URL("../src/components/Terminal.svelte", import.meta.url), "utf8")

describe("回归基线载体标记", () => {
  test("Card 根元素带 data-task-id（closeDetail 焦点返还的查询锚点）", () => {
    expect(card).toContain('data-task-id={task.id}')
  })
  test("TaskDetail 关闭按钮唯一（用 Dialog 内置 ✕，不自绘第二个）", () => {
    expect(detail).toContain("<Dialog.Content")
    expect(detail).not.toContain("showCloseButton={false}")
    expect(detail).not.toContain(".Close")
  })
  test("手写拖拽接线保留，假插入指示线已删（#4：drop 只提交 status，指示与结果背离）", () => {
    expect(card).toContain("use:cardDrag={task.id}")
    // drop-line 是「假插入指示」：松手后按 updatedAt 重排，落点与指示不符，已按产品决策移除并不再恢复
    expect(lane).not.toContain("drop-line")
  })
  test("终端连接判定外置到纯函数 decideTerminalConn（C1 防线）", () => {
    expect(terminal).toContain("decideTerminalConn(")
    // 判定不得留在组件里内联
    expect(terminal).not.toContain("key === connKey &&")
  })
  test("终端不再有失效的 wantConn 守卫变量（C1 防线）", () => {
    expect(terminal).not.toContain("wantConn")
  })
  test("终端改走同源看板 WS（方案 1）：用 terminalWsUrl + 看板令牌", () => {
    expect(terminal).toContain("terminalWsUrl(")
    expect(terminal).toContain("boardToken()")
    // 独立的 sidecar 进程与地址/口令配置已退役。
    // ⚠️ 用精确标记（不拿 "sidecar" 粗筛）：日后注释里提到 sidecar 不该被误判成回归。
    expect(terminal).not.toContain("sidecarWsUrl")
    expect(terminal).not.toContain("config.sidecarUrl")
    expect(terminal).not.toContain("sidecarUrl")
  })
  test("任务详情不再有终端设置入口（配置 UI 已删除）", () => {
    expect(detail).not.toContain("TerminalSettings")
    expect(detail).not.toContain("terminalSettingsOpen")
    expect(detail).not.toContain("loadTerminalConfig")
    expect(detail).not.toContain("sidecarUrl")
  })
})

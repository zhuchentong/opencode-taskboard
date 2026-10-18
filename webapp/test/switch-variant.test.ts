import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// 回归守护:Switch 类串的 data variant 必须与 bits-ui 实际渲染的属性形态匹配。
// 实测(无头浏览器 computed style):bits-ui Switch 放 data-state="checked"/"unchecked",
// 不放 data-checked/data-unchecked——用错形态时背景/边框规则永不命中,开关在暗色主题下
// 完全透明不可见,点击无任何视觉反馈。
const sw = readFileSync(new URL("../src/lib/components/ui/switch/switch.svelte", import.meta.url), "utf8")

describe("Switch 类串与 bits-ui data 属性形态匹配", () => {
  test("checked 态用 data-[state=checked] 形态(背景色可命中)", () => {
    expect(sw).toContain("data-[state=checked]:bg-primary")
    expect(sw).toContain("dark:data-[state=checked]:bg-primary-foreground")
  })
  test("unchecked 态用 data-[state=unchecked] 形态", () => {
    expect(sw).toContain("data-[state=unchecked]:bg-input")
  })
  test("不再使用无属性来源的 data-checked:/data-unchecked: 背景 variant", () => {
    expect(sw).not.toContain("data-checked:bg-primary")
    expect(sw).not.toContain("data-unchecked:bg-input")
  })
  test("Thumb 位移跟随 checked 态(圆点滑动)", () => {
    expect(sw).toContain("group-data-[size=default]/switch:data-[state=checked]:translate-x-[calc(100%_-_2px)]")
  })
})

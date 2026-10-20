import { describe, expect, test } from "bun:test"
import { autoFenceJson, renderMarkdown } from "../src/lib/markdown"

/**
 * 剥标签 + 解码实体，得到可见文本（用于 round-trip 断言；trim 掉 render 尾部换行）。
 * <br> 先转成换行符，避免多行输入在 round-trip 时被无分隔拼接。
 */
function visible(html: string): string {
  return html
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]*>/g, "")
    .trim()
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
}

describe("renderMarkdown · 渲染能力", () => {
  test("标题层级 h1–h6", () => {
    for (let n = 1; n <= 6; n++) {
      const html = renderMarkdown(`${"#".repeat(n)} 标题${n}`)
      expect(html).toContain(`<h${n}>标题${n}</h${n}>`)
    }
  })

  test("有序列表渲染为 ol>li", () => {
    const html = renderMarkdown("1. 甲\n2. 乙")
    expect(html).toContain("<ol>")
    expect(html).toContain("<li>甲</li>")
    expect(html).toContain("<li>乙</li>")
  })

  test("嵌套无序列表渲染出内层 ul", () => {
    const html = renderMarkdown("- 外\n  - 内")
    expect(html.match(/<ul>/g)?.length).toBe(2)
    expect(html).toContain("<li>内</li>")
  })

  test("引用块渲染为 blockquote", () => {
    expect(renderMarkdown("> 引用内容")).toContain("<blockquote>")
  })

  test("围栏代码块：语言 class + 块内尖括号被转义", () => {
    const html = renderMarkdown("```js\nconst a = 1 < 2 && 3 > 2\n```")
    expect(html).toContain('<pre><code class="language-js">')
    expect(html).toContain("1 &lt; 2 &amp;&amp; 3 &gt; 2")
  })

  test("行内标记：粗体 / 斜体 / 行内代码", () => {
    const html = renderMarkdown("**粗** _斜_ `码`")
    expect(html).toContain("<strong>粗</strong>")
    expect(html).toContain("<em>斜</em>")
    expect(html).toContain("<code>码</code>")
  })

  test("GFM 表格渲染为 table 结构", () => {
    const html = renderMarkdown("| A | B |\n| - | - |\n| 1 | 2 |")
    expect(html).toContain("<table>")
    expect(html).toContain("<th>A</th>")
    expect(html).toContain("<td>1</td>")
  })

  test("裸 URL 经 linkify 生成安全链接", () => {
    const html = renderMarkdown("访问 https://example.com 看看")
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain(">https://example.com</a>")
  })
})

describe("renderMarkdown · 边界与健壮性", () => {
  test("空串与纯空白返回空串（不产出空 <p>）", () => {
    expect(renderMarkdown("")).toBe("")
    expect(renderMarkdown("   \n  ")).toBe("")
  })

  test("CRLF 输入渲染为 <br> 分隔（breaks:true）", () => {
    const html = renderMarkdown("甲\r\n乙")
    expect(html).toContain("甲")
    expect(html).toContain("<br>")
    expect(html).toContain("乙")
  })

  test("未闭合代码块不抛异常，降级为 pre/code", () => {
    const html = renderMarkdown("```\n未闭合")
    expect(html).toContain("<pre>")
    expect(html).toContain("未闭合")
  })
})

describe("裸 JSON 自动围栏（autoFenceJson）", () => {
  test("裸单行 JSON 渲染为 json 代码块，内部不再被 markdown/linkify 解释", () => {
    const html = renderMarkdown('{"result": 123, "url": "https://example.com/a", "note": "**不加粗**"}')
    expect(html).toContain('<pre><code class="language-json">')
    expect(html).not.toContain("<strong>")
    expect(html).not.toContain("<a ")
    expect(html).toContain("**不加粗**")
  })

  test("裸多行 JSON 同样围栏（换行进代码块而非 <br>）", () => {
    const html = renderMarkdown('{\n  "items": [1, 2],\n  "note": "**不加粗**"\n}')
    expect(html).toContain('<code class="language-json">')
    expect(html).not.toContain("<strong>")
    expect(html).toContain("[1, 2]")
  })

  test("流式半截 JSON（未闭合）也命中围栏——首字符判据与完整性无关", () => {
    const html = renderMarkdown('{"result": 123, "items": [1,')
    expect(html).toContain('<code class="language-json">')
    expect(html).toContain("[1,")
  })

  test("[ 开头的完整 JSON 数组同样围栏", () => {
    const html = renderMarkdown('[1, 2, {"a": "**b**"}]')
    expect(html).toContain('<code class="language-json">')
    expect(html).not.toContain("<strong>")
  })

  test("[ 开头的 markdown 链接不误伤（链接以 ) 结尾，不命中判据）", () => {
    const html = renderMarkdown("[站点](https://example.com) 首页")
    expect(html).toContain('<a href="https://example.com"')
    expect(html).not.toContain("<pre>")
  })

  test("散文夹 JSON 围栏不受影响（不以 { 开头则原样渲染）", () => {
    const html = renderMarkdown('分析如下：\n\n```json\n{"a": 1}\n```\n\n完毕。')
    expect(html).toContain("<p>分析如下：</p>")
    expect(html.match(/<pre>/g)?.length).toBe(1)
  })

  test("已是围栏的输入不二次围栏（` 开头不命中判据）", () => {
    const html = renderMarkdown('```json\n{"a": 1}\n```')
    expect(html.match(/<pre>/g)?.length).toBe(1)
  })

  test("autoFenceJson 纯函数：非 JSON 原样返回、JSON 包围栏、空白输入安全", () => {
    expect(autoFenceJson("普通文本")).toBe("普通文本")
    expect(autoFenceJson('{"a":1}')).toBe('```json\n{"a":1}\n```')
    expect(autoFenceJson('  [1,2]  ')).toBe("```json\n[1,2]\n```")
    expect(autoFenceJson("[文本](https://x)")).toBe("[文本](https://x)")
    expect(autoFenceJson("")).toBe("")
    expect(autoFenceJson(undefined as unknown as string)).toBe("")
  })

  test("恰好以 { 开头的非 JSON 文本被围栏（记录在案的取舍）", () => {
    const html = renderMarkdown("{{template}}")
    expect(html).toContain('<code class="language-json">')
  })
})

describe("renderMarkdown · 安全边界（语义判据）", () => {
  test("原始 HTML 标签被转义为文本，不产生 script 标签", () => {
    const src = "<script>alert(1)</script>"
    const html = renderMarkdown(src)
    expect(html).not.toContain("<script")
    expect(html).toContain("&lt;script&gt;")
    expect(visible(html)).toBe(src)
  })

  test("img/iframe 等注入标签不生成，且属性不可执行", () => {
    const src = "<img src=x onerror=alert(1)>"
    const html = renderMarkdown(src)
    expect(html).not.toContain("<img")
    expect(html).not.toContain("<iframe")
    expect(visible(html)).toBe(src)
  })

  test("javascript: / data: 协议链接整体降级为纯文本，不生成 a 标签", () => {
    const js = renderMarkdown("[点我](javascript:alert(1))")
    expect(js).not.toContain("<a")
    expect(js).not.toContain('href="javascript:')
    expect(visible(js)).toBe("[点我](javascript:alert(1))")

    const data = renderMarkdown("![图](data:text/html;base64,PHN2Zz4=)")
    expect(data).not.toContain("<img")
    expect(data).not.toContain('href="data:')
  })

  test("合法链接保留 href，并以新窗口打开", () => {
    const html = renderMarkdown("[站点](https://example.com)")
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  test("linkify 生成的裸 URL 同样带 target/rel", () => {
    const html = renderMarkdown("https://example.com")
    expect(html).toContain('target="_blank"')
    expect(html).toContain('href="https://example.com"')
  })
})

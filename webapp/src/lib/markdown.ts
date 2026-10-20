import MarkdownIt from "markdown-it"

// ⚠️ 安全红线（改动前请三思）
// 1. 不得设 html:true —— 任务文本里的 <script>/<img onerror=...> 必须被转义成纯文本。
// 2. link_open 覆盖只能追加 target/rel，不得改写 href、不得跳过 validateLink
//    （它默认拒绝 javascript:/data: 等协议，危险链接整体降级为纯文本，是刻意行为）。
// 3. 本文件是「外部文本 → HTML」的唯一出口，任何新增渲染路径都必须经由 renderMarkdown。
const md = new MarkdownIt({ html: false, breaks: true, linkify: true })

// 链接一律新窗口打开：详情面板里点链接不应把看板整页导航走
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank")
  tokens[idx].attrSet("rel", "noopener noreferrer")
  return defaultLinkOpen(tokens, idx, options, env, self)
}

/** 渲染任务文本为安全 HTML；空白输入返回空串（不产出空 <p>）。不抛异常。 */
export function renderMarkdown(src: string): string {
  const s = (src ?? "").trim()
  return s ? md.render(autoFenceJson(s)) : ""
}

/**
 * 裸 JSON 自动围栏：整段文本像一份 JSON 文档时包上 ```json 围栏，
 * 让 markdown-it 走代码块路径——JSON 字符串值里的 **、_、[链接]、裸 URL 不再被
 * markdown/linkify 误解析（实测裸多行 JSON 里 "**x**" 会渲染成粗体，显示失真）。
 * 判据刻意不用 JSON.parse：流式半截 JSON（未闭合）也要命中围栏；纯函数无状态，逐帧重跑安全。
 * `{` 开头即围栏（markdown 文档几乎不以 { 起头）；
 * `[` 开头须同时以 ] 结尾——markdown 链接 `[文本](url)` 也以 [ 起头（但以 ) 结尾），不得误伤。
 * 已是围栏的输入以 ` 开头、不会二次围栏。
 * 取舍：恰好以 { 开头的非 JSON 文本（如 Go 模板 {{.x}}）会被围成代码块——可读，可接受；
 * 夹在散文中间的裸 JSON 不处理（正道是写 ```json 围栏）。
 */
export function autoFenceJson(src: string): string {
  const t = (src ?? "").trim()
  const isJsonDoc = t.startsWith("{") || (t.startsWith("[") && t.endsWith("]"))
  if (!isJsonDoc) return src ?? ""
  return "```json\n" + t + "\n```"
}

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
  return s ? md.render(s) : ""
}

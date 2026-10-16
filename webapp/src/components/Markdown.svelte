<script lang="ts">
  import { renderMarkdown } from "../lib/markdown"

  let { source }: { source: string } = $props()
  const html = $derived(renderMarkdown(source))
</script>

<!-- {@html} 在此安全：渲染器 html:false，注入内容只含转义后的文本与受白名单约束的链接 -->
<div class="md-body">{@html html}</div>

<style>
  /* 正文内嵌卡片：底色与面板 --col 拉开一档，长文可读性更好。
     嵌套的 code/pre 仍用 --col，在这层底色上表现为「卡片内浮起的浅块」，
     明暗两套主题对比方向一致，无需单独为代码块改色。
     注：本 div 是手写元素，scoped 样式直接生效；其内的 {@html} 节点不带作用域 class，
     故下面的后代规则仍必须用 :global()。 */
  .md-body {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 10px 12px;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  /* 注意：{@html} 注入的节点不带 Svelte 的作用域 class，
     因此下面所有规则必须用 :global()，否则一条都不会命中。 */
  :global(.md-body > :first-child) {
    margin-top: 0;
  }
  :global(.md-body > :last-child) {
    margin-bottom: 0;
  }
  :global(.md-body h1),
  :global(.md-body h2),
  :global(.md-body h3),
  :global(.md-body h4),
  :global(.md-body h5),
  :global(.md-body h6) {
    margin: 10px 0 4px;
    line-height: 1.35;
    color: var(--text);
  }
  :global(.md-body h1) {
    font-size: 16px;
  }
  :global(.md-body h2) {
    font-size: 15px;
  }
  :global(.md-body h3) {
    font-size: 14px;
  }
  :global(.md-body h4),
  :global(.md-body h5),
  :global(.md-body h6) {
    font-size: 13px;
    color: var(--muted);
  }
  :global(.md-body p) {
    margin: 6px 0;
  }
  :global(.md-body ul),
  :global(.md-body ol) {
    margin: 6px 0;
    padding-left: 22px;
  }
  :global(.md-body li) {
    margin: 2px 0;
  }
  :global(.md-body code) {
    background: var(--col);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  :global(.md-body pre) {
    margin: 8px 0;
    padding: 8px 10px;
    background: var(--col);
    border: 1px solid var(--line);
    border-radius: 6px;
    overflow-x: auto;
    max-width: 100%;
  }
  :global(.md-body pre code) {
    background: none;
    border: none;
    padding: 0;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre;
  }
  :global(.md-body blockquote) {
    margin: 8px 0;
    padding: 2px 0 2px 10px;
    border-left: 3px solid var(--line);
    color: var(--muted);
  }
  :global(.md-body a) {
    color: var(--accent);
    text-decoration: none;
  }
  :global(.md-body a:hover) {
    text-decoration: underline;
  }
  :global(.md-body hr) {
    border: none;
    border-top: 1px solid var(--line);
    margin: 10px 0;
  }
  :global(.md-body table) {
    border-collapse: collapse;
    margin: 8px 0;
    font-size: 12px;
    display: block;
    overflow-x: auto;
    max-width: 100%;
  }
  :global(.md-body th),
  :global(.md-body td) {
    border: 1px solid var(--line);
    padding: 3px 8px;
    text-align: left;
  }
  :global(.md-body th) {
    background: var(--col);
  }
</style>

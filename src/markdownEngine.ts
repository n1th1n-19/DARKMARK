import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import katex from '@vscode/markdown-it-katex';
import { shell } from './webviewShell';

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight: (str: string, lang: string) => {
    // highlight.js runs client-side; just wrap in a code block with the language class
    const escaped = md.utils.escapeHtml(str);
    if (lang === 'mermaid') {
      return `<pre class="mermaid">${escaped}</pre>`;
    }
    const langAttr = lang ? ` class="language-${lang}"` : '';
    return `<pre class="code-block" data-lang="${lang || ''}"><code${langAttr}>${escaped}</code></pre>`;
  },
}).use(katex, { enableFencedBlocks: true });

// GitHub-style heading ids so #anchor links and the TOC work
md.core.ruler.push('heading_ids', (state) => {
  const used = new Set<string>();
  state.tokens.forEach((token, i) => {
    if (token.type !== 'heading_open') return;
    const base = state.tokens[i + 1].content
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    // Advance the suffix until unused: "Links", "Links", "Links 1" -> links, links-1, links-1-1
    let id = base;
    for (let n = 1; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    token.attrSet('id', id);
  });
});

// ![](clip.webm) / ![](song.mp3) render as players instead of broken images
const VIDEO = /\.(mp4|m4v|webm|mov|ogv)$/;
const AUDIO = /\.(mp3|wav|ogg|oga|m4a|flac)$/;
const renderImage = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const src = tokens[idx].attrGet('src') ?? '';
  const path = src.split(/[?#]/)[0].toLowerCase();
  const tag = VIDEO.test(path) ? 'video' : AUDIO.test(path) ? 'audio' : '';
  if (!tag) return renderImage(tokens, idx, options, env, self);
  return `<${tag} controls preload="metadata" src="${md.utils.escapeHtml(src)}"></${tag}>`;
};

function renderBody(text: string): string {
  // Task lists: "- [ ] foo" / "- [x] foo" (tight and loose lists)
  return md.render(text).replace(
    /<li>(\s*<p>)?\[([ xX])\]\s/g,
    (_, p = '', mark) =>
      `<li class="task-list-item">${p}<input type="checkbox" disabled${mark === ' ' ? '' : ' checked'}> `
  );
}

/**
 * Renders markdown text to a full HTML document for the webview.
 * `docDir` is the folder containing the .md file; relative image/video/link
 * URLs resolve against it via <base>.
 * When `fragmentOnly` is true, returns just the inner HTML string
 * (for live-update postMessage payloads).
 */
export function renderMarkdown(
  text: string,
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  docDir: vscode.Uri,
  fragmentOnly = false
): string {
  const body = renderBody(text);

  if (fragmentOnly) {
    return body;
  }

  const extUri = (...path: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, ...path));
  const baseUri = webview.asWebviewUri(docDir);
  const CDN = 'https://cdnjs.cloudflare.com/ajax/libs';

  return shell(webview, context, {
    title: 'darkmark',
    // The doc folder, workspace and CDN are allowed sources, but scripts still need the nonce
    csp: (src, nonce) =>
      `default-src 'none'; ` +
      `style-src ${src} https://fonts.googleapis.com https://cdnjs.cloudflare.com 'unsafe-inline'; ` +
      `font-src ${src} https://fonts.gstatic.com; ` +
      `script-src 'nonce-${nonce}'; ` +
      `img-src ${src} https: data:; ` +
      `media-src ${src} https: data:; ` +
      `frame-src https://www.youtube.com https://www.youtube-nocookie.com;`,
    styles: [['out', 'katex', 'katex.min.css'], ['media', 'preview.css']],
    head: `<base href="${baseUri}/" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono&display=swap" />
  <link rel="stylesheet" href="${CDN}/highlight.js/11.9.0/styles/atom-one-dark.min.css" />`,
    body: `  <div id="preview-content">\n${body}\n  </div>`,
    classicScripts: [
      `${CDN}/highlight.js/11.9.0/highlight.min.js`,
      `${CDN}/mermaid/11.15.0/mermaid.min.js`,
      String(extUri('media', 'preview.js')),
    ],
  });
}

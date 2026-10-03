import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import katex from '@vscode/markdown-it-katex';

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
  const seen = new Map<string, number>();
  state.tokens.forEach((token, i) => {
    if (token.type !== 'heading_open') return;
    const base = state.tokens[i + 1].content
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    token.attrSet('id', n ? `${base}-${n}` : base);
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

  const asset = (...path: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, ...path));
  const cssUri = asset('media', 'preview.css');
  const jsUri = asset('media', 'preview.js');
  const logoUri = asset('media', 'logo.svg');
  const katexUri = asset('node_modules', 'katex', 'dist', 'katex.min.css');
  const baseUri = webview.asWebviewUri(docDir);
  // Only our own <script> tags carry the nonce: raw HTML in the markdown can't load
  // scripts from the doc folder, workspace or CDN even though those are allowed sources
  const nonce = randomBytes(16).toString('base64');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <base href="${baseUri}/" />
  <link rel="icon" type="image/svg+xml" href="${logoUri}" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} https://fonts.googleapis.com https://cdnjs.cloudflare.com 'unsafe-inline';
             font-src ${webview.cspSource} https://fonts.gstatic.com;
             script-src 'nonce-${nonce}';
             img-src ${webview.cspSource} https: data:;
             media-src ${webview.cspSource} https: data:;
             frame-src https://www.youtube.com https://www.youtube-nocookie.com;" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono&display=swap" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css" />
  <link rel="stylesheet" href="${katexUri}" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>darkmark</title>
</head>
<body>
  <div id="preview-content">
${body}
  </div>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.15.0/mermaid.min.js"></script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

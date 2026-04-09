import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight: (str: string, lang: string) => {
    // highlight.js runs client-side; just wrap in a code block with the language class
    const escaped = str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const langAttr = lang ? ` class="language-${lang}"` : '';
    return `<pre class="code-block" data-lang="${lang || ''}"><code${langAttr}>${escaped}</code></pre>`;
  },
});

/**
 * Renders markdown text to a full HTML document for the webview.
 * When `fragmentOnly` is true, returns just the inner HTML string
 * (for live-update postMessage payloads).
 */
export function renderMarkdown(
  text: string,
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  fragmentOnly = false
): string {
  const body = md.render(text);

  if (fragmentOnly) {
    return body;
  }

  const cssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'preview.css')
  );
  const jsUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'preview.js')
  );

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} https://fonts.googleapis.com 'unsafe-inline';
             font-src https://fonts.gstatic.com;
             script-src ${webview.cspSource} https://cdnjs.cloudflare.com;
             img-src ${webview.cspSource} https: data:;" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono&display=swap" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>darkmark</title>
</head>
<body>
  <div id="preview-content">
${body}
  </div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script src="${jsUri}"></script>
</body>
</html>`;
}

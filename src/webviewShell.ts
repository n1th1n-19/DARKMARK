import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

export interface ShellOptions {
  title: string;
  body: string;
  /** Extension-relative paths, e.g. ['out', 'webview', 'pdf.js']; loaded as ES modules */
  scripts?: string[][];
  /** Full URLs of classic (non-module) scripts, run in order before the modules */
  classicScripts?: string[];
  /** Extension-relative paths of stylesheets, after media/tokens.css */
  styles?: string[][];
  /** Raw tags placed in <head> before the stylesheets (already escaped by the caller) */
  head?: string;
  /** Builds the CSP. Default: the strict viewer policy */
  csp?: (cspSource: string, nonce: string) => string;
}

/** Strict policy for file viewers and panels: no remote loads at all */
export const viewerCsp = (extra = '') => (src: string, nonce: string) =>
  `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${src} 'unsafe-inline'; ` +
  `img-src ${src} blob: data:; media-src ${src} blob:; connect-src ${src}; font-src ${src}; ${extra}`;

/** Full HTML document for a darkmark webview, with a fresh script nonce per render */
export function shell(webview: vscode.Webview, context: vscode.ExtensionContext, o: ShellOptions): string {
  const asset = (p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, ...p));
  // Only our own <script> tags carry the nonce: untrusted content can't run scripts
  const nonce = randomBytes(16).toString('base64');
  const csp = (o.csp ?? viewerCsp())(webview.cspSource, nonce);
  const styles = [['media', 'tokens.css'], ...(o.styles ?? [])]
    .map((p) => `<link rel="stylesheet" href="${asset(p)}" />`)
    .join('\n  ');
  const scripts = [
    ...(o.classicScripts ?? []).map((u) => `<script nonce="${nonce}" src="${u}"></script>`),
    ...(o.scripts ?? []).map((p) => `<script type="module" nonce="${nonce}" src="${asset(p)}"></script>`),
  ].join('\n  ');
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="icon" type="image/svg+xml" href="${asset(['media', 'logo.svg'])}" />
  ${o.head ?? ''}
  ${styles}
  <title>${escapeHtml(o.title)}</title>
</head>
<body>
${o.body}
  ${scripts}
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

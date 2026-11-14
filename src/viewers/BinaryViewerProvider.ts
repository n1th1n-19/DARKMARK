import { existsSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { watchFile } from '../watchFile';
import { escapeHtml, shell, viewerCsp } from '../webviewShell';

export interface Viewer {
  viewType: string;
  /** Bundle name in out/webview/, without .js */
  script: string;
  /** Extra CSP directives, e.g. "worker-src blob:;" for PDF */
  csp?: string;
}

/**
 * One read-only custom editor for every binary viewer. The extension never reads
 * the file: the webview fetches it by URL, so large files stream from disk and
 * no copy is held in the extension host.
 */
export class BinaryViewerProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly viewer: Viewer
  ) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const { uri } = document;
    const webview = panel.webview;
    const dir = vscode.Uri.joinPath(uri, '..');
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri, dir],
    };

    // ?v=<mtime> so a reload after an on-disk change bypasses the webview cache
    const fileUrl = (stat: vscode.FileStat) => `${webview.asWebviewUri(uri)}?v=${stat.mtime}`;
    const stat = await vscode.workspace.fs.stat(uri);
    const ext = String(webview.asWebviewUri(this.context.extensionUri)).replace(/\/$/, '');
    const name = path.posix.basename(uri.path);
    const css = ['out', 'webview', `${this.viewer.script}.css`];
    const hasCss = existsSync(path.join(this.context.extensionUri.fsPath, ...css));

    // Rebuilt when a hidden tab comes back after the file changed: a hidden webview gets
    // no messages, and on show it reloads this HTML with its (old) cache-buster
    let shownMtime = stat.mtime;
    const render = (s: vscode.FileStat) => (webview.html = shell(webview, this.context, {
      title: name,
      csp: viewerCsp(this.viewer.csp),
      // A viewer that imports CSS gets out/webview/<script>.css from esbuild
      styles: [['media', 'viewer.css'], ...(hasCss ? [css] : [])],
      scripts: [['out', 'webview', `${this.viewer.script}.js`]],
      body: `<div id="app" data-src="${escapeHtml(fileUrl(s))}" data-ext="${escapeHtml(ext)}" ` +
        `data-name="${escapeHtml(name)}" data-size="${s.size}"></div>`,
    }));
    render(stat);

    const disposables: vscode.Disposable[] = [];
    webview.onDidReceiveMessage(
      (msg) => {
        if (msg?.command === 'openDefault') {
          vscode.commands.executeCommand('vscode.openWith', uri, 'default');
        } else if (msg?.command === 'openExternal' && /^(https?|mailto):/i.test(String(msg.href))) {
          // Document content is untrusted: only hand web/mail links to the OS
          vscode.env.openExternal(vscode.Uri.parse(String(msg.href)));
        }
      },
      undefined,
      disposables
    );

    let timer: NodeJS.Timeout | undefined;
    const reload = () => {
      clearTimeout(timer);
      // Debounced: editors often write a file in several steps
      timer = setTimeout(async () => {
        try {
          const s = await vscode.workspace.fs.stat(uri);
          if (s.mtime === shownMtime) return;
          if (!panel.visible) return; // picked up by onDidChangeViewState
          shownMtime = s.mtime;
          webview.postMessage({ command: 'reload', src: fileUrl(s), size: s.size });
        } catch {
          // File deleted or mid-rename: keep showing the last version
        }
      }, 200);
    };
    // Tell the webview to fetch again when the file changes on disk
    disposables.push(watchFile(uri, reload));
    panel.onDidChangeViewState(async () => {
      if (!panel.visible) return;
      try {
        const s = await vscode.workspace.fs.stat(uri);
        if (s.mtime !== shownMtime) {
          shownMtime = s.mtime;
          render(s);
        }
      } catch {
        // File gone: keep the last version
      }
    }, undefined, disposables);

    panel.onDidDispose(() => {
      clearTimeout(timer);
      disposables.forEach((d) => d.dispose());
    });
  }
}

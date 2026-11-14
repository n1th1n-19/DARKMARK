import * as vscode from 'vscode';
import { renderMarkdown } from './markdownEngine';
import { watchFile } from './watchFile';

export class MarkdownEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const webview = webviewPanel.webview;
    const uri = document.uri;
    const key = uri.toString();
    const docDir = vscode.Uri.joinPath(uri, '..');

    // docDir is allowed so images/videos next to the .md load even outside the workspace
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.context.extensionUri,
        docDir,
        ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
      ],
    };

    const readFile = async () =>
      Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    // Counts posted updates so a slow disk read can't overwrite newer content
    let updates = 0;
    const update = (text: string) => {
      updates++;
      webview.postMessage({
        command: 'update',
        html: renderMarkdown(text, webview, this.context, docDir, true),
      });
    };

    webview.html = renderMarkdown(await readFile(), webview, this.context, docDir);

    // Handle postMessage from preview.js
    webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case 'editSource':
          vscode.commands.executeCommand('vscode.openWith', uri, 'default');
          break;
        case 'openExternal':
          // Markdown content is untrusted: only hand web/mail links to the OS
          if (/^(https?|mailto):/i.test(message.href)) {
            vscode.env.openExternal(vscode.Uri.parse(message.href));
          }
          break;
        case 'openLink': {
          let rel: string;
          try {
            rel = decodeURIComponent(String(message.href).split(/[?#]/)[0]);
          } catch {
            break; // malformed %-escape in an untrusted link: ignore the click
          }
          const target = vscode.Uri.joinPath(docDir, rel);
          if (/\.(md|markdown)$/i.test(target.path)) {
            vscode.commands.executeCommand('vscode.openWith', target, 'darkmark.preview');
          } else {
            vscode.commands.executeCommand('vscode.open', target);
          }
          break;
        }
      }
    });

    // Live update when the document changes in a text editor
    const changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== key) return;
      update(e.document.getText());
    });

    // Live update when the file changes on disk (git checkout, other tools)
    const watcher = watchFile(uri, async () => {
      // Unsaved edits in a text editor win over the file on disk
      if (vscode.workspace.textDocuments.some((d) => d.uri.toString() === key && d.isDirty)) {
        return;
      }
      const before = updates;
      const text = await readFile();
      if (updates === before) update(text);
    });

    webviewPanel.onDidDispose(() => {
      changeListener.dispose();
      watcher.dispose();
    });
  }
}

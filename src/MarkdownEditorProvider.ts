import * as vscode from 'vscode';
import { renderMarkdown } from './markdownEngine';

export class MarkdownEditorProvider implements vscode.CustomReadonlyEditorProvider {
  private readonly webviews = new Map<string, vscode.Webview>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = { enableScripts: true };

    const uri = document.uri;
    const key = uri.toString();

    this.webviews.set(key, webview);
    webviewPanel.onDidDispose(() => this.webviews.delete(key));

    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString('utf8');
    webview.html = renderMarkdown(text, webview, this.context);

    // Handle postMessage from preview.js
    webview.onDidReceiveMessage((message) => {
      if (message.command === 'editSource') {
        vscode.commands.executeCommand('vscode.openWith', uri, 'default');
      }
    });

    // Live update when the document changes in a text editor
    const changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== key) return;
      const updated = e.document.getText();
      webview.postMessage({
        command: 'update',
        html: renderMarkdown(updated, webview, this.context, true),
      });
    });

    webviewPanel.onDidDispose(() => changeListener.dispose());
  }
}

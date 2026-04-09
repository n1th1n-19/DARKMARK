import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './MarkdownEditorProvider';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'darkmark.preview',
      new MarkdownEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('darkmark.openAsText', (uri: vscode.Uri) => {
      vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    })
  );
}

export function deactivate() {}

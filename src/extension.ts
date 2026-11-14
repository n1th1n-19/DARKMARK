import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './MarkdownEditorProvider';
import { BinaryViewerProvider, Viewer } from './viewers/BinaryViewerProvider';

// viewType must match contributes.customEditors in package.json
const VIEWERS: Viewer[] = [
  { viewType: 'darkmark.sheet', script: 'sheet' },
  { viewType: 'darkmark.csv', script: 'sheet' },
  { viewType: 'darkmark.docx', script: 'docx' },
  { viewType: 'darkmark.pdf', script: 'pdf', csp: 'worker-src blob:;' },
  { viewType: 'darkmark.image', script: 'image' },
  { viewType: 'darkmark.slides', script: 'slides' },
];

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    // Markdown keeps its context when hidden: it live-syncs with the text editor
    vscode.window.registerCustomEditorProvider('darkmark.preview', new MarkdownEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('darkmark.openAsText', (uri: vscode.Uri) => {
      vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }),
    // Viewers don't retain context: hidden tabs free their memory and restore from setState
    ...VIEWERS.map((v) =>
      vscode.window.registerCustomEditorProvider(v.viewType, new BinaryViewerProvider(context, v), {
        webviewOptions: { enableFindWidget: true },
        supportsMultipleEditorsPerDocument: false,
      })
    )
  );
}

export function deactivate() {}

import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './MarkdownEditorProvider';
import { BinaryViewerProvider, Viewer } from './viewers/BinaryViewerProvider';
import type * as GitModule from './git/index';

// viewType must match contributes.customEditors in package.json
const VIEWERS: Viewer[] = [
  { viewType: 'darkmark.sheet', script: 'sheet' },
  { viewType: 'darkmark.csv', script: 'sheet' },
  { viewType: 'darkmark.docx', script: 'docx' },
  { viewType: 'darkmark.pdf', script: 'pdf', csp: 'worker-src blob:;' },
  { viewType: 'darkmark.image', script: 'image' },
  { viewType: 'darkmark.slides', script: 'slides' },
];

// out/git.js is required on first use, never bundled into extension.js
const git = () => require('./git') as typeof GitModule;

export function activate(context: vscode.ExtensionContext) {
  // Shown on activation, but runs no git command until clicked
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.text = '$(git-merge) darkmark Git';
  status.tooltip = 'Open the darkmark Git panel';
  status.command = 'darkmark.git.open';
  status.show();

  context.subscriptions.push(
    status,
    // Markdown keeps its context when hidden: it live-syncs with the text editor
    vscode.window.registerCustomEditorProvider('darkmark.preview', new MarkdownEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('darkmark.openAsText', (uri: vscode.Uri) => {
      vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }),
    vscode.commands.registerCommand('darkmark.git.open', () => git().open(context)),
    vscode.commands.registerCommand('darkmark.git.fileHistory', (uri?: vscode.Uri) => git().open(context, uri, 'history')),
    vscode.commands.registerCommand('darkmark.git.blame', (uri?: vscode.Uri) => git().open(context, uri, 'blame')),
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

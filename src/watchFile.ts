import * as vscode from 'vscode';

/**
 * Calls `onChange` when `uri` is changed or re-created on disk. Watches the folder and
 * compares URIs, because a glob would read names like `report[1].pdf` as patterns.
 */
export function watchFile(uri: vscode.Uri, onChange: () => void): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), '*'),
    false, false, true
  );
  const key = uri.toString();
  const fire = (e: vscode.Uri) => { if (e.toString() === key) onChange(); };
  return vscode.Disposable.from(watcher, watcher.onDidChange(fire), watcher.onDidCreate(fire));
}

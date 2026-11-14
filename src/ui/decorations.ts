import * as vscode from "vscode";
import { settings } from "../config";
import { SyncEngine } from "../sync/engine";
import { statusLabel } from "./status";

export class HushDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly engine: SyncEngine) {
    this.subscription = engine.onDidChange(() => this.emitter.fire(undefined));
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const mode = settings().explorerBadges;
    const file = this.engine.fileFor(uri);
    if (mode === "off" || !file || !file.exists) return undefined;
    const tooltip = `Hush: ${statusLabel(file)}`;
    const showAll = mode === "all";

    //Color tints the file name, so only conflicts and errors use it
    switch (file.status) {
      case "synced":
        return showAll ? new vscode.FileDecoration("✓", tooltip) : undefined;
      case "pending":
      case "uploading":
        return showAll ? new vscode.FileDecoration("↑", tooltip) : undefined;
      case "remoteNewer":
      case "downloading":
        return showAll ? new vscode.FileDecoration("↓", tooltip) : undefined;
      case "conflict": {
        const decoration = new vscode.FileDecoration("!", tooltip, new vscode.ThemeColor("list.warningForeground"));
        decoration.propagate = true;
        return decoration;
      }
      case "error":
        return new vscode.FileDecoration("×", tooltip, new vscode.ThemeColor("list.errorForeground"));
      default:
        return undefined;
    }
  }
}

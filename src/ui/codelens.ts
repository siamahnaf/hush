import * as vscode from "vscode";
import { settings } from "../config";
import { SCHEME } from "../constants";
import { Session } from "../session";
import { isEnvName } from "../sync/discovery";
import { SyncEngine } from "../sync/engine";
import { basename } from "../util";
import { headline, statusCodicon, statusLabel } from "./status";

export class HushCodeLens implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly engine: SyncEngine,
    private readonly session: Session,
  ) {
    this.subscriptions = [engine.onDidChange(() => this.emitter.fire()), session.onDidChange(() => this.emitter.fire())];
  }

  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.emitter.dispose();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.uri.scheme === SCHEME || !settings().codeLens || !isEnvName(basename(doc.uri))) return [];
    const range = new vscode.Range(0, 0, 0, 0);
    const lens = (icon: string, label: string, command: string, tooltip: string) =>
      new vscode.CodeLens(range, { title: pad(`$(${icon})${GAP}${label}`), command, arguments: [doc.uri], tooltip });

    if (this.session.state === "disconnected" || this.session.state === "noVault") {
      return [lens("cloud", "Hush · Set up backup for this file", "hush.setup", "Open Hush setup")];
    }
    if (this.session.state === "locked") {
      return [lens("lock", "Hush · Unlock to back up this file", "hush.unlock", "Enter your passphrase")];
    }

    const file = this.engine.fileFor(doc.uri);
    if (!file) return [lens("circle-slash", "Hush · Skipped", "hush.openSettings", "Excluded by hush.include or hush.exclude")];

    const push = lens("cloud-upload", "Push", "hush.file.push", "Upload this file and replace the cloud copy");
    const pull = lens("cloud-download", "Pull", "hush.file.pull", "Replace this file with the cloud copy");
    const diff = lens("diff", "Compare", "hush.file.compare", "Compare this file with the cloud copy");
    const history = lens("history", "History", "hush.file.history", "Browse and restore earlier versions");
    const head = lens(statusCodicon(file.status), headline(file), "hush.file.menu", `${statusLabel(file)} · Click for all actions`);

    switch (file.status) {
      case "synced":
        return [head, push, pull, diff, history];
      case "pending":
        return [head, lens("cloud-upload", "Push now", "hush.file.push", "Upload this file now")];
      case "remoteNewer":
        return [head, pull, diff];
      case "conflict":
        return [
          head,
          diff,
          lens("check", "Keep this device", "hush.conflict.keepLocal", "Replace the cloud copy with this file"),
          lens("cloud-download", "Use cloud", "hush.conflict.useCloud", "Replace this file with the cloud copy"),
        ];
      case "untracked":
        return [head, lens("cloud", "Back up this file", "hush.file.track", "Start backing up this file")];
      case "error":
        return [head, lens("refresh", "Retry", "hush.file.push", "Try the upload again")];
      default:
        return [head];
    }
  }
}

//Spacing
const GAP = " ";
const pad = (text: string) => ` ${text} `;

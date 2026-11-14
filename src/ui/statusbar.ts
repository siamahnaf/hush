import * as vscode from "vscode";
import { settings } from "../config";
import { Session } from "../session";
import { FileStatus, SyncEngine } from "../sync/engine";
import { plural } from "../util";

export class HushStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("hush.status", vscode.StatusBarAlignment.Right, 100);
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly engine: SyncEngine,
    private readonly session: Session,
  ) {
    this.item.name = "Hush";
    this.subscriptions = [
      engine.onDidChange(() => this.update()),
      session.onDidChange(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("hush.statusBar")) this.update();
      }),
    ];
    this.update();
  }

  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.item.dispose();
  }

  private update(): void {
    if (!settings().statusBar) {
      this.item.hide();
      return;
    }
    this.item.backgroundColor = undefined;
    switch (this.session.state) {
      case "disconnected":
        this.set("$(cloud) Set up Hush", "Back up your .env files to your own Google Drive", "hush.setup");
        break;
      case "noVault":
        this.set("$(key) Hush: Create passphrase", "Create a passphrase to start backing up", "hush.setup");
        break;
      case "locked":
        this.set("$(lock) Hush locked", "Enter your passphrase to unlock backups on this computer", "hush.unlock");
        break;
      case "unlocked":
        this.updateUnlocked();
        break;
    }
    this.item.show();
  }

  private updateUnlocked(): void {
    const files = this.engine.files.filter((file) => file.tracked);
    const count = (...statuses: FileStatus[]) => files.filter((file) => statuses.includes(file.status)).length;
    const conflicts = count("conflict");
    const errors = count("error");
    const busy = count("uploading", "downloading");
    const pending = count("pending");
    const newer = count("remoteNewer", "missingLocal");
    const synced = count("synced");

    if (!files.length) {
      this.set("$(cloud) Hush", "No .env files in this workspace");
    } else if (conflicts) {
      this.set(`$(warning) ${plural(conflicts, "conflict")}`, "Files changed here and in the cloud. Open Hush to compare.");
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else if (errors) {
      this.set(`$(error) Hush: ${errors} failed`, "Some backups failed. Open Hush for details.");
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else if (busy) {
      this.set("$(sync~spin) Backing up…", "Hush is syncing your .env files");
    } else if (pending) {
      this.set(`$(cloud-upload) ${pending} waiting`, "Waiting to upload");
    } else if (newer) {
      this.set(`$(cloud-download) ${newer} newer in cloud`, "Pull the newer versions from the Hush sidebar");
    } else {
      this.set(`$(check) ${synced} backed up`, "Every .env file in this workspace is backed up");
    }
  }

  private set(text: string, tooltip: string, command = "workbench.view.extension.hush"): void {
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.command = command;
  }
}

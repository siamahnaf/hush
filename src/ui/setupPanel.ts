import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { settings } from "../config";
import { generatePassphrase } from "../crypto/words";
import { Session } from "../session";
import { BatchResult, SyncEngine } from "../sync/engine";
import { errorMessage } from "../util";

export const MIN_PASSPHRASE = 12;

type Step = "welcome" | "connect" | "pass" | "unlock" | "files" | "done";

type Incoming =
  | { type: "ready" }
  | { type: "start" }
  | { type: "connect" }
  | { type: "cancelConnect" }
  | { type: "generate" }
  | { type: "create"; passphrase: string }
  | { type: "unlock"; passphrase: string }
  | { type: "backup"; keys: string[]; autoPush: boolean }
  | { type: "gitignore"; key: string }
  | { type: "forgot" }
  | { type: "openView" }
  | { type: "close" };

export class SetupPanel implements vscode.Disposable {
  private static current?: SetupPanel;
  private readonly panel: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private started = false;
  private finished: boolean;
  private disposed = false;
  private result?: BatchResult;
  private summary?: { projects: number; files: number };
  private connecting?: vscode.CancellationTokenSource;

  static show(ctx: vscode.ExtensionContext, session: Session, engine: SyncEngine): void {
    if (SetupPanel.current) {
      SetupPanel.current.panel.reveal();
      void SetupPanel.current.post();
      return;
    }
    SetupPanel.current = new SetupPanel(ctx, session, engine);
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly session: Session,
    private readonly engine: SyncEngine,
  ) {
    this.finished = session.state === "unlocked" && !engine.files.some((file) => file.exists && file.tracked && file.status === "pending");
    this.panel = vscode.window.createWebviewPanel("hush.setup", "Hush Setup", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "media")],
    });
    this.panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, "media", "logo.png");
    this.panel.webview.html = this.html();
    this.subscriptions.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message: Incoming) => void this.receive(message)),
      session.onDidChange(() => {
        this.summary = undefined;
        void this.post();
      }),
      engine.onDidChange(() => {
        if (this.step() === "files") void this.post();
      }),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    SetupPanel.current = undefined;
    this.connecting?.cancel();
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.panel.dispose();
  }

  private step(): Step {
    switch (this.session.state) {
      case "disconnected":
        return this.started ? "connect" : "welcome";
      case "noVault":
        return "pass";
      case "locked":
        return "unlock";
      case "unlocked":
        return this.finished || !vscode.workspace.workspaceFolders?.length ? "done" : "files";
    }
  }

  private async post(): Promise<void> {
    const step = this.step();
    if (step === "unlock" && !this.summary) {
      this.summary = await this.session.store.summary().catch(() => undefined);
    }
    if (this.disposed) return;
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const files = this.engine.files.filter((file) => file.exists);
    void this.panel.webview.postMessage({
      type: "state",
      step,
      email: this.session.email,
      projectName: vscode.workspace.name ?? "this workspace",
      hasWorkspace: !!vscode.workspace.workspaceFolders?.length,
      autoPush: settings().autoPush,
      summary: this.summary,
      result: this.result,
      totals: { backedUp: files.filter((file) => file.status === "synced").length, tracked: files.filter((file) => file.tracked).length },
      files: files.map((file) => ({
        key: file.key,
        path: multiRoot ? `${file.folder.name}/${file.relPath}` : file.relPath,
        tracked: file.tracked,
        gitIgnored: file.gitIgnored ?? null,
      })),
    });
  }

  private async receive(message: Incoming): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          await this.post();
          break;
        case "start":
          this.started = true;
          await this.post();
          break;
        case "connect":
          await this.connect();
          break;
        case "cancelConnect":
          this.connecting?.cancel();
          break;
        case "generate":
          void this.panel.webview.postMessage({ type: "generated", value: generatePassphrase() });
          break;
        case "create":
          if (message.passphrase.length < MIN_PASSPHRASE) throw new Error(`Use at least ${MIN_PASSPHRASE} characters.`);
          await this.session.create(message.passphrase);
          await this.engine.refresh();
          break;
        case "unlock":
          await this.session.unlock(message.passphrase);
          await this.engine.refresh();
          break;
        case "backup":
          await this.backup(message.keys, message.autoPush);
          break;
        case "gitignore":
          await this.engine.fixGitignore(vscode.Uri.parse(message.key));
          await this.post();
          break;
        case "forgot":
          await this.forgot();
          break;
        case "openView":
          await vscode.commands.executeCommand("workbench.view.extension.hush");
          this.panel.dispose();
          break;
        case "close":
          this.panel.dispose();
          break;
      }
    } catch (error) {
      if (error instanceof vscode.CancellationError || this.disposed) return;
      void this.panel.webview.postMessage({ type: "error", message: errorMessage(error) });
    }
  }

  private async connect(): Promise<void> {
    this.connecting?.cancel();
    const source = new vscode.CancellationTokenSource();
    this.connecting = source;
    void this.panel.webview.postMessage({ type: "connecting", value: true });
    try {
      await this.session.connect(source.token);
    } finally {
      if (this.connecting === source) this.connecting = undefined;
      source.dispose();
      if (!this.disposed) void this.panel.webview.postMessage({ type: "connecting", value: false });
    }
  }

  private async backup(keys: string[], autoPush: boolean): Promise<void> {
    const selected = new Set(keys);
    await this.engine.setTracked(this.engine.files.filter((file) => file.exists).map((file): [vscode.Uri, boolean] => [file.uri, selected.has(file.key)]));
    await vscode.workspace.getConfiguration("hush").update("autoPush", autoPush, vscode.ConfigurationTarget.Global);
    this.result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Hush: Backing up" }, (progress) =>
      this.engine.pushAll(undefined, (done, total) => progress.report({ message: `${done + 1} of ${total}`, increment: 100 / total })),
    );
    this.finished = true;
    await this.post();
  }

  private async forgot(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      "Hush can't recover a lost passphrase.",
      {
        modal: true,
        detail: "Your backups can only be opened with the passphrase that created them. You can delete the vault and start over, but your current backups will be lost.",
      },
      "Delete vault and start over",
    );
    if (choice) await vscode.commands.executeCommand("hush.account.resetVault");
  }

  private html(): string {
    const webview = this.panel.webview;
    const media = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", ...parts)).toString();
    const nonce = randomBytes(16).toString("base64");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media("setup", "setup.css")}">
<title>Hush Setup</title>
</head>
<body data-logo="${media("logo.png")}">
<main id="app" aria-live="polite"></main>
<script nonce="${nonce}" src="${media("setup", "setup.js")}"></script>
</body>
</html>`;
  }
}

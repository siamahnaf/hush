import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { Session } from "../session";
import { SyncEngine } from "../sync/engine";
import { basename } from "../util";
import { headline, statusLabel } from "./status";

export const ENV_EDITOR = "hush.envEditor";

type Incoming =
  | { type: "ready" }
  | { type: "edit"; text: string }
  | { type: "command"; id: string }
  | { type: "copy"; value: string };

//Webview action → command
const COMMANDS: Record<string, string> = {
  push: "hush.file.push",
  pull: "hush.file.pull",
  compare: "hush.file.compare",
  history: "hush.file.history",
  keepLocal: "hush.conflict.keepLocal",
  useCloud: "hush.conflict.useCloud",
  track: "hush.file.track",
  untrack: "hush.file.untrack",
  menu: "hush.file.menu",
  gitignore: "hush.gitignore.add",
};

export class EnvEditorProvider implements vscode.CustomTextEditorProvider {
  static register(ctx: vscode.ExtensionContext, engine: SyncEngine, session: Session): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(ENV_EDITOR, new EnvEditorProvider(ctx, engine, session), {
      webviewOptions: { enableFindWidget: true, retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    });
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly engine: SyncEngine,
    private readonly session: Session,
  ) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const webview = panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "media")] };
    webview.html = this.html(webview);

    // Text of the webview edit currently being applied; changes matching it are echoes, anything else (undo, redo, external edits) is pushed back
    let applying: string | undefined;
    let queue = Promise.resolve();
    const sameDoc = (doc: vscode.TextDocument) => doc.uri.toString() === document.uri.toString();
    const postStatus = () => void webview.postMessage({ type: "status", view: this.view(document) });
    const postText = (type: "init" | "text") => void webview.postMessage({ type, text: normalize(document.getText()), view: this.view(document) });

    const subscriptions = [
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (!sameDoc(event.document) || !event.contentChanges.length) return;
        if (applying !== undefined && normalize(document.getText()) === applying) postStatus();
        else postText("text");
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => sameDoc(doc) && postStatus()),
      this.engine.onDidChange(postStatus),
      this.session.onDidChange(postStatus),
      webview.onDidReceiveMessage(async (message: Incoming) => {
        switch (message.type) {
          case "ready":
            postText("init");
            break;
          case "edit":
            queue = queue
              .then(async () => {
                applying = message.text;
                try {
                  await applyText(document, message.text);
                } finally {
                  applying = undefined;
                }
              })
              .catch(() => undefined);
            await queue;
            break;
          case "copy":
            await vscode.env.clipboard.writeText(message.value);
            vscode.window.setStatusBarMessage("$(copy) Copied to clipboard", 2000);
            break;
          case "command":
            await this.run(document, message.id);
            break;
        }
      }),
    ];
    panel.onDidDispose(() => subscriptions.forEach((subscription) => subscription.dispose()));
  }

  private async run(document: vscode.TextDocument, id: string): Promise<void> {
    if (id === "text") {
      await vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
      return;
    }
    if (id === "setup" || id === "unlock" || id === "settings") {
      await vscode.commands.executeCommand(id === "settings" ? "hush.openSettings" : `hush.${id}`);
      return;
    }
    const command = COMMANDS[id];
    if (!command) return;
    if ((id === "push" || id === "track") && document.isDirty) await document.save();
    await vscode.commands.executeCommand(command, document.uri);
  }

  private view(document: vscode.TextDocument) {
    const file = this.engine.fileFor(document.uri);
    return {
      name: basename(document.uri),
      path: file?.relPath ?? vscode.workspace.asRelativePath(document.uri),
      session: this.session.state,
      status: file ? file.status : "excluded",
      headline: file ? headline(file) : "Not backed up by Hush",
      detail: file ? statusLabel(file) : "Excluded by your include and exclude settings",
      tracked: file?.tracked ?? false,
      hasRemote: !!file?.remote,
      gitIgnored: file?.gitIgnored ?? null,
      dirty: document.isDirty,
    };
  }

  private html(webview: vscode.Webview): string {
    const media = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", ...parts)).toString();
    const nonce = randomBytes(16).toString("base64");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media("editor", "editor.css")}">
<title>Hush</title>
</head>
<body data-logo="${media("logo.png")}">
<div id="app"></div>
<script nonce="${nonce}" src="${media("editor", "editor.js")}"></script>
</body>
</html>`;
  }
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

//Replace only the changed span so undo stays granular
async function applyText(document: vscode.TextDocument, incoming: string): Promise<void> {
  const text = document.eol === vscode.EndOfLine.CRLF ? incoming.replace(/\n/g, "\r\n") : incoming;
  const current = document.getText();
  if (current === text) return;
  let start = 0;
  while (start < current.length && start < text.length && current[start] === text[start]) start++;
  let endCurrent = current.length;
  let endText = text.length;
  while (endCurrent > start && endText > start && current[endCurrent - 1] === text[endText - 1]) {
    endCurrent--;
    endText--;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(endCurrent)), text.slice(start, endText));
  await vscode.workspace.applyEdit(edit);
}

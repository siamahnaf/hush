import * as vscode from "vscode";
import { SCHEME } from "../constants";
import { EnvFile, SyncEngine } from "../sync/engine";
import { basename, errorMessage } from "../util";

export class CloudContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly engine: SyncEngine) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { local, rev } = parseCloudUri(uri);
    try {
      return (await this.engine.readCloud(local, rev)).toString("utf8");
    } catch (error) {
      return `# Hush couldn't load the cloud copy: ${errorMessage(error)}`;
    }
  }
}

export function cloudUri(local: vscode.Uri, rev?: string): vscode.Uri {
  const query = new URLSearchParams({ l: Buffer.from(local.toString(), "utf8").toString("base64url"), t: Date.now().toString(36) });
  if (rev) query.set("r", rev);
  return vscode.Uri.from({ scheme: SCHEME, path: `/${basename(local)}`, query: query.toString() });
}

export function parseCloudUri(uri: vscode.Uri): { local: vscode.Uri; rev?: string } {
  const query = new URLSearchParams(uri.query);
  return {
    local: vscode.Uri.parse(Buffer.from(query.get("l") ?? "", "base64url").toString("utf8")),
    rev: query.get("r") ?? undefined,
  };
}

export async function compare(file: EnvFile): Promise<void> {
  if (!file.remote) {
    void vscode.window.showInformationMessage(`There's no cloud copy of ${file.relPath} yet.`);
    return;
  }
  if (!file.exists) {
    await vscode.window.showTextDocument(cloudUri(file.uri), { preview: true });
    return;
  }
  await vscode.commands.executeCommand("vscode.diff", cloudUri(file.uri), file.uri, `${basename(file.uri)} (Cloud ↔ This device)`);
}

export async function closeCompare(local: vscode.Uri): Promise<void> {
  const tabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === SCHEME && tab.input.modified.toString() === local.toString());
  if (tabs.length) await vscode.window.tabGroups.close(tabs);
}

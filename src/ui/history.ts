import * as vscode from "vscode";
import { EnvFile, SyncEngine } from "../sync/engine";
import { basename, relativeTime } from "../util";
import { cloudUri } from "./conflict";

type VersionItem = vscode.QuickPickItem & { id: string; time: string };
type ActionItem = vscode.QuickPickItem & { action: "compare" | "restore" };

export async function showHistory(engine: SyncEngine, file: EnvFile): Promise<void> {
  const revisions = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Hush: Loading versions" }, () => engine.revisions(file.uri));
  if (!revisions.length) {
    void vscode.window.showInformationMessage(`There's no cloud history for ${file.relPath} yet.`);
    return;
  }

  const items: VersionItem[] = revisions.map((revision, index) => ({
    label: `$(history) ${new Date(revision.modifiedTime).toLocaleString()}`,
    description: index === 0 ? "Current cloud copy" : relativeTime(revision.modifiedTime),
    detail: revision.keepForever ? "Kept forever" : undefined,
    id: revision.id,
    time: revision.modifiedTime,
  }));
  const version = await vscode.window.showQuickPick(items, { title: `${file.relPath} · Version history`, placeHolder: "Choose a version" });
  if (!version) return;

  const when = new Date(version.time).toLocaleString();
  const actions: ActionItem[] = [
    { label: "$(diff) Compare with this device", action: "compare" },
    { label: "$(cloud-download) Restore this version", description: "Replaces this file and backs it up", action: "restore" },
  ];
  const choice = await vscode.window.showQuickPick(actions, { title: `${file.relPath} · ${when}` });
  if (!choice) return;

  if (choice.action === "compare") {
    if (file.exists) await vscode.commands.executeCommand("vscode.diff", cloudUri(file.uri, version.id), file.uri, `${basename(file.uri)} (${when} ↔ This device)`);
    else await vscode.window.showTextDocument(cloudUri(file.uri, version.id), { preview: true });
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Restore ${file.relPath} to the version from ${when}?`,
    { modal: true, detail: "The current file is replaced, and the restored version is backed up as the newest version." },
    "Restore",
  );
  if (confirm && (await engine.restoreVersion(file.uri, version.id))) {
    vscode.window.setStatusBarMessage(`$(check) Restored ${file.relPath}`, 4000);
  }
}

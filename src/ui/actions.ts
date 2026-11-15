import * as vscode from "vscode";
import { Session } from "../session";
import { SyncEngine } from "../sync/engine";
import { basename } from "../util";
import { statusLabel } from "./status";

type ActionItem = vscode.QuickPickItem & { command?: string };

export async function showFileMenu(engine: SyncEngine, session: Session, uri?: vscode.Uri): Promise<void> {
  if (session.state !== "unlocked") {
    await vscode.commands.executeCommand(session.state === "locked" ? "hush.unlock" : "hush.setup");
    return;
  }
  if (!uri) return;
  const file = engine.fileFor(uri);
  if (!file) {
    const choice = await vscode.window.showInformationMessage("Hush skips this file because of your include and exclude settings.", "Open settings");
    if (choice) await vscode.commands.executeCommand("workbench.action.openSettings", "hush.exclude");
    return;
  }

  const items: ActionItem[] = [];
  const add = (icon: string, label: string, command: string, description?: string) => items.push({ label: `$(${icon}) ${label}`, description, command });

  if (file.status === "conflict") {
    add("diff", "Compare with cloud copy", "hush.file.compare");
    add("check", "Keep this device's version", "hush.conflict.keepLocal", "Replace the cloud copy");
    add("cloud-download", "Use the cloud version", "hush.conflict.useCloud", "Replace this file");
  } else if (file.tracked) {
    add("cloud-upload", "Push to Google Drive", "hush.file.push", "Replace the cloud copy");
    if (file.remote) {
      add("cloud-download", "Pull from Google Drive", "hush.file.pull", "Replace this file");
      add("diff", "Compare with cloud copy", "hush.file.compare");
      add("history", "Version history", "hush.file.history");
    }
  }
  items.push({ label: "this file", kind: vscode.QuickPickItemKind.Separator });
  if (file.tracked) add("eye-closed", "Stop backing up this file", "hush.file.untrack");
  else add("cloud", "Back up this file", "hush.file.track");
  if (file.remote) add("trash", "Delete backup", "hush.file.deleteBackup", "Remove it from Google Drive");
  add("gear", "Hush settings", "hush.openSettings");

  const pick = await vscode.window.showQuickPick(items, { title: `${basename(file.uri)} · ${statusLabel(file)}`, placeHolder: "Choose an action" });
  if (pick?.command) await vscode.commands.executeCommand(pick.command, file.uri);
}

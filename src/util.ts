import * as path from "node:path";
import * as vscode from "vscode";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function relativeTime(iso?: string): string {
  if (!iso) return "";
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

//Paths
export function basename(uri: vscode.Uri): string {
  return path.posix.basename(uri.path);
}

export function parentOf(uri: vscode.Uri): vscode.Uri {
  return uri.with({ path: path.posix.dirname(uri.path) });
}

export function relativePath(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
  return path.posix.relative(folder.uri.path, uri.path);
}

export function joinRelative(base: vscode.Uri, relPath: string): vscode.Uri {
  return vscode.Uri.joinPath(base, ...relPath.split("/"));
}

export function isSafeRelativePath(relPath: string): boolean {
  if (!relPath || relPath.startsWith("/") || relPath.includes("\\") || /^[a-zA-Z]:/.test(relPath)) return false;
  return relPath.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

//Files
export async function readLocal(uri: vscode.Uri): Promise<Buffer | undefined> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

export async function writeLocal(uri: vscode.Uri, content: Uint8Array): Promise<void> {
  await vscode.workspace.fs.createDirectory(parentOf(uri));
  await vscode.workspace.fs.writeFile(uri, content);
}

export function isDirty(uri: vscode.Uri): boolean {
  return vscode.workspace.textDocuments.some((doc) => doc.uri.toString() === uri.toString() && doc.isDirty);
}

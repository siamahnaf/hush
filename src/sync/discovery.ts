import { execFile } from "node:child_process";
import * as vscode from "vscode";
import { readLocal } from "../util";

const ENV_NAME = /(^\.env(\..+)?$)|(^.+\.env$)/;
const MAX_FILES = 1000;

export function isEnvName(name: string): boolean {
  return ENV_NAME.test(name);
}

export async function discover(folder: vscode.WorkspaceFolder, include: string[], exclude: string[]): Promise<vscode.Uri[]> {
  if (!include.length) return [];
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, glob(include)), exclude.length ? glob(exclude) : null, MAX_FILES);
  return uris.sort((a, b) => a.path.localeCompare(b.path));
}

function glob(patterns: string[]): string {
  return patterns.length === 1 ? patterns[0] : `{${patterns.join(",")}}`;
}

//Gitignore
export function isGitIgnored(folder: vscode.WorkspaceFolder, uri: vscode.Uri): Promise<boolean | null> {
  if (folder.uri.scheme !== "file" || uri.scheme !== "file" || !vscode.workspace.isTrusted) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.fsmonitor=false", "check-ignore", "-q", "--", uri.fsPath],
      { cwd: folder.uri.fsPath, timeout: 4000, windowsHide: true },
      (error) => {
        if (!error) resolve(true);
        else resolve((error as { code?: unknown }).code === 1 ? false : null);
      },
    );
  });
}

export async function addToGitignore(folder: vscode.WorkspaceFolder, relPath: string): Promise<void> {
  const uri = vscode.Uri.joinPath(folder.uri, ".gitignore");
  const current = (await readLocal(uri))?.toString("utf8") ?? "";
  const entry = `/${relPath}`;
  if (current.split(/\r?\n/).some((line) => line.trim() === entry)) return;
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  await vscode.workspace.fs.writeFile(uri, Buffer.from(`${current}${separator}${entry}\n`, "utf8"));
}

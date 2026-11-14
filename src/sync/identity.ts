import * as vscode from "vscode";
import { readLocal } from "../util";
import { normalizeRemote, originUrl } from "./remote";

export async function detectIdentity(folder: vscode.WorkspaceFolder): Promise<string> {
  const config = await readLocal(vscode.Uri.joinPath(folder.uri, ".git", "config"));
  const url = config ? originUrl(config.toString("utf8")) : undefined;
  return url ? normalizeRemote(url) : `folder:${folder.name.toLowerCase()}`;
}

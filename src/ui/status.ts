import * as vscode from "vscode";
import { EnvFile, FileStatus } from "../sync/engine";
import { relativeTime } from "../util";

export function statusLabel(file: EnvFile): string {
  switch (file.status) {
    case "synced":
      return file.syncedAt ? `Backed up ${relativeTime(file.syncedAt)}` : "Backed up";
    case "pending":
      return "Waiting to upload";
    case "uploading":
      return "Uploading…";
    case "downloading":
      return "Downloading…";
    case "remoteNewer":
      return "Newer version in the cloud";
    case "conflict":
      return "Changed here and in the cloud";
    case "missingLocal":
      return "Not on this device";
    case "untracked":
      return "Not backed up";
    case "error":
      return file.error ? `Backup failed: ${file.error}` : "Backup failed";
  }
}

export function shortLabel(file: EnvFile): string {
  if (file.status === "synced") return relativeTime(file.syncedAt) || "Backed up";
  if (file.status === "error") return "Backup failed";
  return statusLabel(file);
}

const CODICONS: Record<FileStatus, string> = {
  synced: "pass",
  pending: "cloud-upload",
  uploading: "sync~spin",
  downloading: "sync~spin",
  remoteNewer: "cloud-download",
  conflict: "warning",
  missingLocal: "cloud-download",
  untracked: "circle-slash",
  error: "error",
};

const COLORS: Partial<Record<FileStatus, string>> = {
  synced: "hush.brandForeground",
  remoteNewer: "charts.blue",
  conflict: "list.warningForeground",
  missingLocal: "descriptionForeground",
  untracked: "disabledForeground",
  error: "list.errorForeground",
};

export function statusIcon(status: FileStatus): vscode.ThemeIcon {
  const color = COLORS[status];
  return new vscode.ThemeIcon(CODICONS[status], color ? new vscode.ThemeColor(color) : undefined);
}

export function statusCodicon(status: FileStatus): string {
  return status === "synced" ? "pass-filled" : CODICONS[status];
}

export function headline(file: EnvFile): string {
  switch (file.status) {
    case "synced":
      return `Backed up · ${relativeTime(file.syncedAt) || "just now"}`;
    case "pending":
      return "Waiting to upload";
    case "uploading":
      return "Backing up…";
    case "downloading":
      return "Downloading…";
    case "remoteNewer":
      return "Newer version in cloud";
    case "conflict":
      return "Changed here and in cloud";
    case "error":
      return "Backup failed";
    default:
      return statusLabel(file);
  }
}

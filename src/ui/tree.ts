import * as vscode from "vscode";
import { Session } from "../session";
import { CloudFile, CloudProject, EnvFile, Project, SyncEngine } from "../sync/engine";
import { plural, relativeTime } from "../util";
import { shortLabel, statusIcon, statusLabel } from "./status";

export type WorkspaceNode = { kind: "project"; project: Project } | { kind: "file"; file: EnvFile };
export type CloudNode = { kind: "cloudProject"; cloud: CloudProject } | { kind: "cloudFile"; cloud: CloudProject; file: CloudFile };

interface AccountNode {
  id: string;
  label: string;
  description?: string;
  icon: string;
  color?: string;
  command?: string;
  tooltip?: string;
}

//Workspace
class WorkspaceTree implements vscode.TreeDataProvider<WorkspaceNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly engine: SyncEngine,
    private readonly session: Session,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  getChildren(node?: WorkspaceNode): WorkspaceNode[] {
    if (this.session.state !== "unlocked") return [];
    if (!node) return this.engine.projects.filter((project) => project.files.length).map((project) => ({ kind: "project", project }));
    if (node.kind === "project") {
      return [...node.project.files].sort((a, b) => a.relPath.localeCompare(b.relPath)).map((file) => ({ kind: "file", file }));
    }
    return [];
  }

  getTreeItem(node: WorkspaceNode): vscode.TreeItem {
    if (node.kind === "project") {
      const { project } = node;
      const synced = project.files.filter((file) => file.status === "synced").length;
      const item = new vscode.TreeItem(project.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `project:${project.folder.uri.toString()}`;
      item.description = `${synced} of ${project.files.length} backed up`;
      item.iconPath = new vscode.ThemeIcon("root-folder");
      item.contextValue = "project";
      item.tooltip = project.identity.startsWith("folder:") ? "Matched by folder name" : `Matched by git remote ${project.identity}`;
      return item;
    }
    const { file } = node;
    const item = new vscode.TreeItem(file.relPath, vscode.TreeItemCollapsibleState.None);
    item.id = `file:${file.key}`;
    item.description = shortLabel(file);
    item.iconPath = statusIcon(file.status);
    item.contextValue = `file.${file.status}`;
    item.tooltip = new vscode.MarkdownString(
      [`**${file.relPath}**`, statusLabel(file), file.remote?.modifiedTime ? `Cloud copy updated ${relativeTime(file.remote.modifiedTime)}` : ""]
        .filter(Boolean)
        .join("\n\n"),
    );
    if (file.exists) item.command = { command: "vscode.open", title: "Open", arguments: [file.uri] };
    return item;
  }
}

//Cloud
class CloudTree implements vscode.TreeDataProvider<CloudNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly engine: SyncEngine,
    private readonly session: Session,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  async getChildren(node?: CloudNode): Promise<CloudNode[]> {
    if (this.session.state !== "unlocked") return [];
    if (!node) return this.engine.cloud.map((cloud) => ({ kind: "cloudProject", cloud }));
    if (node.kind === "cloudProject") {
      const files = await this.engine.cloudFiles(node.cloud);
      return files.map((file) => ({ kind: "cloudFile", cloud: node.cloud, file }));
    }
    return [];
  }

  getTreeItem(node: CloudNode): vscode.TreeItem {
    if (node.kind === "cloudProject") {
      const item = new vscode.TreeItem(node.cloud.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `cloud:${node.cloud.projectId}`;
      item.description = plural(node.cloud.fileCount, "file");
      item.iconPath = new vscode.ThemeIcon("folder");
      item.contextValue = "cloudProject";
      item.tooltip = node.cloud.identity.startsWith("folder:") || !node.cloud.identity ? node.cloud.name : node.cloud.identity;
      return item;
    }
    const item = new vscode.TreeItem(node.file.path, vscode.TreeItemCollapsibleState.None);
    item.id = `cloud:${node.cloud.projectId}:${node.file.remote.fileId}`;
    item.iconPath = new vscode.ThemeIcon("file");
    item.description = relativeTime(node.file.remote.modifiedTime);
    item.contextValue = "cloudFile";
    return item;
  }
}

//Account
class AccountTree implements vscode.TreeDataProvider<AccountNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly session: Session) {}

  refresh(): void {
    this.emitter.fire();
  }

  getChildren(): AccountNode[] {
    const { state, email } = this.session;
    if (state === "disconnected") return [];
    const nodes: AccountNode[] = [
      { id: "drive", label: "Google Drive", description: email ?? "Connected", icon: "cloud", color: "hush.brandForeground", tooltip: "Backups are stored in hidden app data in your Google Drive. They count toward your storage but never appear in your files." },
    ];
    if (state === "unlocked") {
      nodes.push(
        { id: "vault", label: "Vault unlocked", description: "Lock now", icon: "unlock", command: "hush.vault.lock", tooltip: "Removes the vault key from this computer. You'll need your passphrase to unlock again." },
        { id: "passphrase", label: "Change passphrase", icon: "key", command: "hush.vault.changePassphrase" },
        { id: "rotate", label: "Rotate vault key", icon: "refresh", command: "hush.vault.rotateKey", tooltip: "Re-encrypt every backup with a new key" },
      );
    } else if (state === "locked") {
      nodes.push({ id: "vault", label: "Vault locked", description: "Unlock", icon: "lock", command: "hush.unlock" });
    } else {
      nodes.push({ id: "vault", label: "No vault yet", description: "Create passphrase", icon: "key", command: "hush.setup" });
    }
    nodes.push({ id: "disconnect", label: "Disconnect Google Drive", icon: "debug-disconnect", command: "hush.account.disconnect" });
    return nodes;
  }

  getTreeItem(node: AccountNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.id = `account:${node.id}`;
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.iconPath = new vscode.ThemeIcon(node.icon, node.color ? new vscode.ThemeColor(node.color) : undefined);
    if (node.command) item.command = { command: node.command, title: node.label };
    return item;
  }
}

export function registerTrees(engine: SyncEngine, session: Session): vscode.Disposable[] {
  const workspace = new WorkspaceTree(engine, session);
  const cloud = new CloudTree(engine, session);
  const account = new AccountTree(session);
  const workspaceView = vscode.window.createTreeView("hush.workspace", { treeDataProvider: workspace, canSelectMany: true });
  const cloudView = vscode.window.createTreeView("hush.cloud", { treeDataProvider: cloud });
  const accountView = vscode.window.createTreeView("hush.account", { treeDataProvider: account });

  let lastCloud = engine.cloud;
  let lastState = session.state;
  const update = () => {
    workspace.refresh();
    account.refresh();
    if (engine.cloud !== lastCloud || session.state !== lastState) {
      lastCloud = engine.cloud;
      lastState = session.state;
      cloud.refresh();
    }
    const attention = engine.files.filter((file) => file.status === "conflict" || file.status === "error").length;
    workspaceView.badge = attention ? { value: attention, tooltip: `${plural(attention, "file")} need attention` } : undefined;
  };

  return [workspaceView, cloudView, accountView, engine.onDidChange(update), session.onDidChange(update)];
}

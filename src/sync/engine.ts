import * as os from "node:os";
import * as vscode from "vscode";
import { settings } from "../config";
import { STATE_LINKS, STATE_RECORDS, STATE_UNTRACKED } from "../constants";
import { FileHeader, fileAad, infoAad, openFile, openJson, sealFile, sealJson } from "../crypto/envelope";
import { candidateKeys, deriveId, sha256Hex, VaultKeys } from "../crypto/vault";
import { DriveRevision } from "../drive/client";
import { AuthError, NetworkError } from "../drive/oauth";
import { RemoteFile, RemoteProject } from "../drive/store";
import { Session } from "../session";
import { errorMessage, isDirty, isSafeRelativePath, joinRelative, plural, readLocal, relativePath, writeLocal } from "../util";
import { addToGitignore, discover, isGitIgnored } from "./discovery";
import { detectIdentity } from "./identity";

export type FileStatus =
  | "synced"
  | "pending"
  | "uploading"
  | "downloading"
  | "remoteNewer"
  | "conflict"
  | "missingLocal"
  | "untracked"
  | "error";

export interface EnvFile {
  key: string;
  uri: vscode.Uri;
  folder: vscode.WorkspaceFolder;
  relPath: string;
  projectId: string;
  fileId: string;
  exists: boolean;
  tracked: boolean;
  status: FileStatus;
  localHash?: string;
  remote?: RemoteFile;
  syncedAt?: string;
  error?: string;
  gitIgnored?: boolean | null;
}

export interface Project {
  folder: vscode.WorkspaceFolder;
  identity: string;
  projectId: string;
  name: string;
  folderId?: string;
  infoChecked?: boolean;
  files: EnvFile[];
}

export interface CloudProject extends RemoteProject {
  name: string;
  identity: string;
  fileCount: number;
}

export interface CloudFile {
  path: string;
  remote: RemoteFile;
}

export interface BatchResult {
  total: number;
  done: number;
  conflicts: number;
  failed: number;
}

interface SyncRecord {
  localHash: string;
  rev: string;
  driveId: string;
  syncedAt: string;
}

interface ProjectInfo {
  v: 1;
  name: string;
  identity: string;
}

type Progress = (done: number, total: number) => void;

const PUSH_DELAY = 1500;
const REFRESH_DELAY = 800;
const RETRY_DELAYS = [5, 15, 60, 300];

export class SyncEngine implements vscode.Disposable {
  projects: Project[] = [];
  cloud: CloudProject[] = [];
  private byUri = new Map<string, EnvFile>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly retries = new Map<string, number>();
  private readonly busy = new Map<string, "uploading" | "downloading">();
  private readonly errors = new Map<string, string>();
  private readonly pathCache = new Map<string, string>();
  private readonly infoCache = new Map<string, ProjectInfo | null>();
  private readonly checkedRevs = new Set<string>();
  private readonly notifiedConflicts = new Set<string>();
  private readonly notifiedRemote = new Set<string>();
  private refreshing?: Promise<void>;
  private refreshAgain = false;
  private refreshTimer?: NodeJS.Timeout;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly session: Session,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    clearTimeout(this.refreshTimer);
    this.emitter.dispose();
  }

  private get store() {
    return this.session.store;
  }

  get files(): EnvFile[] {
    return this.projects.flatMap((project) => project.files);
  }

  fileFor(uri: vscode.Uri | undefined): EnvFile | undefined {
    return uri ? this.byUri.get(uri.toString()) : undefined;
  }

  touch(): void {
    this.fire();
  }

  //Refresh
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        await this.doRefresh();
      } while (this.refreshAgain);
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), REFRESH_DELAY);
  }

  async checkRemote(): Promise<void> {
    if (this.session.state !== "unlocked") return;
    await this.session.verify();
    await this.refresh();
    await this.handleRemoteChanges();
  }

  private async doRefresh(): Promise<void> {
    const keys = this.session.keys;
    if (this.session.state !== "unlocked" || !keys) {
      this.projects = [];
      this.cloud = [];
      this.byUri.clear();
      this.fire();
      return;
    }
    const config = settings();
    const untracked = new Set(this.ctx.workspaceState.get<string[]>(STATE_UNTRACKED, []));
    const links = this.ctx.workspaceState.get<Record<string, string>>(STATE_LINKS, {});
    const projects: Project[] = [];

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const identity = links[folder.uri.toString()] ?? (await detectIdentity(folder));
      const projectId = deriveId(keys.idKey, "project", identity);
      const project: Project = { folder, identity, projectId, name: folder.name, files: [] };
      for (const uri of await discover(folder, config.include, config.exclude)) {
        const key = uri.toString();
        const previous = this.byUri.get(key);
        const relPath = relativePath(folder, uri);
        const content = await readLocal(uri);
        project.files.push({
          key,
          uri,
          folder,
          relPath,
          projectId,
          fileId: deriveId(keys.idKey, "file", `${projectId}/${relPath}`),
          exists: true,
          tracked: !untracked.has(key),
          status: "pending",
          localHash: content ? sha256Hex(content) : undefined,
          remote: previous && previous.projectId === projectId ? previous.remote : undefined,
          gitIgnored: previous?.gitIgnored,
        });
      }
      try {
        project.folderId = await this.store.findProjectFolder(projectId);
        if (project.folderId) await this.attachRemote(project, keys);
        else for (const file of project.files) file.remote = undefined;
      } catch (error) {
        if (!this.handleAccessError(error)) this.log.warn(`Couldn't read ${folder.name} from Google Drive: ${errorMessage(error)}`);
      }
      projects.push(project);
    }

    this.projects = projects;
    this.byUri = new Map(projects.flatMap((project) => project.files.map((file) => [file.key, file] as const)));
    this.fire();
    void this.checkGitignore();
    try {
      await this.loadCloud(new Set(projects.map((project) => project.projectId)), keys);
    } catch (error) {
      if (!this.handleAccessError(error)) this.log.warn(`Couldn't list other projects: ${errorMessage(error)}`);
    }
    this.fire();
  }

  private async attachRemote(project: Project, keys: VaultKeys): Promise<void> {
    const remote = await this.store.listFiles(project.folderId!);
    const byFileId = new Map(remote.map((file) => [file.fileId, file]));
    for (const file of project.files) {
      file.remote = byFileId.get(file.fileId);
      byFileId.delete(file.fileId);
    }
    for (const file of byFileId.values()) {
      const relPath = await this.remotePath(project.projectId, file, keys);
      if (!relPath) continue;
      const uri = joinRelative(project.folder.uri, relPath);
      if (await readLocal(uri)) continue;
      project.files.push({
        key: uri.toString(),
        uri,
        folder: project.folder,
        relPath,
        projectId: project.projectId,
        fileId: file.fileId,
        exists: false,
        tracked: true,
        status: "missingLocal",
        remote: file,
      });
    }
    await this.adoptMatchingCopies(project, keys);
  }

  //Same plaintext on both sides counts as synced (new device, key rotation)
  private async adoptMatchingCopies(project: Project, keys: VaultKeys): Promise<void> {
    const records = this.records();
    for (const file of project.files) {
      const remote = file.remote;
      if (!file.exists || !remote || !file.localHash) continue;
      const record = records[file.key];
      if (record && record.driveId === remote.driveId && record.rev === remote.rev) continue;
      const checkKey = `${file.key}@${remote.rev}@${file.localHash}`;
      if (this.checkedRevs.has(checkKey)) continue;
      this.checkedRevs.add(checkKey);
      try {
        const { content } = await this.openRemote(file.projectId, file.fileId, remote.driveId, keys);
        if (sha256Hex(content) === file.localHash) await this.markSynced(file, file.localHash, remote);
      } catch (error) {
        this.log.warn(`Couldn't compare ${file.relPath} with the cloud copy: ${errorMessage(error)}`);
      }
    }
  }

  private async remotePath(projectId: string, remote: RemoteFile, keys: VaultKeys): Promise<string | undefined> {
    const cacheKey = `${remote.driveId}@${remote.rev}`;
    const cached = this.pathCache.get(cacheKey);
    if (cached !== undefined) return cached || undefined;
    try {
      const { header } = await this.openRemote(projectId, remote.fileId, remote.driveId, keys);
      const safe = isSafeRelativePath(header.path) ? header.path : "";
      this.pathCache.set(cacheKey, safe);
      return safe || undefined;
    } catch (error) {
      this.log.warn(`Couldn't read a backup in Google Drive: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private async openRemote(projectId: string, fileId: string, driveId: string, keys: VaultKeys, revisionId?: string) {
    const blob = revisionId ? await this.store.downloadRevision(driveId, revisionId) : await this.store.download(driveId);
    return openFile(candidateKeys(keys), fileAad(projectId, fileId), blob);
  }

  //Cloud Projects
  private async loadCloud(exclude: Set<string>, keys: VaultKeys): Promise<void> {
    const cloud: CloudProject[] = [];
    for (const remote of await this.store.listProjects()) {
      if (exclude.has(remote.projectId)) continue;
      const files = await this.store.listFiles(remote.folderId);
      if (!files.length) continue;
      const info = await this.projectInfo(remote, keys);
      cloud.push({ ...remote, name: info?.name ?? "Unnamed project", identity: info?.identity ?? "", fileCount: files.length });
    }
    this.cloud = cloud.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async projectInfo(remote: RemoteProject, keys: VaultKeys): Promise<ProjectInfo | null> {
    const cached = this.infoCache.get(remote.folderId);
    if (cached !== undefined) return cached;
    let info: ProjectInfo | null = null;
    try {
      const file = await this.store.findInfo(remote.folderId);
      if (file) info = openJson<ProjectInfo>(candidateKeys(keys), infoAad(remote.projectId), await this.store.download(file.id));
    } catch (error) {
      this.log.warn(`Couldn't read project details: ${errorMessage(error)}`);
    }
    this.infoCache.set(remote.folderId, info);
    return info;
  }

  async cloudFiles(cloud: CloudProject): Promise<CloudFile[]> {
    const keys = this.requireKeys();
    const files: CloudFile[] = [];
    for (const remote of await this.store.listFiles(cloud.folderId)) {
      const path = await this.remotePath(cloud.projectId, remote, keys);
      if (path) files.push({ path, remote });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async ensureInfo(project: Project, folderId: string, keys: VaultKeys): Promise<void> {
    if (project.infoChecked) return;
    if (!(await this.store.findInfo(folderId))) {
      const info: ProjectInfo = { v: 1, name: project.name, identity: project.identity };
      await this.store.writeInfo(folderId, sealJson(keys.encKey, infoAad(project.projectId), info));
    }
    project.infoChecked = true;
  }

  //Push
  async push(uri: vscode.Uri, opts: { force?: boolean; quiet?: boolean } = {}): Promise<boolean> {
    const keys = this.session.keys;
    const file = this.fileFor(uri);
    const project = file && this.projectOf(file);
    if (!keys || !file || !file.exists || !project) return false;
    if (this.busy.has(file.key)) {
      this.schedule(file.uri, PUSH_DELAY);
      return false;
    }
    this.setBusy(file, "uploading");
    try {
      const content = Buffer.from(await vscode.workspace.fs.readFile(uri));
      const localHash = sha256Hex(content);
      file.localHash = localHash;
      const folderId = project.folderId ?? (project.folderId = await this.store.ensureProjectFolder(file.projectId));
      await this.ensureInfo(project, folderId, keys);
      const current = await this.store.findFile(folderId, file.fileId);
      const record = this.records()[file.key];
      file.remote = current;

      if (!opts.force) {
        const remoteMoved = !!current && (!record || record.driveId !== current.driveId || record.rev !== current.rev);
        const localMoved = !record || record.localHash !== localHash;
        if (current && remoteMoved) {
          if (!record) {
            const { content: cloud } = await this.openRemote(file.projectId, file.fileId, current.driveId, keys);
            if (sha256Hex(cloud) === localHash) {
              await this.markSynced(file, localHash, current);
              return true;
            }
          } else if (!localMoved) {
            return false;
          }
          this.raiseConflict(file);
          return false;
        }
        if (current && !localMoved) return true;
      }

      const header: FileHeader = { v: 1, path: file.relPath, device: os.hostname(), savedAt: new Date().toISOString() };
      const blob = sealFile(keys.encKey, fileAad(file.projectId, file.fileId), header, content);
      const uploaded = await this.store.uploadFile(folderId, file.fileId, blob, current?.driveId);
      await this.markSynced(file, localHash, uploaded);
      return true;
    } catch (error) {
      this.fail(file, error, "push", opts.quiet);
      return false;
    } finally {
      this.clearBusy(file);
    }
  }

  //Pull
  async pull(uri: vscode.Uri, opts: { force?: boolean; quiet?: boolean } = {}): Promise<boolean> {
    const keys = this.session.keys;
    const file = this.fileFor(uri);
    const project = file && this.projectOf(file);
    if (!keys || !file || !project || this.busy.has(file.key)) return false;
    if (isDirty(uri)) {
      void vscode.window.showWarningMessage(`Save or discard your changes to ${file.relPath} before pulling.`);
      return false;
    }
    this.setBusy(file, "downloading");
    try {
      const folderId = project.folderId ?? (project.folderId = await this.store.findProjectFolder(file.projectId));
      const current = folderId ? await this.store.findFile(folderId, file.fileId) : undefined;
      if (!current) {
        if (!opts.quiet) void vscode.window.showInformationMessage(`There's no cloud copy of ${file.relPath} yet.`);
        return false;
      }
      const { content } = await this.openRemote(file.projectId, file.fileId, current.driveId, keys);
      const cloudHash = sha256Hex(content);
      const local = await readLocal(uri);
      if (local) {
        const localHash = sha256Hex(local);
        file.localHash = localHash;
        if (localHash === cloudHash) {
          await this.markSynced(file, localHash, current);
          return true;
        }
        const record = this.records()[file.key];
        if (!opts.force && (!record || record.localHash !== localHash)) {
          file.remote = current;
          this.raiseConflict(file);
          return false;
        }
      }
      await writeLocal(uri, content);
      file.exists = true;
      file.localHash = cloudHash;
      await this.markSynced(file, cloudHash, current);
      return true;
    } catch (error) {
      this.fail(file, error, "pull", opts.quiet);
      return false;
    } finally {
      this.clearBusy(file);
    }
  }

  //Batch
  async pushAll(folder?: vscode.WorkspaceFolder, progress?: Progress): Promise<BatchResult> {
    await this.refresh();
    const scoped = this.files.filter((file) => file.exists && file.tracked && inFolder(file, folder));
    const targets = scoped.filter((file) => file.status === "pending" || file.status === "error");
    const result = await this.batch(targets, (file) => this.push(file.uri, { quiet: true }), progress);
    result.conflicts += scoped.filter((file) => file.status === "conflict" && !targets.includes(file)).length;
    return result;
  }

  async pullAll(folder?: vscode.WorkspaceFolder, progress?: Progress): Promise<BatchResult> {
    await this.refresh();
    const targets = this.files.filter((file) => (file.status === "remoteNewer" || file.status === "missingLocal") && inFolder(file, folder));
    return this.batch(targets, (file) => this.pull(file.uri, { quiet: true }), progress);
  }

  private async batch(targets: EnvFile[], run: (file: EnvFile) => Promise<boolean>, progress?: Progress): Promise<BatchResult> {
    const result: BatchResult = { total: targets.length, done: 0, conflicts: 0, failed: 0 };
    for (const [index, file] of targets.entries()) {
      progress?.(index, targets.length);
      if (await run(file)) result.done++;
      else if (this.fileFor(file.uri)?.status === "conflict") result.conflicts++;
      else result.failed++;
    }
    return result;
  }

  //Restore
  async restoreInto(cloud: CloudProject, target: vscode.Uri, confirmOverwrite: (paths: string[]) => Promise<boolean>): Promise<number> {
    const keys = this.requireKeys();
    const writes: { uri: vscode.Uri; path: string; content: Buffer; exists: boolean }[] = [];
    for (const remote of await this.store.listFiles(cloud.folderId)) {
      const { header, content } = await this.openRemote(cloud.projectId, remote.fileId, remote.driveId, keys);
      if (!isSafeRelativePath(header.path)) continue;
      const uri = joinRelative(target, header.path);
      const local = await readLocal(uri);
      if (local?.equals(content)) continue;
      writes.push({ uri, path: header.path, content, exists: !!local });
    }
    const existing = writes.filter((write) => write.exists);
    const overwrite = existing.length === 0 || (await confirmOverwrite(existing.map((write) => write.path)));
    const chosen = overwrite ? writes : writes.filter((write) => !write.exists);
    for (const write of chosen) await writeLocal(write.uri, write.content);

    const folder = vscode.workspace.getWorkspaceFolder(target);
    if (folder && folder.uri.toString() === target.toString() && cloud.identity) {
      const links = this.ctx.workspaceState.get<Record<string, string>>(STATE_LINKS, {});
      await this.ctx.workspaceState.update(STATE_LINKS, { ...links, [folder.uri.toString()]: cloud.identity });
    }
    await this.refresh();
    return chosen.length;
  }

  //History
  async readCloud(uri: vscode.Uri, revisionId?: string): Promise<Buffer> {
    const { file, current, keys } = await this.cloudCopy(uri);
    return (await this.openRemote(file.projectId, file.fileId, current.driveId, keys, revisionId)).content;
  }

  async revisions(uri: vscode.Uri): Promise<DriveRevision[]> {
    const { current } = await this.cloudCopy(uri);
    return this.store.revisions(current.driveId);
  }

  async restoreVersion(uri: vscode.Uri, revisionId: string): Promise<boolean> {
    const { file, current, keys } = await this.cloudCopy(uri);
    if (isDirty(uri)) throw new Error(`Save or discard your changes to ${file.relPath} first.`);
    const { content } = await this.openRemote(file.projectId, file.fileId, current.driveId, keys, revisionId);
    await this.store.keepRevision(current.driveId, revisionId).catch(() => undefined);
    await writeLocal(uri, content);
    file.exists = true;
    return this.push(uri, { force: true });
  }

  private async cloudCopy(uri: vscode.Uri): Promise<{ file: EnvFile; current: RemoteFile; keys: VaultKeys }> {
    const keys = this.requireKeys();
    const file = this.fileFor(uri);
    if (!file) throw new Error("Hush isn't backing up this file.");
    const project = this.projectOf(file);
    const folderId = project?.folderId ?? (await this.store.findProjectFolder(file.projectId));
    const current = folderId ? await this.store.findFile(folderId, file.fileId) : undefined;
    if (!current) throw new Error(`There's no cloud copy of ${file.relPath} yet.`);
    return { file, current, keys };
  }

  //Local Changes
  onLocalChange(uri: vscode.Uri): void {
    if (this.session.state !== "unlocked") return;
    if (!this.fileFor(uri)) {
      this.scheduleRefresh();
      return;
    }
    this.schedule(uri, PUSH_DELAY);
  }

  private schedule(uri: vscode.Uri, delay: number): void {
    const key = uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.autoPush(uri);
      }, delay),
    );
  }

  private async autoPush(uri: vscode.Uri): Promise<void> {
    const file = this.fileFor(uri);
    if (!file) return;
    if (settings().autoPush && file.tracked && file.exists) {
      await this.push(uri, { quiet: true });
      return;
    }
    const content = await readLocal(uri);
    file.localHash = content ? sha256Hex(content) : undefined;
    this.fire();
  }

  async setTracked(entries: [vscode.Uri, boolean][]): Promise<void> {
    const untracked = new Set(this.ctx.workspaceState.get<string[]>(STATE_UNTRACKED, []));
    for (const [uri, tracked] of entries) {
      if (tracked) untracked.delete(uri.toString());
      else untracked.add(uri.toString());
    }
    await this.ctx.workspaceState.update(STATE_UNTRACKED, [...untracked]);
    await this.refresh();
  }

  async fixGitignore(uri: vscode.Uri): Promise<void> {
    const file = this.fileFor(uri);
    if (!file) return;
    await addToGitignore(file.folder, file.relPath);
    file.gitIgnored = undefined;
    await this.checkGitignore();
  }

  private async checkGitignore(): Promise<void> {
    let changed = false;
    for (const file of this.files) {
      if (!file.exists || file.gitIgnored !== undefined) continue;
      file.gitIgnored = await isGitIgnored(file.folder, file.uri);
      changed = true;
    }
    if (changed) this.fire();
  }

  //Remote Changes
  private async handleRemoteChanges(): Promise<void> {
    const fresh = this.files.filter(
      (file) => (file.status === "remoteNewer" || file.status === "missingLocal") && !this.notifiedRemote.has(`${file.key}@${file.remote?.rev}`),
    );
    if (!fresh.length) return;
    for (const file of fresh) this.notifiedRemote.add(`${file.key}@${file.remote?.rev}`);
    const mode = settings().autoPull;
    if (mode === "off") return;
    let waiting = fresh;
    if (mode === "whenSafe") {
      const safe = fresh.filter((file) => file.status === "remoteNewer");
      for (const file of safe) await this.pull(file.uri, { quiet: true });
      if (safe.length) vscode.window.setStatusBarMessage(`$(cloud-download) Hush pulled ${plural(safe.length, "file")}`, 4000);
      waiting = fresh.filter((file) => this.fileFor(file.uri)?.status !== "synced");
    }
    if (!waiting.length) return;
    const count = waiting.length;
    const choice = await vscode.window.showInformationMessage(
      `${plural(count, ".env file")} ${count === 1 ? "has" : "have"} updates in Google Drive.`,
      "Pull all",
      "Review",
    );
    if (choice === "Pull all") await vscode.commands.executeCommand("hush.project.pullAll");
    if (choice === "Review") await vscode.commands.executeCommand("workbench.view.extension.hush");
  }

  private raiseConflict(file: EnvFile): void {
    if (this.notifiedConflicts.has(file.key)) return;
    this.notifiedConflicts.add(file.key);
    void vscode.window
      .showWarningMessage(`${file.relPath} changed on this device and in the cloud. Auto-backup is paused for this file.`, "Compare", "Keep this device", "Use cloud")
      .then((choice) => {
        if (choice === "Compare") return vscode.commands.executeCommand("hush.file.compare", file.uri);
        if (choice === "Keep this device") return vscode.commands.executeCommand("hush.conflict.keepLocal", file.uri);
        if (choice === "Use cloud") return vscode.commands.executeCommand("hush.conflict.useCloud", file.uri);
        return undefined;
      });
  }

  //State
  private records(): Record<string, SyncRecord> {
    return this.ctx.workspaceState.get<Record<string, SyncRecord>>(STATE_RECORDS, {});
  }

  async clearRecords(): Promise<void> {
    this.checkedRevs.clear();
    this.pathCache.clear();
    this.infoCache.clear();
    await this.ctx.workspaceState.update(STATE_RECORDS, undefined);
  }

  private async markSynced(file: EnvFile, localHash: string, remote: RemoteFile): Promise<void> {
    file.remote = remote;
    this.errors.delete(file.key);
    this.retries.delete(file.key);
    this.notifiedConflicts.delete(file.key);
    const records = { ...this.records(), [file.key]: { localHash, rev: remote.rev, driveId: remote.driveId, syncedAt: new Date().toISOString() } };
    await this.ctx.workspaceState.update(STATE_RECORDS, records);
  }

  private statusOf(file: EnvFile, record?: SyncRecord): FileStatus {
    const busy = this.busy.get(file.key);
    if (busy) return busy;
    if (!file.exists) return "missingLocal";
    if (!file.tracked) return "untracked";
    if (this.errors.has(file.key)) return "error";
    if (!file.remote) return "pending";
    if (!record || record.driveId !== file.remote.driveId) return "conflict";
    const localMoved = file.localHash !== record.localHash;
    const remoteMoved = file.remote.rev !== record.rev;
    if (localMoved && remoteMoved) return "conflict";
    if (localMoved) return "pending";
    if (remoteMoved) return "remoteNewer";
    return "synced";
  }

  private fire(): void {
    const records = this.records();
    for (const file of this.files) {
      const record = records[file.key];
      file.syncedAt = record?.syncedAt;
      file.error = this.errors.get(file.key);
      file.status = this.statusOf(file, record);
    }
    void vscode.commands.executeCommand("setContext", "hush.hasFiles", this.files.length > 0);
    this.emitter.fire();
  }

  private setBusy(file: EnvFile, kind: "uploading" | "downloading"): void {
    this.busy.set(file.key, kind);
    this.fire();
  }

  private clearBusy(file: EnvFile): void {
    this.busy.delete(file.key);
    this.fire();
  }

  private projectOf(file: EnvFile): Project | undefined {
    return this.projects.find((project) => project.projectId === file.projectId && project.folder.uri.toString() === file.folder.uri.toString());
  }

  private requireKeys(): VaultKeys {
    if (!this.session.keys) throw new Error("Hush is locked. Unlock it to continue.");
    return this.session.keys;
  }

  //Errors
  private fail(file: EnvFile, error: unknown, op: "push" | "pull", quiet?: boolean): void {
    if (this.handleAccessError(error)) return;
    const message = errorMessage(error);
    this.log.error(`${op === "push" ? "Upload" : "Download"} failed for ${file.relPath}: ${message}`);
    if (error instanceof NetworkError && op === "push") {
      const attempt = (this.retries.get(file.key) ?? 0) + 1;
      this.retries.set(file.key, attempt);
      this.schedule(file.uri, RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length) - 1] * 1000);
      if (!quiet) void vscode.window.showWarningMessage(`You're offline. Hush will upload ${file.relPath} when the connection is back.`);
      return;
    }
    this.errors.set(file.key, message);
    if (!quiet) void vscode.window.showErrorMessage(`Hush couldn't ${op === "push" ? "back up" : "pull"} ${file.relPath}. ${message}`);
  }

  private handleAccessError(error: unknown): boolean {
    if (!(error instanceof AuthError)) return false;
    void this.session.lostAccess(error.message);
    return true;
  }
}

function inFolder(file: EnvFile, folder?: vscode.WorkspaceFolder): boolean {
  return !folder || file.folder.uri.toString() === folder.uri.toString();
}

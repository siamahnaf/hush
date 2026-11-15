import { VaultFile } from "../crypto/vault";
import { DriveClient, DriveFile, DriveRevision } from "./client";

const ROLE = "hushRole";
const APP_DATA = "appDataFolder";

export interface RemoteFile {
  driveId: string;
  fileId: string;
  rev: string;
  modifiedTime: string;
  size: number;
}

export interface RemoteProject {
  projectId: string;
  folderId: string;
}

//Layout: hidden appDataFolder/ vault.json + p_<projectId>/ (project.hush, f_<fileId>.hush)
export class HushStore {
  private readonly projectFolders = new Map<string, string>();

  constructor(readonly drive: DriveClient) {}

  reset(): void {
    this.projectFolders.clear();
  }

  //Vault
  async readVault(): Promise<{ driveId: string; vault: VaultFile } | undefined> {
    const file = (await this.drive.list(`${prop(ROLE, "vault")} and '${APP_DATA}' in parents and trashed=false`))[0];
    if (!file) return undefined;
    const data = await this.drive.download(file.id);
    return { driveId: file.id, vault: JSON.parse(data.toString("utf8")) as VaultFile };
  }

  async writeVault(vault: VaultFile, driveId?: string): Promise<void> {
    const data = Buffer.from(JSON.stringify(vault, null, 2), "utf8");
    if (driveId) {
      await this.drive.updateFile(driveId, data);
      return;
    }
    await this.drive.createFile("vault.json", APP_DATA, { [ROLE]: "vault" }, data, "application/json");
  }

  //Projects
  async findProjectFolder(projectId: string): Promise<string | undefined> {
    const cached = this.projectFolders.get(projectId);
    if (cached) return cached;
    const found = (await this.drive.list(`${prop(ROLE, "project")} and ${prop("hushProject", projectId)} and trashed=false`))[0];
    if (found) this.projectFolders.set(projectId, found.id);
    return found?.id;
  }

  async ensureProjectFolder(projectId: string): Promise<string> {
    const existing = await this.findProjectFolder(projectId);
    if (existing) return existing;
    const folder = await this.drive.createFolder(`p_${projectId}`, APP_DATA, { [ROLE]: "project", hushProject: projectId });
    this.projectFolders.set(projectId, folder.id);
    return folder.id;
  }

  async listProjects(): Promise<RemoteProject[]> {
    const folders = await this.drive.list(`${prop(ROLE, "project")} and trashed=false`);
    const projects: RemoteProject[] = [];
    for (const folder of folders) {
      const projectId = folder.appProperties?.hushProject;
      if (!projectId) continue;
      this.projectFolders.set(projectId, folder.id);
      projects.push({ projectId, folderId: folder.id });
    }
    return projects;
  }

  listChildren(folderId: string): Promise<DriveFile[]> {
    return this.drive.list(`'${folderId}' in parents and trashed=false`);
  }

  async findInfo(folderId: string): Promise<DriveFile | undefined> {
    return (await this.drive.list(`'${folderId}' in parents and ${prop(ROLE, "info")} and trashed=false`))[0];
  }

  async writeInfo(folderId: string, blob: Buffer): Promise<void> {
    await this.drive.createFile("project.hush", folderId, { [ROLE]: "info" }, blob);
  }

  //Files
  async listFiles(folderId: string): Promise<RemoteFile[]> {
    const files = await this.drive.list(`'${folderId}' in parents and ${prop(ROLE, "file")} and trashed=false`);
    return files.flatMap((file) => {
      const remote = toRemote(file);
      return remote ? [remote] : [];
    });
  }

  async findFile(folderId: string, fileId: string): Promise<RemoteFile | undefined> {
    const file = (await this.drive.list(`'${folderId}' in parents and ${prop("hushFile", fileId)} and trashed=false`))[0];
    return file ? toRemote(file, fileId) : undefined;
  }

  async uploadFile(folderId: string, fileId: string, blob: Buffer, driveId?: string): Promise<RemoteFile> {
    const file = driveId
      ? await this.drive.updateFile(driveId, blob)
      : await this.drive.createFile(`f_${fileId}.hush`, folderId, { [ROLE]: "file", hushFile: fileId }, blob);
    return toRemote(file, fileId)!;
  }

  download(driveId: string): Promise<Buffer> {
    return this.drive.download(driveId);
  }

  async update(driveId: string, blob: Buffer): Promise<void> {
    await this.drive.updateFile(driveId, blob);
  }

  deleteFile(driveId: string): Promise<void> {
    return this.drive.delete(driveId);
  }

  //Revisions
  async revisions(driveId: string): Promise<DriveRevision[]> {
    const revisions = await this.drive.revisions(driveId);
    return revisions.sort((a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime));
  }

  downloadRevision(driveId: string, revisionId: string): Promise<Buffer> {
    return this.drive.downloadRevision(driveId, revisionId);
  }

  keepRevision(driveId: string, revisionId: string): Promise<void> {
    return this.drive.keepRevision(driveId, revisionId);
  }

  async pruneRevisions(driveId: string): Promise<void> {
    const [, ...older] = await this.revisions(driveId);
    for (const revision of older) {
      await this.drive.deleteRevision(driveId, revision.id).catch(() => undefined);
    }
  }

  //Summary
  async summary(): Promise<{ projects: number; files: number }> {
    const [projects, files] = await Promise.all([
      this.drive.list(`${prop(ROLE, "project")} and trashed=false`),
      this.drive.list(`${prop(ROLE, "file")} and trashed=false`),
    ]);
    return { projects: projects.length, files: files.length };
  }

  async deleteEverything(): Promise<void> {
    for (const file of await this.listChildren(APP_DATA)) await this.drive.delete(file.id);
    this.reset();
  }
}

function prop(key: string, value: string): string {
  return `appProperties has { key='${key}' and value='${value}' }`;
}

function toRemote(file: DriveFile, fileId = file.appProperties?.hushFile): RemoteFile | undefined {
  if (!fileId) return undefined;
  return {
    driveId: file.id,
    fileId,
    rev: file.md5Checksum ?? file.version ?? "",
    modifiedTime: file.modifiedTime ?? "",
    size: Number(file.size ?? 0),
  };
}

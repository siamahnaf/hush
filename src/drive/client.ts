import { randomBytes } from "node:crypto";
import { AuthError, GoogleAuth, LOST_ACCESS, NetworkError } from "./oauth";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,version,modifiedTime,size,md5Checksum,appProperties";
const MAX_RETRIES = 3;

export interface DriveFile {
  id: string;
  name: string;
  version?: string;
  modifiedTime?: string;
  size?: string;
  md5Checksum?: string;
  appProperties?: Record<string, string>;
}

export interface DriveRevision {
  id: string;
  modifiedTime: string;
  size?: string;
  keepForever?: boolean;
}

export class DriveError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "DriveError";
  }
}

interface SendOptions {
  query?: Record<string, string>;
  body?: Buffer;
  contentType?: string;
}

export class DriveClient {
  constructor(private readonly auth: GoogleAuth) {}

  async list(q: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = { q, fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: "1000", spaces: "appDataFolder" };
      if (pageToken) query.pageToken = pageToken;
      const page = await this.json<{ files?: DriveFile[]; nextPageToken?: string }>("GET", `${API}/files`, { query });
      files.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  createFolder(name: string, parent: string | undefined, appProperties: Record<string, string>): Promise<DriveFile> {
    return this.json<DriveFile>("POST", `${API}/files`, {
      query: { fields: FILE_FIELDS },
      body: jsonBody({ name, mimeType: FOLDER_MIME, parents: parent ? [parent] : undefined, appProperties }),
      contentType: "application/json",
    });
  }

  async createFile(name: string, parent: string, appProperties: Record<string, string>, data: Buffer, mimeType = "application/octet-stream"): Promise<DriveFile> {
    const boundary = `hush${randomBytes(12).toString("hex")}`;
    const meta = JSON.stringify({ name, parents: [parent], appProperties, mimeType });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const res = await this.send("POST", `${UPLOAD}/files`, {
      query: { uploadType: "multipart", fields: FILE_FIELDS },
      body,
      contentType: `multipart/related; boundary=${boundary}`,
    });
    return (await res.json()) as DriveFile;
  }

  async updateFile(id: string, data: Buffer): Promise<DriveFile> {
    const res = await this.send("PATCH", `${UPLOAD}/files/${id}`, {
      query: { uploadType: "media", fields: FILE_FIELDS },
      body: data,
      contentType: "application/octet-stream",
    });
    return (await res.json()) as DriveFile;
  }

  async download(id: string): Promise<Buffer> {
    const res = await this.send("GET", `${API}/files/${id}`, { query: { alt: "media" } });
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(id: string): Promise<void> {
    await this.send("DELETE", `${API}/files/${id}`);
  }

  //Revisions
  async revisions(id: string): Promise<DriveRevision[]> {
    const res = await this.json<{ revisions?: DriveRevision[] }>("GET", `${API}/files/${id}/revisions`, {
      query: { fields: "revisions(id,modifiedTime,size,keepForever)", pageSize: "200" },
    });
    return res.revisions ?? [];
  }

  async downloadRevision(id: string, revisionId: string): Promise<Buffer> {
    const res = await this.send("GET", `${API}/files/${id}/revisions/${revisionId}`, { query: { alt: "media" } });
    return Buffer.from(await res.arrayBuffer());
  }

  async keepRevision(id: string, revisionId: string): Promise<void> {
    await this.send("PATCH", `${API}/files/${id}/revisions/${revisionId}`, {
      query: { fields: "id" },
      body: jsonBody({ keepForever: true }),
      contentType: "application/json",
    });
  }

  async deleteRevision(id: string, revisionId: string): Promise<void> {
    await this.send("DELETE", `${API}/files/${id}/revisions/${revisionId}`);
  }

  //Transport
  private async json<T>(method: string, url: string, options: SendOptions = {}): Promise<T> {
    const res = await this.send(method, url, options);
    return (await res.json()) as T;
  }

  private async send(method: string, url: string, options: SendOptions = {}, attempt = 0, retriedAuth = false): Promise<Response> {
    const token = await this.auth.accessToken();
    const target = options.query ? `${url}?${encodeQuery(options.query)}` : url;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (options.contentType) headers["Content-Type"] = options.contentType;
    let res: Response;
    try {
      res = await fetch(target, { method, headers, body: options.body ? new Uint8Array(options.body) : undefined });
    } catch {
      throw new NetworkError("Can't reach Google Drive. Check your connection.");
    }
    if (res.status === 401) {
      this.auth.invalidate();
      if (!retriedAuth) return this.send(method, url, options, attempt, true);
      throw new AuthError(LOST_ACCESS);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(500 * 2 ** attempt);
      return this.send(method, url, options, attempt + 1, retriedAuth);
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new DriveError(data.error?.message ?? `Google Drive returned ${res.status}.`, res.status);
    }
    return res;
  }
}

function jsonBody(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function encodeQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

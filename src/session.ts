import * as vscode from "vscode";
import { SECRET_VAULT, STATE_EMAIL } from "./constants";
import { decryptAny, encrypt } from "./crypto/blob";
import { fileAad, infoAad } from "./crypto/envelope";
import {
  candidateKeys,
  createVault,
  parseKeys,
  rewrapVault,
  rotateKeys,
  serializeKeys,
  unlockVault,
  VaultFile,
  VaultKeys,
  withoutPrevious,
  wrapVault,
} from "./crypto/vault";
import { AuthError, GoogleAuth } from "./drive/oauth";
import { HushStore } from "./drive/store";
import { errorMessage } from "./util";

export type VaultState = "disconnected" | "noVault" | "locked" | "unlocked";

export class Session implements vscode.Disposable {
  state: VaultState = "disconnected";
  keys?: VaultKeys;
  private readonly emitter = new vscode.EventEmitter<VaultState>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    readonly auth: GoogleAuth,
    readonly store: HushStore,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  dispose(): void {
    this.emitter.dispose();
  }

  get email(): string | undefined {
    return this.ctx.globalState.get<string>(STATE_EMAIL);
  }

  //Startup
  async init(): Promise<void> {
    if (!(await this.auth.isConnected())) {
      this.set("disconnected");
      return;
    }
    const saved = await this.loadKeys();
    if (saved) {
      this.keys = saved;
      this.set("unlocked");
      return;
    }
    try {
      this.set((await this.store.readVault()) ? "locked" : "noVault");
    } catch (error) {
      if (error instanceof AuthError) {
        await this.lostAccess(error.message);
        return;
      }
      this.log.warn(`Couldn't read the vault: ${errorMessage(error)}`);
      this.set("locked");
    }
  }

  async verify(): Promise<void> {
    if (this.state !== "unlocked" || !this.keys) return;
    try {
      const remote = await this.store.readVault();
      if (!remote) {
        await this.forgetKeys();
        this.set("noVault");
        void vscode.window
          .showWarningMessage("Your Hush vault was deleted from Google Drive. Create a new passphrase to keep backing up.", "Set up")
          .then((choice) => choice && vscode.commands.executeCommand("hush.setup"));
        return;
      }
      if (remote.vault.keyId !== this.keys.keyId) {
        await this.forgetKeys();
        this.set("locked");
        void vscode.window
          .showWarningMessage("Your vault key changed on another computer. Enter your passphrase to unlock Hush here.", "Unlock")
          .then((choice) => choice && vscode.commands.executeCommand("hush.unlock"));
      }
    } catch (error) {
      if (error instanceof AuthError) await this.lostAccess(error.message);
      else this.log.warn(`Couldn't check the vault: ${errorMessage(error)}`);
    }
  }

  //Connect
  async connect(cancel: vscode.CancellationToken): Promise<void> {
    const { email } = await this.auth.signIn(cancel);
    await this.ctx.globalState.update(STATE_EMAIL, email);
    this.store.reset();
    const remote = await this.store.readVault();
    if (!remote) {
      await this.forgetKeys();
      this.set("noVault");
      return;
    }
    const saved = await this.loadKeys();
    if (saved && saved.keyId === remote.vault.keyId) {
      this.keys = saved;
      this.set("unlocked");
      return;
    }
    await this.forgetKeys();
    this.set("locked");
  }

  async lostAccess(message: string): Promise<void> {
    if (this.state === "disconnected") return;
    this.set("disconnected");
    await this.auth.forget();
    this.store.reset();
    const choice = await vscode.window.showErrorMessage(message, "Reconnect");
    if (choice) await vscode.commands.executeCommand("hush.setup");
  }

  //Vault
  async create(passphrase: string): Promise<void> {
    if (await this.store.readVault()) {
      this.set("locked");
      throw new Error("This Google Drive already has a Hush vault. Unlock it with your passphrase.");
    }
    const { file, keys } = await createVault(passphrase);
    await this.store.writeVault(file);
    await this.saveKeys(keys);
  }

  async unlock(passphrase: string): Promise<void> {
    const remote = await this.requireVault();
    await this.saveKeys(await unlockVault(remote.vault, passphrase));
  }

  async changePassphrase(current: string, next: string): Promise<void> {
    const remote = await this.requireVault();
    const keys = await unlockVault(remote.vault, current);
    await this.store.writeVault(await rewrapVault(remote.vault, keys, next), remote.driveId);
  }

  async rotate(passphrase: string, report: (message: string) => void): Promise<void> {
    const remote = await this.requireVault();
    const current = await unlockVault(remote.vault, passphrase);
    const next = current.previousMaterial ? current : rotateKeys(current);
    const readable = candidateKeys(current);
    await this.store.writeVault(await wrapVault(next, passphrase, remote.vault.createdAt), remote.driveId);
    await this.saveKeys(next);
    let done = 0;
    for (const project of await this.store.listProjects()) {
      for (const child of await this.store.listChildren(project.folderId)) {
        const role = child.appProperties?.hushRole;
        const fileId = child.appProperties?.hushFile;
        const aad = role === "file" && fileId ? fileAad(project.projectId, fileId) : role === "info" ? infoAad(project.projectId) : undefined;
        if (!aad) continue;
        const plain = decryptAny(readable, await this.store.download(child.id), aad);
        await this.store.update(child.id, encrypt(next.encKey, plain, aad));
        await this.store.pruneRevisions(child.id);
        report(`${++done} files re-encrypted`);
      }
    }
    const final = withoutPrevious(next);
    await this.store.writeVault(await wrapVault(final, passphrase, remote.vault.createdAt), remote.driveId);
    await this.saveKeys(final);
  }

  async lock(): Promise<void> {
    await this.forgetKeys();
    this.set("locked");
  }

  async disconnect(): Promise<void> {
    await this.auth.signOut();
    await this.forgetKeys();
    await this.ctx.globalState.update(STATE_EMAIL, undefined);
    this.store.reset();
    this.set("disconnected");
  }

  async reset(): Promise<void> {
    await this.store.deleteEverything();
    await this.forgetKeys();
    this.set((await this.auth.isConnected()) ? "noVault" : "disconnected");
  }

  //Keys
  private async requireVault(): Promise<{ driveId: string; vault: VaultFile }> {
    const remote = await this.store.readVault();
    if (remote) return remote;
    this.set("noVault");
    throw new Error("No Hush vault was found in this Google Drive. Create a passphrase to start one.");
  }

  private async loadKeys(): Promise<VaultKeys | undefined> {
    const raw = await this.ctx.secrets.get(SECRET_VAULT);
    return raw ? parseKeys(raw) : undefined;
  }

  private async saveKeys(keys: VaultKeys): Promise<void> {
    await this.ctx.secrets.store(SECRET_VAULT, serializeKeys(keys));
    this.keys = keys;
    this.set("unlocked");
  }

  private async forgetKeys(): Promise<void> {
    this.keys = undefined;
    await this.ctx.secrets.delete(SECRET_VAULT);
  }

  private set(state: VaultState): void {
    const changed = this.state !== state;
    this.state = state;
    void vscode.commands.executeCommand("setContext", "hush.state", state);
    if (changed || state === "unlocked") this.emitter.fire(state);
  }
}

import * as vscode from "vscode";
import { SCHEME } from "./constants";
import { Session } from "./session";
import { BatchResult, CloudProject, EnvFile, Project, SyncEngine } from "./sync/engine";
import { showFileMenu } from "./ui/actions";
import { ENV_EDITOR } from "./ui/envEditor";
import { closeCompare, compare, parseCloudUri } from "./ui/conflict";
import { showHistory } from "./ui/history";
import { MIN_PASSPHRASE, SetupPanel } from "./ui/setupPanel";
import { errorMessage, plural } from "./util";

const MENU_VARIANTS = ["synced", "pending", "busy", "remote", "conflict", "error", "none", "setup"];
const RESET_PHRASE = "delete my backups";

export function registerCommands(ctx: vscode.ExtensionContext, session: Session, engine: SyncEngine, log: vscode.LogOutputChannel): void {
  const register = (id: string, run: (arg?: unknown) => unknown) => {
    ctx.subscriptions.push(
      vscode.commands.registerCommand(id, async (arg?: unknown) => {
        try {
          await run(arg);
        } catch (error) {
          if (error instanceof vscode.CancellationError) return;
          log.error(`${id}: ${errorMessage(error)}`);
          void vscode.window.showErrorMessage(errorMessage(error));
        }
      }),
    );
  };
  const setup = () => SetupPanel.show(ctx, session, engine);

  //General
  register("hush.setup", setup);
  register("hush.unlock", setup);
  register("hush.refresh", () => engine.checkRemote());
  register("hush.learnMore", () => vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.joinPath(ctx.extensionUri, "README.md")));
  register("hush.openEditor", (arg) => {
    const uri = targetUri(arg);
    return uri && vscode.commands.executeCommand("vscode.openWith", uri, ENV_EDITOR);
  });
  register("hush.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${ctx.extension.id}`));

  //File
  const menu = (arg?: unknown) => showFileMenu(engine, session, targetUri(arg));
  register("hush.file.menu", menu);
  for (const variant of MENU_VARIANTS) register(`hush.file.menu.${variant}`, menu);

  register("hush.file.push", async (arg) => {
    let file = requireFile(engine, arg);
    if (!file.tracked) {
      await engine.setTracked([[file.uri, true]]);
      file = requireFile(engine, file.uri);
    }
    if (await engine.push(file.uri)) {
      vscode.window.setStatusBarMessage(`$(check) Backed up ${file.relPath}`, 3000);
      return;
    }
    if (engine.fileFor(file.uri)?.status === "remoteNewer") {
      const choice = await vscode.window.showInformationMessage(`A newer version of ${file.relPath} is in the cloud. Pull it before pushing.`, "Pull", "Compare");
      if (choice === "Pull") await vscode.commands.executeCommand("hush.file.pull", file.uri);
      if (choice === "Compare") await vscode.commands.executeCommand("hush.file.compare", file.uri);
    }
  });

  const pull = async (arg?: unknown) => {
    const file = requireFile(engine, arg);
    if (await engine.pull(file.uri)) vscode.window.setStatusBarMessage(`$(cloud-download) Pulled ${file.relPath}`, 3000);
  };
  register("hush.file.pull", pull);
  register("hush.file.restore", pull);
  register("hush.file.compare", (arg) => compare(requireFile(engine, arg)));
  register("hush.file.history", (arg) => showHistory(engine, requireFile(engine, arg)));
  register("hush.file.track", (arg) => engine.setTracked([[requireFile(engine, arg).uri, true]]));
  register("hush.file.untrack", (arg) => engine.setTracked([[requireFile(engine, arg).uri, false]]));
  register("hush.gitignore.add", (arg) => engine.fixGitignore(requireFile(engine, arg).uri));

  //Conflicts
  register("hush.conflict.keepLocal", async (arg) => {
    const file = requireFile(engine, arg);
    if (!(await engine.push(file.uri, { force: true }))) return;
    await closeCompare(file.uri);
    vscode.window.setStatusBarMessage(`$(check) Kept this device's ${file.relPath}`, 4000);
  });
  register("hush.conflict.useCloud", async (arg) => {
    const file = requireFile(engine, arg);
    if (!(await engine.pull(file.uri, { force: true }))) return;
    await closeCompare(file.uri);
    vscode.window.setStatusBarMessage(`$(cloud-download) Replaced ${file.relPath} with the cloud version`, 4000);
  });

  //Project
  register("hush.project.pushAll", async (arg) => {
    const result = await progress("Backing up", (report) => engine.pushAll(folderFromArg(arg), report));
    await showBatch(result, "push");
  });
  register("hush.project.pullAll", async (arg) => {
    const result = await progress("Pulling", (report) => engine.pullAll(folderFromArg(arg), report));
    await showBatch(result, "pull");
  });

  register("hush.cloud.restore", async (arg) => {
    const cloud = (arg as { cloud?: CloudProject } | undefined)?.cloud;
    if (!cloud) return;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const items: (vscode.QuickPickItem & { uri?: vscode.Uri })[] = [
      ...folders.map((folder) => ({ label: `$(root-folder) ${folder.name}`, description: "Workspace folder", uri: folder.uri })),
      { label: "$(folder-opened) Choose another folder…" },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `Restore ${cloud.name}`, placeHolder: "Where should Hush restore these files?" });
    if (!pick) return;
    const target = pick.uri ?? (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: "Restore here" }))?.[0];
    if (!target) return;
    const written = await progress(`Restoring ${cloud.name}`, () =>
      engine.restoreInto(cloud, target, async (paths) => {
        const choice = await vscode.window.showWarningMessage(
          `${plural(paths.length, "file")} already exist with different content.`,
          { modal: true, detail: `${paths.join("\n")}\n\nOverwrite them with the cloud versions?` },
          "Overwrite",
        );
        return choice === "Overwrite";
      }),
    );
    const inWorkspace = folders.some((folder) => folder.uri.toString() === target.toString());
    const choice = await vscode.window.showInformationMessage(`Restored ${plural(written, "file")} from ${cloud.name}.`, ...(inWorkspace ? [] : ["Open folder"]));
    if (choice === "Open folder") await vscode.commands.executeCommand("vscode.openFolder", target, { forceNewWindow: true });
  });

  //Vault
  register("hush.vault.lock", async () => {
    await session.lock();
    void vscode.window.showInformationMessage("Hush is locked on this computer. Enter your passphrase to unlock it again.");
  });

  register("hush.vault.changePassphrase", async () => {
    const current = await askPassphrase("Change passphrase (1/3)", "Enter your current passphrase");
    if (!current) return;
    const next = await askPassphrase("Change passphrase (2/3)", `Enter a new passphrase (at least ${MIN_PASSPHRASE} characters)`, (value) =>
      value.length >= MIN_PASSPHRASE ? undefined : `Use at least ${MIN_PASSPHRASE} characters.`,
    );
    if (!next) return;
    const confirm = await askPassphrase("Change passphrase (3/3)", "Enter the new passphrase again", (value) => (value === next ? undefined : "Passphrases don't match."));
    if (confirm !== next) return;
    const saved = await vscode.window.showWarningMessage(
      "Save your new passphrase before continuing.",
      { modal: true, detail: "Hush can't recover a lost passphrase. If you lose it, nobody can open your backups, including you." },
      "I've saved it",
    );
    if (!saved) return;
    await progress("Changing passphrase", () => session.changePassphrase(current, next));
    void vscode.window.showInformationMessage("Passphrase changed. Your other computers keep working without entering it again.");
  });

  register("hush.vault.rotateKey", async () => {
    const confirmed = await vscode.window.showWarningMessage(
      "Rotate your vault key?",
      {
        modal: true,
        detail:
          "Hush creates a new vault key and re-encrypts every backup in Google Drive. Your other computers will need your passphrase to unlock again, and older versions in history are deleted. Use this if a computer with Hush was lost or stolen.",
      },
      "Rotate key",
    );
    if (!confirmed) return;
    const passphrase = await askPassphrase("Rotate vault key", "Enter your passphrase");
    if (!passphrase) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Hush: Rotating vault key" }, (report) =>
      session.rotate(passphrase, (message) => report.report({ message })),
    );
    await engine.refresh();
    void vscode.window.showInformationMessage("Vault key rotated. Other computers need your passphrase to unlock Hush again.");
  });

  //Account
  register("hush.account.disconnect", async () => {
    const confirmed = await vscode.window.showWarningMessage(
      "Disconnect Google Drive?",
      {
        modal: true,
        detail: "Hush stops backing up on this computer and removes its Google token and vault key from your keychain. Your backups stay in Google Drive.",
      },
      "Disconnect",
    );
    if (!confirmed) return;
    await session.disconnect();
  });

  register("hush.account.resetVault", async () => {
    const confirmed = await vscode.window.showWarningMessage(
      "Delete your Hush vault?",
      { modal: true, detail: "This permanently deletes every Hush backup from your Google Drive, for all computers. Your local .env files are not touched." },
      "Continue",
    );
    if (!confirmed) return;
    const typed = await vscode.window.showInputBox({
      title: "Delete vault",
      prompt: `Type "${RESET_PHRASE}" to confirm`,
      ignoreFocusOut: true,
      validateInput: (value) => (value === RESET_PHRASE ? undefined : `Type "${RESET_PHRASE}" exactly.`),
    });
    if (typed !== RESET_PHRASE) return;
    await progress("Deleting vault", () => session.reset());
    await engine.clearRecords();
    await engine.refresh();
    const choice = await vscode.window.showInformationMessage("Your Hush vault was deleted. Create a new passphrase to start backing up again.", "Set up");
    if (choice) setup();
  });
}

//Helpers
function targetUri(arg: unknown): vscode.Uri | undefined {
  const uri = arg instanceof vscode.Uri ? arg : (arg as { file?: EnvFile } | undefined)?.file?.uri ?? vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === SCHEME ? parseCloudUri(uri).local : uri;
}

function requireFile(engine: SyncEngine, arg: unknown): EnvFile {
  const file = engine.fileFor(targetUri(arg));
  if (!file) throw new Error("Hush isn't backing up this file. Check the hush.include and hush.exclude settings.");
  return file;
}

function folderFromArg(arg: unknown): vscode.WorkspaceFolder | undefined {
  return (arg as { project?: Project } | undefined)?.project?.folder;
}

function askPassphrase(title: string, prompt: string, validateInput?: (value: string) => string | undefined): Thenable<string | undefined> {
  return vscode.window.showInputBox({ title, prompt, password: true, ignoreFocusOut: true, validateInput });
}

function progress<T>(title: string, task: (report: (done: number, total: number) => void) => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Hush: ${title}` }, (bar) =>
    task((done, total) => bar.report({ message: `${done + 1} of ${total}`, increment: 100 / total })),
  );
}

async function showBatch(result: BatchResult, kind: "push" | "pull"): Promise<void> {
  if (!result.total && !result.conflicts) {
    void vscode.window.showInformationMessage(kind === "push" ? "Everything is already backed up." : "Everything is up to date.");
    return;
  }
  const parts: string[] = [];
  if (result.done) parts.push(`${kind === "push" ? "Backed up" : "Pulled"} ${plural(result.done, "file")}.`);
  if (result.conflicts) parts.push(`${plural(result.conflicts, "file")} changed here and in the cloud.`);
  if (result.failed) parts.push(`${result.failed} failed. See the Hush output for details.`);
  const message = parts.join(" ");
  if (!result.conflicts && !result.failed) {
    vscode.window.setStatusBarMessage(`$(check) ${message}`, 4000);
    return;
  }
  const choice = await vscode.window.showWarningMessage(message, "Open Hush");
  if (choice) await vscode.commands.executeCommand("workbench.view.extension.hush");
}

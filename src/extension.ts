import * as vscode from "vscode";
import { registerCommands } from "./commands";
import { ENV_GLOB, SCHEME, STATE_ONBOARDED } from "./constants";
import { DriveClient } from "./drive/client";
import { GoogleAuth } from "./drive/oauth";
import { HushStore } from "./drive/store";
import { Session } from "./session";
import { isEnvName } from "./sync/discovery";
import { SyncEngine } from "./sync/engine";
import { HushCodeLens } from "./ui/codelens";
import { CloudContentProvider } from "./ui/conflict";
import { HushDecorations } from "./ui/decorations";
import { EnvEditorProvider } from "./ui/envEditor";
import { SetupPanel } from "./ui/setupPanel";
import { HushStatusBar } from "./ui/statusbar";
import { registerTrees } from "./ui/tree";
import { basename } from "./util";

const REMOTE_CHECK_INTERVAL = 10 * 60_000;
const FOCUS_CHECK_GAP = 2 * 60_000;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel("Hush", { log: true });
  const auth = new GoogleAuth(ctx.secrets);
  const store = new HushStore(new DriveClient(auth));
  const session = new Session(ctx, auth, store, log);
  const engine = new SyncEngine(ctx, session, log);
  ctx.subscriptions.push(log, session, engine);

  //Interface
  registerCommands(ctx, session, engine, log);
  ctx.subscriptions.push(
    vscode.window.registerFileDecorationProvider(new HushDecorations(engine)),
    vscode.languages.registerCodeLensProvider({ pattern: ENV_GLOB }, new HushCodeLens(engine, session)),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new CloudContentProvider(engine)),
    new HushStatusBar(engine, session),
    EnvEditorProvider.register(ctx, engine, session),
    ...registerTrees(engine, session),
  );

  //Editor Context
  const updateEditorContext = () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const isEnv = !!uri && uri.scheme !== SCHEME && isEnvName(basename(uri));
    void vscode.commands.executeCommand("setContext", "hush.isEnvFile", isEnv);
    void vscode.commands.executeCommand("setContext", "hush.activeFileStatus", isEnv ? (engine.fileFor(uri)?.status ?? "none") : "");
  };
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateEditorContext),
    engine.onDidChange(updateEditorContext),
    session.onDidChange(updateEditorContext),
  );

  //Watchers
  const watcher = vscode.workspace.createFileSystemWatcher(ENV_GLOB);
  ctx.subscriptions.push(
    watcher,
    watcher.onDidChange((uri) => engine.onLocalChange(uri)),
    watcher.onDidCreate(() => engine.scheduleRefresh()),
    watcher.onDidDelete(() => engine.scheduleRefresh()),
    vscode.workspace.onDidSaveTextDocument((doc) => engine.onLocalChange(doc.uri)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void engine.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("hush")) void engine.refresh();
    }),
    session.onDidChange(() => void engine.refresh()),
  );

  //Remote Checks
  let lastCheck = 0;
  const check = () => {
    if (session.state !== "unlocked") return;
    lastCheck = Date.now();
    void engine.checkRemote();
  };
  const interval = setInterval(() => {
    if (vscode.window.state.focused) check();
  }, REMOTE_CHECK_INTERVAL);
  const ticker = setInterval(() => engine.touch(), 60_000);
  ctx.subscriptions.push(
    { dispose: () => clearInterval(interval) },
    { dispose: () => clearInterval(ticker) },
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && Date.now() - lastCheck > FOCUS_CHECK_GAP) check();
    }),
  );

  //Startup
  await session.init();
  updateEditorContext();
  check();

  if (!ctx.globalState.get<boolean>(STATE_ONBOARDED)) {
    await ctx.globalState.update(STATE_ONBOARDED, true);
    if (session.state !== "unlocked") SetupPanel.show(ctx, session, engine);
  }
}

export function deactivate(): void {}

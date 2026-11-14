import * as vscode from "vscode";

declare const __HUSH_CLIENT_ID__: string;
declare const __HUSH_CLIENT_SECRET__: string;

//Google
export const GOOGLE_CLIENT_ID = __HUSH_CLIENT_ID__;
export const GOOGLE_CLIENT_SECRET = __HUSH_CLIENT_SECRET__;
export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/drive.appdata", "openid", "email"];

//Settings
export type AutoPull = "ask" | "whenSafe" | "off";
export type BadgeMode = "all" | "attention" | "off";

export interface HushSettings {
  autoPush: boolean;
  autoPull: AutoPull;
  include: string[];
  exclude: string[];
  codeLens: boolean;
  explorerBadges: BadgeMode;
  statusBar: boolean;
}

export function settings(): HushSettings {
  const config = vscode.workspace.getConfiguration("hush");
  return {
    autoPush: config.get<boolean>("autoPush", true),
    autoPull: config.get<AutoPull>("autoPull", "ask"),
    include: config.get<string[]>("include", []),
    exclude: config.get<string[]>("exclude", []),
    codeLens: config.get<boolean>("codeLens", true),
    explorerBadges: config.get<BadgeMode>("explorerBadges", "all"),
    statusBar: config.get<boolean>("statusBar", true),
  };
}

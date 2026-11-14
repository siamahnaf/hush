import { createHash, randomBytes } from "node:crypto";
import * as http from "node:http";
import * as vscode from "vscode";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_SCOPES } from "../config";
import { SECRET_REFRESH } from "../constants";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SIGN_IN_TIMEOUT = 5 * 60_000;
export const LOST_ACCESS = "Hush lost access to Google Drive. Reconnect to keep backing up.";

export class GoogleAuth {
  private access?: { token: string; expiresAt: number };
  private refreshing?: Promise<string>;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async isConnected(): Promise<boolean> {
    return !!(await this.secrets.get(SECRET_REFRESH));
  }

  //Sign In
  async signIn(cancel: vscode.CancellationToken): Promise<{ email?: string }> {
    if (!GOOGLE_CLIENT_ID) throw new Error("This build of Hush has no Google client ID. Set HUSH_GOOGLE_CLIENT_ID and rebuild.");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(16).toString("base64url");
    const { code, redirectUri } = await this.waitForCode(state, challenge, cancel);
    const tokens = await this.tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) throw new AuthError("Google didn't return a refresh token. Try connecting again.");
    await this.secrets.store(SECRET_REFRESH, tokens.refresh_token);
    this.access = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in - 60) * 1000 };
    return { email: emailFromIdToken(tokens.id_token) };
  }

  private waitForCode(state: string, challenge: string, cancel: vscode.CancellationToken): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      let done = false;
      let redirectUri = "";
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const ok = !error && !!code && url.searchParams.get("state") === state;
        res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
        res.end(ok ? page("Hush is connected", "You can close this tab and return to VS Code.") : page("Connection failed", "Return to VS Code and try again."));
        if (ok && code) finish(undefined, code);
        else finish(new AuthError(error === "access_denied" ? "Google access was denied." : "Google sign-in failed. Try again."));
      });
      const timer = setTimeout(() => finish(new AuthError("Google sign-in timed out. Try again.")), SIGN_IN_TIMEOUT);
      const subscription = cancel.onCancellationRequested(() => finish(new vscode.CancellationError()));

      function finish(error?: Error, code?: string) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        subscription.dispose();
        server.close();
        if (code && !error) resolve({ code, redirectUri });
        else reject(error ?? new AuthError("Google sign-in failed. Try again."));
      }

      server.on("error", (error) => finish(error));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        redirectUri = `http://127.0.0.1:${port}/callback`;
        const query = encodeQuery({
          client_id: GOOGLE_CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: GOOGLE_SCOPES.join(" "),
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
          access_type: "offline",
          prompt: "consent",
        });
        void vscode.env.openExternal(vscode.Uri.parse(`${AUTH_URL}?${query}`));
      });
    });
  }

  //Tokens
  async accessToken(): Promise<string> {
    if (this.access && Date.now() < this.access.expiresAt) return this.access.token;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  invalidate(): void {
    this.access = undefined;
  }

  private async refresh(): Promise<string> {
    const refreshToken = await this.secrets.get(SECRET_REFRESH);
    if (!refreshToken) throw new AuthError(LOST_ACCESS);
    const tokens = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
    this.access = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in - 60) * 1000 };
    return tokens.access_token;
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    const body = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, ...params });
    let res: Response;
    try {
      res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    } catch {
      throw new NetworkError("Can't reach Google. Check your connection.");
    }
    const data = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok) {
      if (data.error === "invalid_grant") throw new AuthError(LOST_ACCESS);
      throw new Error(data.error_description ?? data.error ?? `Google returned ${res.status}.`);
    }
    return data;
  }

  //Sign Out
  async signOut(): Promise<void> {
    const token = await this.secrets.get(SECRET_REFRESH);
    if (token) {
      await fetch(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) }).catch(() => undefined);
    }
    await this.forget();
  }

  async forget(): Promise<void> {
    this.access = undefined;
    await this.secrets.delete(SECRET_REFRESH);
  }
}

function encodeQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
}

function emailFromIdToken(idToken?: string): string | undefined {
  const payload = idToken?.split(".")[1];
  if (!payload) return undefined;
  try {
    return (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string }).email;
  } catch {
    return undefined;
  }
}

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>
body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0f1e1d;color:#e2ebea}
main{text-align:center;padding:24px}h1{font-size:22px;color:#2dd4bf;margin:0 0 8px}p{margin:0;color:#93a4a1}
</style></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

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
        res.end(resultPage(ok, error === "access_denied"));
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

//Browser Page
const LOGO_PATH =
  "M222 117H391L276 550C350 515 450 488 540 477L637 117H806L710 476C800 485 890 510 978 555C983 558 981 566 975 564C880 543 780 545 686 563L602 882H432L499 627C380 683 280 765 187 882H17Z";

function resultPage(ok: boolean, denied: boolean): string {
  const title = ok ? "You're connected" : denied ? "Access was not allowed" : "Couldn't connect";
  const message = ok
    ? "Hush can now keep a private, encrypted backup of your .env files in your Google Drive. You can close this tab and go back to VS Code."
    : denied
      ? "Hush needs permission to store its backups in your Google Drive. Go back to VS Code and choose Continue in browser to try again."
      : "Something went wrong while connecting to Google. Go back to VS Code and try again.";
  const badge = ok
    ? '<path d="M7 12.5l3.2 3.2L17 9"/>'
    : '<path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/>';
  const points = ok
    ? `<ul class="points">
        <li><span class="dot"></span>Encrypted on your computer before upload</li>
        <li><span class="dot"></span>Hidden from your Google Drive files</li>
        <li><span class="dot"></span>Only your passphrase can open your backups</li>
      </ul>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Hush</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f6f9f8;color:#13211f;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:440px;background:#fff;border:1px solid #e3ebe9;border-radius:20px;padding:40px 36px 32px;text-align:center;box-shadow:0 1px 2px rgba(19,33,31,.04),0 12px 32px rgba(19,33,31,.08)}
.mark{position:relative;width:72px;height:72px;margin:0 auto 24px;border-radius:20px;background:#e6f6f3;display:grid;place-items:center}
.mark svg.logo{width:40px;height:40px}
.badge{position:absolute;right:-8px;bottom:-8px;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;border:3px solid #fff;background:${ok ? "#0f9488" : "#d14343"}}
.badge svg{width:16px;height:16px;fill:none;stroke:#fff;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
h1{margin:0 0 10px;font-size:24px;line-height:1.25;letter-spacing:-.01em}
p{margin:0 auto;max-width:34ch;color:#566764}
.points{list-style:none;margin:24px 0 0;padding:20px 0 0;border-top:1px solid #edf2f1;display:grid;gap:10px;text-align:left}
.points li{display:flex;align-items:center;gap:10px;font-size:14px;color:#34413f}
.dot{width:8px;height:8px;border-radius:50%;background:#14b8a6;flex:none}
.foot{margin-top:28px;font-size:13px;color:#8a9a97}
.foot b{color:#0f766e;font-weight:600}
</style>
</head>
<body>
<main class="card">
  <div class="mark">
    <svg class="logo" viewBox="0 0 1000 1000" aria-hidden="true"><path fill="#14B8A6" d="${LOGO_PATH}"/></svg>
    <span class="badge"><svg viewBox="0 0 24 24" aria-hidden="true">${badge}</svg></span>
  </div>
  <h1>${title}</h1>
  <p>${message}</p>
  ${points}
  <div class="foot"><b>Hush</b> · .env backup for VS Code</div>
</main>
</body>
</html>`;
}

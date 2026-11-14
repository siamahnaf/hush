# Contributing

## Requirements

- Node.js 18 or newer
- VS Code 1.90 or newer

## Google Cloud setup (once)

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project named **Hush**.
2. **APIs & Services → Library**: enable **Google Drive API**.
3. **Google Auth Platform → Get started**: app name **Hush**, your support email, audience **External**, your contact email.
4. **Branding**:
   - Application home page: `https://github.com/siamahnaf/hush`
   - Application privacy policy link: `https://github.com/siamahnaf/hush/blob/main/PRIVACY.md`
   - Authorized domains: `github.com`
   - Leave the logo empty. A logo requires brand verification, which needs a domain you own.
5. **Data Access**: add the scopes `.../auth/drive.appdata`, `openid` and `.../auth/userinfo.email`.
6. **Audience → Publish app**, so the status is **In production**.
7. **Clients → Create client**: choose **Desktop app** and copy the client ID and secret. Download the JSON, because Google may only show the secret once.
8. Copy `.env.example` to `.env` and paste both values.

While the app is in **Testing**, only test users you add can sign in, and their tokens expire after 7 days. `drive.appdata` is a non-sensitive scope, so Google only reviews the branding.

Hidden app data belongs to the OAuth client. Keep the same client ID for every release, or users lose access to their existing backups.

## Commands

```bash
npm install              # install dev dependencies
npm run build:dev        # build with source maps
npm run watch            # rebuild on change
npm run typecheck        # TypeScript check
npm test                 # unit tests
npm run build            # production build (needs .env)
npm run package          # create hush-env-<version>.vsix
```

Press **F5** in VS Code to launch an Extension Development Host.

## Publishing

1. Bump `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. Build the package:
   ```bash
   npm run package          # creates hush-env-<version>.vsix
   ```
3. **VS Code Marketplace:** open https://marketplace.visualstudio.com/manage/publishers/SiamAhnaf. For the first release choose **+ New extension → Visual Studio Code**; for later releases click **⋯ → Update** next to Hush. Upload the `.vsix`.
4. **Open VSX** (Cursor, VSCodium, Windsurf):
   ```bash
   npx ovsx create-namespace SiamAhnaf -p <open-vsx-token>      # first time only
   npx ovsx publish hush-env-<version>.vsix -p <open-vsx-token>
   ```

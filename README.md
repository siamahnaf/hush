<p align="center">
  <img src="media/logo.png" alt="Hush logo" width="120">
</p>

<h1 align="center">Hush: .env Backup</h1>

<p align="center">Never lose a <code>.env</code> file again. Hush encrypts your <code>.env</code> files on your computer and backs them up to your own Google Drive. Only your passphrase can open them.</p>

<p align="center">Free and open source. No Hush servers, no account to create.</p>

## Features

- **Backs up on save.** Every time you save a `.env` file, Hush encrypts it and uploads it a moment later.
- **Encrypted before upload.** Files are encrypted with AES-256-GCM on your computer. Google only stores data it can't read.
- **Your own Google Drive, hidden.** Backups are stored in Drive's hidden app data folder. They use your Drive storage but never show up in your files, and Hush can't see anything else in your Drive.
- **Restore anywhere.** On a new computer, connect the same Google account, enter your passphrase and restore.
- **Conflict-safe.** If a file changed here and on another computer, Hush pauses and shows both versions side by side.
- **Version history.** Compare or restore any earlier version Google Drive kept.
- **Native look.** Hush uses your VS Code theme everywhere.

## Getting started

1. Install Hush. The setup tab opens.
2. Click **Continue in browser** and allow access to Google Drive.
3. Create a passphrase and save it in a password manager.
4. Choose which `.env` files to back up.

You can reopen setup from the cloud button on any `.env` file, the Hush sidebar or **Hush: Open Setup** in the Command Palette.

## Where to find Hush

- **Status line above line 1** of each `.env` file: backup status plus Push, Pull, Compare and History.
- **Cloud button** in the editor title bar: all actions for the current file.
- **Hush sidebar** in the activity bar: every `.env` file in the workspace, other projects in your Drive, and your account.
- **Status bar**: how many files are backed up, waiting or in conflict.
- **Explorer badges**: ✓ backed up, ↑ waiting to upload, ↓ newer in the cloud, ! conflict.

## How encryption works

- Your passphrase is stretched with **scrypt** (N=2¹⁷, r=8, p=1) into a wrapping key.
- The wrapping key protects one random **vault key**, which is stored encrypted in `vault.json` in Hush's hidden app data folder.
- The vault key encrypts every file with **AES-256-GCM** and a new random IV for each upload.
- File and project names are random-looking IDs. Real paths live inside the encrypted files.
- To see how much space Hush uses, or to delete its data from the Drive side, open Google Drive → **Settings → Manage apps → Hush → Options**.
- On each computer, the unlocked vault key is kept in your operating system's keychain (macOS Keychain, Windows Credential Manager or libsecret on Linux). Your passphrase itself is never stored.

**There is no way to recover a lost passphrase.** If you lose it, nobody can open your backups, including you.

### Changing or rotating keys

- **Change passphrase** re-wraps the vault key. Your other computers keep working.
- **Rotate vault key** creates a new key and re-encrypts every backup. Use it if a computer with Hush was lost or stolen. Other computers need your passphrase again.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `hush.autoPush` | `true` | Back up a `.env` file every time you save it. |
| `hush.autoPull` | `"ask"` | `ask`, `whenSafe` (pull when the local file is unchanged) or `off`. |
| `hush.include` | `.env`, `.env.*`, `*.env` | Glob patterns Hush backs up. |
| `hush.exclude` | `node_modules`, `.git`, `dist`, `vendor`, templates | Glob patterns Hush never backs up. |
| `hush.codeLens` | `true` | Show the status line above line 1. |
| `hush.explorerBadges` | `"all"` | `all`, `attention` or `off`. |
| `hush.statusBar` | `true` | Show the status bar summary. |

## Privacy

Hush has no servers and collects no telemetry. See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE)

# Hush Privacy Policy

Last updated: 14 November 2026

Hush is a free, open-source VS Code extension that backs up your `.env` files to your own Google Drive.

## What Hush accesses

- **Your `.env` files**, in the folders you open in VS Code.
- **Your Google Drive**, limited to Hush's own hidden app data folder (the `drive.appdata` scope). Hush can't see or change any other file in your Drive, and its backups don't appear in your Drive files.
- **Your Google account email**, shown in the Hush sidebar so you know which account is connected.

## Where your data goes

- Files are encrypted on your computer with AES-256-GCM before they're uploaded. The key comes from your passphrase, and only you know it.
- Encrypted files are stored in Hush's hidden app data folder in your own Google Drive. They count toward your Drive storage.
- Your Google sign-in token and your unlocked vault key are stored in your operating system's keychain on your computer.
- Hush has no servers. The developers of Hush never receive your files, passphrase, keys or tokens.
- Hush collects no analytics or telemetry.

## Deleting your data

- **Delete Vault** in the Hush sidebar permanently deletes all of Hush's data from your Google Drive.
- **Disconnect Google Drive** removes the token and key from your keychain and revokes Hush's access. Your backups stay in Drive until you delete them.
- You can also delete Hush's data in Google Drive under **Settings → Manage apps → Hush → Options → Delete hidden app data**, and remove Hush's access at https://myaccount.google.com/permissions.

## Google API Services

Hush's use of information received from Google APIs follows the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Contact

Open an issue at https://github.com/siamahnaf/hush/issues.

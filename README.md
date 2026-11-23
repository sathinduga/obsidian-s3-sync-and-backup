# Obsidian S3 Sync + Backup

Vault synchronization and scheduled backups across devices using S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, RustFS, etc.) with optional end-to-end encryption.

[![Latest Release](https://img.shields.io/github/v/release/sathinduga/obsidian-s3-sync-and-backup?sort=semver)](https://github.com/sathinduga/obsidian-s3-sync-and-backup/releases/latest)
![Obsidian](https://img.shields.io/badge/Obsidian-1.0.0+-purple.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org)
[![Codecov](https://codecov.io/github/sathinduga/obsidian-s3-sync-and-backup/branch/main/graph/badge.svg?token=A6V6CA2W1B)](https://codecov.io/github/sathinduga/obsidian-s3-sync-and-backup)

## Features

- **Bi-directional Sync** — Three-way reconciliation keeps your vault synchronized across devices via S3. Per-file SHA-256 baselines stored locally in IndexedDB detect changes accurately — no cloud manifest required.
- **S3-Compatible Storage** — Works with AWS S3, Cloudflare R2, Backblaze B2, RustFS, and any other S3-compatible endpoint.
- **End-to-End Encryption** — Optional XSalsa20-Poly1305 encryption with Argon2id key derivation. Encrypts both synced files and backup snapshots. Passphrase can be remembered for auto-unlock on startup.
- **Scheduled Backups** — Snapshots of in-scope vault files with configurable intervals (hourly to weekly). Download any backup as a ZIP from settings.
- **Smart Conflict Resolution** — When the same file changes on two devices while offline, the plugin creates `LOCAL_` and `REMOTE_` copies so you never lose data.
- **Status Bar Integration** — Real-time sync and backup status at a glance, with clickable actions.
- **Flexible Retention** — Automatically clean up old backups by age (days) or number of copies.
- **Plugin Settings Protection** — The plugin's own settings directory is hardcoded-excluded from sync to prevent credential or passphrase leakage.
- **Mobile Support** — Works on iOS and Android. No desktop-only APIs used.
- **Command Palette** — Sync now, Backup now, Pause/Resume sync, and more — all available from the command palette with customizable hotkeys.

---

## Installation

### From Community Plugins
1. Open **Settings** → **Community plugins**
2. Search for "S3 Sync + Backup"
3. Click **Install** then **Enable**

---

### Manual Installation
1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/sathinduga/obsidian-s3-sync-and-backup/releases).
2. Create the folder: `<VaultPath>/.obsidian/plugins/simple-storage-sync-and-backup/`
3. Copy the downloaded files into this folder.
4. Reload Obsidian and enable the plugin in **Settings** → **Community plugins**.

---

## Quick Start

### 1. Configure S3 Connection
1. Open **Settings** → **S3 Sync + Backup**.
2. Select your provider (**AWS S3**, **Cloudflare R2**, **Backblaze B2**, **RustFS**, or **Other S3-compatible**).
3. Enter the connection details:
   - **Endpoint URL**: Required for non-AWS providers (e.g. `https://s3.<REGION>.backblazeb2.com` for Backblaze B2).
   - **Region**: AWS S3 and RustFS start with `us-east-1`, and Cloudflare R2 starts with `auto`. Choose the region your bucket or server uses. Backblaze B2 fills the region from a standard endpoint such as `https://s3.us-west-004.backblazeb2.com`. You can also enter it manually. For other S3-compatible services, use the region specified by the service.
   - **Bucket name**: Your S3 bucket.
   - **Access Key ID** & **Secret Access Key**: select an existing secret or create a new one in Obsidian's Keychain. Requires Obsidian 1.11.5 or later for encrypted desktop secret storage. Plugin version 4.2.6 supports Obsidian 1.8.7 and later.
   - **Force Path Style**: Only shown for the **Other S3-compatible** provider — AWS S3, Cloudflare R2, Backblaze B2, and RustFS each use a fixed addressing mode (path-style for R2/B2/RustFS, virtual-hosted for AWS).
4. Click **Test connection** to verify credentials and bucket access. The test uses the values currently in the form.
5. Click **Save connection** to use the new connection for sync and backup. Switching providers, discarding changes, or leaving Settings restores the saved connection when you return to it. If your saved connection uses vault encryption, the new destination must already have vault encryption enabled before you can switch.

### 2. Enable Sync
1. In the **Sync** section, toggle **Enable sync** (on by default).
2. Set the **Sync prefix** (default: `vault`) — this is the S3 folder where your files live.
3. Toggle **Auto-sync** and choose a **Sync interval** (1 min to 30 min, default: 5 min).
4. Enable **Sync on startup** to sync immediately when Obsidian opens.

### 3. Enable Backups (Optional but Recommended)
1. In the **Backup** section, toggle **Enable backups** (on by default).
2. Set the **Backup prefix** (default: `backups`).
3. Choose a **Backup interval** (every hour, 6 hours, 12 hours, daily, every 3 days, or weekly).
4. Enable **Retention** and configure a policy to auto-delete old backups.
5. Use **Backup now** for an immediate snapshot at any time.

### 4. Enable Encryption (Optional)
> ⚠️ **Important**: If you enable encryption, you MUST remember your passphrase. There is no recovery if it is lost.

1. Toggle **Enable end-to-end encryption**.
2. Enter a strong passphrase (minimum 8 characters — a strength indicator guides you).
3. Optionally enable **Remember passphrase** to auto-unlock the vault on startup.
4. Use the **same passphrase** on all devices syncing this vault.

When encryption is enabled:
- All synced files are encrypted before upload to S3.
- All backup snapshots are encrypted (the backup manifest remains plain JSON for metadata).
- Other devices detect the encryption state automatically and prompt for the passphrase.
- Disabling encryption re-uploads all files as plaintext (with a confirmation dialog).

---

## Permissions and data access

The plugin uses Obsidian’s vault index to discover local files for sync and backup. You can narrow that scope in **Settings → Advanced → Exclude patterns**.

### What the plugin reads

| API | Why the plugin uses it |
| :--- | :--- |
| `vault.getFiles()` | Lists the files in Obsidian’s vault index during sync planning and backup snapshots. The index omits files in hidden folders. |
| `vault.read()` / `vault.readBinary()` | Reads the content of indexed files in scope so it can be uploaded to S3. |
| `vault.on('create' / 'modify' / 'delete' / 'rename')` | Tracks which files changed since the last sync so the next cycle only re-checks dirty paths. |
| Bulk re-read on encryption toggle | When you enable, disable, or rotate the passphrase, the plugin reads every in-scope vault file and re-uploads it in the new payload format. |

### What the plugin writes

| Destination | What ends up there |
| :--- | :--- |
| **S3** (under your configured **sync prefix**, default `vault`) | A copy of every vault file inside the sync scope. File payloads are end-to-end encrypted when *Enable encryption* is on; plain otherwise. |
| **S3** (under your configured **backup prefix**, default `backups`) | Timestamped snapshots of in-scope vault files. **File payloads** are encrypted when encryption is enabled; the per-snapshot `.backup-manifest.json` is **always plaintext** so the plugin can list and inspect backups without the passphrase (it contains file paths, sizes, SHA-256 checksums, the encryption flag, and the originating device ID). |
| **Local vault** (`vault.create` / `vault.modify` / `vault.createBinary` / `vault.modifyBinary` / `vault.rename` / `vault.createFolder`) | Files downloaded from S3 on the receiving end of a sync, plus `LOCAL_*` / `REMOTE_*` conflict artifacts when a file diverged on two devices.  Parent folders are auto-created top-down as needed; the rename API is used to stage `LOCAL_*` conflict copies. |
| **Local vault trash** (via `fileManager.trashFile`) | Files that were deleted on another device and propagated by sync. Honours **Obsidian's** *Files and Links → Deleted files* preference (system trash vs. `.trash/` folder vs. permanent). |
| **IndexedDB** (database `obsidian-s3-sync-journal-{vaultName}`) | Per-file sync baselines (path, hash, size, mtime, ETag) used for three-way reconciliation, plus a destination fingerprint that detects when you reconnect to a different bucket/prefix. Vault-scoped so two vaults on the same device never share state. |
| **Obsidian vault-scoped storage** (key `s3-sync-device-id`) | A randomly generated per-vault device identifier. The same ID is written into every uploaded S3 object's `obsidian-device-id` custom metadata for last-writer attribution, and into the `deviceId` field of every backup manifest. |
| **`data.json`** (Obsidian plugin settings) | All plugin settings (secret names for the S3 credentials, sync/backup toggles, exclude patterns) plus the last-completed backup timestamp used by the scheduler. Secret values are never written here. The vault configuration folder stays local, including this file. |

### What is sent off your device

- **HTTP traffic** goes **only** to the S3 endpoint you configure (AWS S3, Cloudflare R2, RustFS, or any other S3-compatible endpoint). The transport scheme matches the endpoint you set — HTTPS for hosted providers; the plugin accepts plain HTTP if you choose it (e.g. `http://localhost:9000` for a local RustFS).
- **No telemetry, no analytics, no error reporting, no update polling.** The Security section below covers the network-use detail.
- **No remote code execution.** The plugin never downloads or evaluates code from the network — all cryptography runs locally in the browser.

### What is *not* read or written

- The plugin does not access the operating system shell, filesystem, or any APIs beyond those Obsidian exposes.
- It does not touch files outside the configured vault.
- It does not contact any host other than the S3 endpoint you configure.

The vault configuration folder, usually `.obsidian/`, stays local and is outside sync and backup. This also applies when you override the folder in Obsidian. Workspace layouts, enabled plugins and plugin settings can differ across devices. Keeping them local prevents one device’s settings from replacing another’s. [Obsidian Vault API](https://docs.obsidian.md/Plugins/Vault) · [Configuration folders](https://obsidian.md/help/configuration-folder)

---

## Settings Reference

On Obsidian 1.13.0 and later, use Settings search to find plugin options such as sync on startup, retention copies, or the encryption passphrase controls.

### Connection

| Setting | Description |
| :--- | :--- |
| **Provider** | Storage provider: AWS S3, Cloudflare R2, Backblaze B2, RustFS, or Other S3-compatible. |
| **Endpoint URL** | S3-compatible endpoint URL. Required for non-AWS providers (e.g., `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` for R2, `https://s3.<REGION>.backblazeb2.com` for Backblaze B2, `http://localhost:9000` for RustFS). Hidden when provider is AWS. |
| **Region** | Editable region for the selected provider. New AWS S3 and RustFS connections start with `us-east-1`, and Cloudflare R2 starts with `auto`. Backblaze B2 can fill the region from its endpoint. Other S3-compatible services use their own region setting. |
| **Bucket** | Name of your S3 bucket. |
| **Access key ID** | Secret (from Obsidian's secret storage) holding your S3 access key ID. |
| **Secret access key** | Secret (from Obsidian's secret storage) holding your S3 secret access key. |
| **Force path style** | Use path-style URLs instead of virtual-hosted. Required for some self-hosted S3-compatible endpoints. Only shown for the **Other S3-compatible** provider — AWS, R2, B2, and RustFS each pin a fixed addressing mode internally. |
| **Test connection** | Check the displayed connection's credentials and bucket access without saving. |
| **Save connection** | Apply the displayed connection after current syncs, backups, and ZIP exports finish. |
| **Discard changes** | Restore the saved connection. |

### Encryption

| Setting | Description |
| :--- | :--- |
| **Enable end-to-end encryption** | Encrypt all files with XSalsa20-Poly1305 before uploading to S3. Requires a passphrase (minimum 8 characters). Shows a strength indicator while typing. |
| **Remember passphrase** | Save the passphrase in Obsidian's Keychain to unlock automatically on startup. If the vault is already unlocked, enter the current passphrase when prompted. |
| **Unlock** | When the vault is encrypted but locked (e.g., after restarting Obsidian without "Remember passphrase"), enter your passphrase to unlock sync and backup. |
| **Disable encryption** | Re-upload all files as plaintext and remove the encryption marker. Shows a confirmation dialog. Other devices switch to plaintext mode automatically on next sync. |

### Sync

| Setting | Description | Default |
| :--- | :--- | :--- |
| **Enable sync** | Master switch for bi-directional vault synchronization. | On |
| **Sync prefix** | S3 folder path for synced files (e.g., `vault` → `s3://bucket/vault/`). | `vault` |
| **Auto-sync** | Automatically sync at regular intervals. | On |
| **Sync interval** | How often to auto-sync. Options: 1, 2, 5, 10, 15, or 30 minutes. Only shown when auto-sync is enabled. | 5 min |
| **Sync on startup** | Run a sync immediately when Obsidian starts. | On |

### Backup

| Setting | Description | Default |
| :--- | :--- | :--- |
| **Enable backups** | Master switch for scheduled vault backup snapshots. | On |
| **Backup prefix** | S3 folder path for backups (e.g., `backups` → `s3://bucket/backups/`). | `backups` |
| **Backup interval** | How often to create snapshots. Options: every hour, 6 hours, 12 hours, daily, every 3 days, or weekly. | Daily |
| **Enable retention** | Automatically delete old backups after saving a new snapshot. If cleanup fails, the new snapshot remains available and the plugin reports the cleanup error. | Off |
| **Retention mode** | How to determine which backups to keep: **By days** (delete backups older than N days) or **By copies** (keep only the latest N backups). Only shown when retention is enabled. | By copies |
| **Retention days** | Delete backups older than this many days (1–360). Only shown in "By days" mode. | 30 |
| **Retention copies** | Keep only the latest N backups (1–1000). Only shown in "By copies" mode. | 30 |
| **Backup now** | Create a backup snapshot immediately. |  |
| **View backups** | Open a modal listing the 5 most recent backups with per-backup download buttons. Each entry shows timestamp, file count, size, and encryption status. |  |

### Advanced

| Setting | Description | Default |
| :--- | :--- | :--- |
| **Debug logging** | Enable verbose console logging for troubleshooting. | Off |
| **Exclude patterns** | Comma-separated vault-relative file paths and glob patterns to skip during sync and backup. | `**/workspace*, .trash/**` |
| **Reset to defaults** | Reset all settings to defaults, preserving S3 connection credentials. Shows a confirmation dialog. |  |

#### Exclude files from sync and backup

Enter vault-relative paths in **Settings → Advanced → Exclude patterns**. Use forward slashes and separate entries with commas.

- `Private/Journal.md` skips one note.
- `Archive/**` skips the contents of `Archive`, including subfolders.
- `*.canvas, **/*.canvas` skips Canvas files at the vault root and in subfolders.

Matching files are skipped during sync in both directions and in future snapshots. Adding a pattern leaves existing S3 objects and snapshots in place.

---

## Command Palette

All commands are available via the Obsidian command palette (`Ctrl/Cmd + P`) and can be bound to custom hotkeys.

| Command | Description |
| :--- | :--- |
| **S3 Sync + Backup: Sync now** | Trigger an immediate sync. |
| **S3 Sync + Backup: Backup now** | Trigger an immediate backup snapshot. |
| **S3 Sync + Backup: Pause sync** | Pause automatic sync (shown only when sync and auto-sync are enabled). |
| **S3 Sync + Backup: Resume sync** | Resume automatic sync after pausing. |
| **S3 Sync + Backup: View sync log** | Open the sync log viewer. |
| **S3 Sync + Backup: View backups** | Open a modal listing recent backups with download buttons. |
| **S3 Sync + Backup: Open settings** | Open the plugin settings page. |

---

## Multi-Device Sync

This plugin is designed for multi-device use. Each device gets a unique ID on first run, and all S3 uploads are tagged with the writing device's ID.

**How it works:**
- Each device maintains its own local sync journal (IndexedDB) with per-file baselines.
- On sync, the engine compares local state, remote state (S3), and the last-known baseline to determine what changed and where.
- If the same file changed on two devices while both were offline, a **conflict** is created with `LOCAL_` and `REMOTE_` copies of the file.

**Encryption across devices:**
- When encryption is enabled on one device, other devices detect the encrypted state on next sync and prompt for the passphrase.
- Use the same passphrase on all devices. If the wrong passphrase is entered, the plugin notifies you and clears any saved passphrase.
- Encryption enable/disable operations use an advisory lock to prevent two devices from migrating simultaneously.

---

## S3 Bucket Structure

```
your-bucket/
├── vault/                              # LIVE DATA (synced)
│   ├── .obsidian-s3-sync/
│   │   └── .vault.enc                  # Encryption marker (if enabled)
│   ├── Notes/
│   │   └── my-note.md
│   └── Attachments/
│       └── image.png
│
└── backups/                            # SNAPSHOTS (read-only)
    ├── backup-2024-12-25T14-30-00/
    │   ├── .backup-manifest.json       # Plain JSON: file count, checksums, encrypted flag
    │   └── ... (in-scope vault files)
    └── backup-2024-12-24T14-30-00/
```

---

## Security

- **Encryption algorithm:** XSalsa20-Poly1305 (via tweetnacl) with Argon2id key derivation (via hash-wasm).
- **Content identity:** SHA-256 fingerprints of plaintext content, stored in S3 custom metadata.
- **Network use:** Outbound network requests go **only** to the S3-compatible endpoint you configure (AWS S3, Cloudflare R2, or RustFS) over HTTPS. No third-party services, telemetry endpoints, analytics, or update servers are contacted. The plugin performs the following kinds of network activity, all under your control:
    - **Periodic sync** polls your bucket on a user-configurable interval (default 5 minutes, range 1–30 minutes). Controlled by the *Enable sync* and *Auto-sync* toggles plus the *Sync interval* dropdown in Settings — turning either toggle off stops all scheduled sync traffic.
    - **Periodic backups** snapshot your vault on a user-configurable schedule (default daily, options from hourly to weekly). Controlled by the *Enable backups* toggle and the *Backup interval* dropdown.
    - **Manual operations** (sync now, backup now, test connection, download backup) only run when you invoke them from the command palette, status bar, or settings.
- **No telemetry:** The plugin sends no usage data, error reports, or identifiers anywhere. Disabling sync and backups stops all network activity completely.
- **No remote code execution:** All encryption and hashing runs locally in the browser. The plugin never fetches or evaluates code from the network.
- **Credential protection:** On first launch after upgrading, the plugin moves legacy S3 credentials and any remembered passphrase from `data.json` to Obsidian's Keychain. It removes the legacy values after the replacement secrets can be read. Startup sync and catch-up backup wait for the encryption check and unlock. On a new device, add or select the S3 secrets in that device's Keychain and enter the passphrase. Obsidian has no secret deletion API, so cleared secrets remain as empty entries.

---

### Testing

The plugin includes 565+ automated tests: unit tests covering sync, encryption, backup, and utility modules, pipeline end-to-end tests, and integration tests against live S3 endpoints. CI runs linting, type-checking, and the full test suite on every pull request.

---

## FAQ

<details>
<summary><strong>Does this work on mobile?</strong></summary>
Yes! The plugin works on both iOS and Android versions of Obsidian. No desktop-only APIs are used. Note that mobile operating systems may restrict background activity, so open the app periodically to ensure sync completes.
</details>

<details>
<summary><strong>Can I use this alongside Obsidian Sync?</strong></summary>
It is <strong>not recommended</strong>. Using two sync solutions simultaneously can cause race conditions and data conflicts. Choose one primary sync method.
</details>

<details>
<summary><strong>How do I restore from a backup?</strong></summary>
Go to <strong>Settings → S3 Sync + Backup → Backup → View backups</strong>, or use the <strong>View backups</strong> command from the command palette. The modal lists the 5 most recent backups — click "Download zip" to export one as a ZIP file. Extract it and manually copy files back into your vault.
</details>

<details>
<summary><strong>Why do I see LOCAL_ and REMOTE_ files?</strong></summary>
This means the same file changed on two devices while both were offline (a sync conflict). Open both files, manually merge the content into the original filename, then delete the <code>LOCAL_</code> and <code>REMOTE_</code> copies. The conflict resolves on the next sync.
</details>

<details>
<summary><strong>Are my backups encrypted?</strong></summary>
Yes — when encryption is enabled and the vault is unlocked, all backup files are encrypted before upload. The backup manifest (<code>.backup-manifest.json</code>) is always plain JSON so the plugin can read backup metadata, but it contains only file names, checksums, and the <code>encrypted</code> flag — no file content.
</details>

<details>
<summary><strong>What happens if I forget my passphrase?</strong></summary>
There is <strong>no recovery</strong>. The passphrase is never sent to S3. If you lose it, encrypted files in S3 cannot be decrypted. Always use a password manager to store your passphrase securely.
</details>

<details>
<summary><strong>Can I change the sync or backup prefix after setup?</strong></summary>
Yes, but existing files under the old prefix won't be moved. The plugin will treat the new prefix as a fresh location. You'd need to manually move or re-sync files if you change prefixes.
</details>

<details>
<summary><strong>What files are excluded from sync and backup?</strong></summary>
The vault configuration folder stays local. The default exclude patterns are <code>**/workspace*</code> and <code>.trash/**</code>. For other vault files, see <a href="#exclude-files-from-sync-and-backup">the exclude pattern examples</a>.
</details>

---

## Support & Contributing

- **Issues**: [Report bugs or request features](https://github.com/sathinduga/obsidian-s3-sync-and-backup/issues)
- **Contributing**: See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

MIT © [Sathindu](https://github.com/sathinduga)

Made with love for the Obsidian community

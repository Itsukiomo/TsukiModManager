# Tsuki Mod Manager

Tsuki Mod Manager is a standalone mod manager for **PAYDAY 3**. It helps install, track, restore, and manage PAYDAY 3 mods from supported sources like Nexus Mods and ModWorkshop.

This is not a normal PAYDAY 3 mod archive. Do **not** install Tsuki through Vortex, MO2, or another mod manager.

## Features

* Browse supported PAYDAY 3 mod sources
* Install and track mods installed through Tsuki
* Manage PAK mods and UE4SS-style mods
* Launch PAYDAY 3 in modded or vanilla mode
* Temporarily move mods outside PAYDAY 3 folders for vanilla launch
* Restore hidden mods after vanilla closes or crashes
* Create and restore mod backups
* Debug tools for troubleshooting installs, browsing, updates, and paths
* In-app update checking through GitHub releases

## Installation

1. Download the latest `TsukiModManager` release.
2. Run the setup installer.
3. Open Tsuki Mod Manager.
4. Let Tsuki auto-detect your PAYDAY 3 install.
5. If auto-detect fails, set your PAYDAY 3 folder manually in Settings.
6. Add a Nexus Mods API key only if you want Nexus browsing.
7. Add a ModWorkshop API key only if a future feature requires it.

## Important Notes

* Tsuki is a standalone application, not a PAYDAY 3 mod.
* Do not install Tsuki using Vortex or another mod manager.
* Do not place the Tsuki installer inside your PAYDAY 3 mods folder.
* Do not manually edit Tsuki receipts unless you know exactly what you are doing.
* Before testing risky mod changes, create a backup from the Backups tab.

## Vanilla Launch Safety

When launching PAYDAY 3 in vanilla mode, Tsuki temporarily moves supported mod files outside PAYDAY 3’s scanned folders. This prevents the game from loading modded `.pak`, `.ucas`, `.utoc`, or UE4SS files.

After PAYDAY 3 closes or crashes, Tsuki attempts to restore those files automatically.

If mods do not restore automatically, open Tsuki and use:

```text
Installed → Advanced → Restore Mods
```

## Debug Menu

Tsuki has a hidden debug panel for troubleshooting.

To open it, type:

```text
d e b u g
```

Do this while you are not typing inside a text field or search box.

The debug panel includes tools for:

* Installed mods
* Browse/source diagnostics
* Backups
* Updates
* Settings
* Restore Mods
* Debug report generation

## What Not To Share

Do not publicly share:

* Your Nexus Mods API key
* Your ModWorkshop API key
* Your `settings.json`
* Your full `%APPDATA%\Tsuki Mod Manager` folder
* Private debug reports that include personal Windows paths
* Receipts or backups if they reveal private file paths or mod files you cannot redistribute
* Any paid, pirated, or copyrighted mod content that you do not have permission to share

Before uploading screenshots or debug reports, check for personal paths like:

```text
C:\Users\YourName\
```

## For Developers

Tsuki is built with:

* Tauri
* React
* TypeScript
* Vite
* Rust

Recommended setup:

* VS Code
* Tauri VS Code extension
* rust-analyzer
* Node.js
* Rust toolchain

Install dependencies:

```powershell
npm install
```

Run in development mode:

```powershell
npm run tauri dev
```

Build frontend only:

```powershell
npm run build
```

Build release installer:

```powershell
npm run tauri build
```

Release bundles are created under:

```text
src-tauri/target/release/bundle/
```

## Updating the App

Tsuki checks a GitHub-hosted `latest.json` manifest for updates.

The manifest should include:

```json
{
  "version": "1.8.1",
  "notes": "Short update notes here.",
  "pubDate": "2026-06-15T20:48:42Z",
  "releaseUrl": "https://github.com/Itsukiomo/TsukiModManager/releases/tag/v1.8.1",
  "downloadUrl": "https://github.com/Itsukiomo/TsukiModManager/releases/download/v1.8.1/TsukiModManager-1.8.1-Setup.exe",
  "sha256": "installer_sha256_here"
}
```

## Disclaimer

Tsuki Mod Manager is an unofficial PAYDAY 3 utility. Use mods at your own risk. Always back up your files before testing new mods or launch modes.

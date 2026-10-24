# Tsuki Mod Manager 2.0.4

- Restore anonymous in-app native-loader downloads through a separate public compiled-runtime channel. The original loader repository can remain private.
- Preserve recognition of existing signed local loader receipts during channel migration. New remote manifests must match the new channel; signing-key, signature, payload, ownership and downgrade checks remain enforced.
- Include the Windows taskbar icon fix: explicitly set and read back the large native icon slot rather than relying on shortcut icon caching.
- Loader 1.0.3 adds actionable Steam-update/storage errors and safe recovery handling. Its signed package is downloaded independently from the app.

An incomplete Steam game update must finish before launching modded. The loader cannot supply missing game files, create disk space or certify outdated third-party mods. Full-catalog/in-game verification remains incomplete. Public compiled assets and their URLs remain discoverable; a neutral repository name is not access control. The Windows installer is not Authenticode-signed.

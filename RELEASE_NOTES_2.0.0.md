# Tsuki Mod Manager 2.0.0

## Changes

- Game-scoped profiles, settings, mod-profile selections, source configurations and installation receipts.
- Profile and game versions, including separate PAYDAY 3 UE5.5 and legacy UE4.27 configurations. Bulk PAYDAY 3 indexing is UE5-only.
- Profile cards use equally sized full-cover artwork and translucent detail overlays. Game-version selectors stay within the card, keeping the grid aligned.
- Profile-driven archive routing with dependency checks, authored folder preservation, reversible toggles and receipt-owned removal.
- Newest eligible file selection and a file picker for multi-file downloads.
- External-manager handoffs for formats requiring Overstrike, Fluffy, BLCMM or other tools. Handoffs are not marked installed.
- Installed-state reconciliation removes missing files and uses exact receipt/hash evidence for source identification.
- Faster Installed loading: live receipts render before source identification, catalog matching uses keyed lookups, and cards render in batches of 48. Search and filtered bulk selection still cover the complete library.
- Lunar startup screen, refreshed branding, image-forward cards, colorful expandable tags and consistent controls.
- Taller featured cards with stable secondary cards during rotation.
- Outlast Trials native support downloads a separately released compiled backend after disclosure and consent. GitHub downloads use pinned Ed25519 signatures and SHA-256 payload verification; the backend is not included in Tsuki's base package.
- Native updater version derives from package metadata. The release manifest includes the Windows installer checksum.
- PAYDAY 2 rejects mismatched loader architecture. PAYDAY 3 dependency diagnostics distinguish file presence from a recorded AllowModsMod patch failure.

## Installation And Upgrade

Run `Tsuki.Mod.Manager_2.0.0_x64-setup.exe`. Existing 1.8.2 settings and WebView storage are preserved. Back up important mod files before changing profiles or third-party loaders. The Windows installer is not Authenticode-signed; Windows may display a publisher warning.

Nexus download availability depends on the account, API permissions and provider restrictions. Tsuki does not bypass download restrictions.

## Validation Scope

The release qualification covers clean Windows installation, upgrading an actual 1.8.2 installation, native version reporting, persisted settings and browser storage, profile/source regression tests, downloaded archive receipt lifecycles and UI layouts.

Outlast's actual packaged profile UI was tested for consent, public GitHub download, verified installation, reopening without reinstalling, damaged-runtime repair and signed update in a generated game directory. The compiled backend's generated-archive apply/restore lifecycle was tested separately. This does not establish online safety or compatibility with the installed game's protection systems.

The current official PAYDAY 2 64-bit SuperBLT package loaded a temporary read-only startup Lua probe in the installed game. Original loader and base-mod files were restored with hash verification. This does not establish compatibility for all existing third-party mods.

## Known Limits

- PAYDAY 3's current official UE5 beta loader matched the installed DLLs but logged `Delegate not found. Unable to patch.` on the tested build. PAK activation is not confirmed. Reinstalling the same package is not a verified fix. Follow the [official loader page](https://modworkshop.net/mod/47771) for updates.
- PAYDAY 2 current and legacy branches need different SuperBLT architectures and matching base mods. The [official 64-bit package](https://modworkshop.net/mod/58342) is a beta. Original local files were restored after qualification, so an existing incompatible installation still needs updating.
- Games not installed on the test machine have archive-routing/receipt evidence, not in-game verification. Game updates and individual mods may require further compatibility testing.
- Overstrike, Fluffy and other external-manager imports/activation are not verified end to end here. Follow the generated handoff instructions.
- Unsupported saves, user-configuration variants and ambiguous formats remain blocked or require explicit manual selection. Tsuki does not guess save destinations or replace shared runtimes silently.
- Bulk indexing is incomplete: the local job reached its storage reserve after 6,031 hashed archives. Provider-unavailable files and unverified historical PAYDAY files are not claimed identified. Cyberpunk remains in-app-download indexing only.

These limits must accompany the public release. Do not describe 2.0 as universally game-tested or every archive indexed.

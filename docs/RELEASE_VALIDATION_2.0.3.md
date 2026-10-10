# Release 2.0.3 Validation

## Final Publication Qualification

The owner explicitly authorized public release of Tsuki 2.0.3 and signed Outlast loader 1.0.2 on 2026-10-10, lifting the earlier publication hold. Earlier hold statements below are historical qualification checkpoints, not the current authorization state.

- Fresh Rust suite: 92 passed, 11 opt-in checks ignored. Production signed loader-bundle qualification passed separately.
- Fresh profile workflow/version, universal runtime, source authentication/file selection, encoding, installed presence, dependency-link and command-registry checks passed. The command audit covers 160 registered commands; dependency links cover 43 records and 16 profile click targets.
- Final Tauri build produced MSI and NSIS installers. The first installer gate caught stale v2.0.2 startup/sidebar labels; both were corrected before rebuilding.
- The exact rebuilt NSIS installer passed clean installation, native/sidebar version checks, actual 1.8.2-to-2.0.3 upgrade, settings and WebView storage preservation and no captured frontend exceptions: `D:/TsukiReleaseQualification/public-2.0.3-final/installer-20261010-135946/installer-report.json`. Existing Windows registration was restored and the owner's installed executable was unchanged by this qualification.
- Installer SHA-256: `2edb9bf9c340d0bbb0572f8cb43ec85f5f645130e8b7968a0897be10361ec034`.

Full-catalog testing, universal in-game compatibility and external-manager activation remain unproven where noted below. Public release authorization does not convert pending checks into successes.

## Completed Before Packaging

- Rust unit suite: 89 passed, 10 opt-in checks excluded from the normal suite.
- Frontend production build passed.
- Registry audit: all frontend literal Tauri calls map to registered commands (160 commands).
- Profile workflow/runtime/version, universal runtime, source auth/file selection, installed presence, encoding, dependency links and action/requirements UI checks passed.
- Research mapping validation covers all 16 built-in profiles; this is configuration validation, not runtime proof.
- Source-index isolated check verifies complete/partial coverage, ambiguous identical versions, cross-game source rejection, stale file removal and Cyberpunk's in-app-only index.
- All-profile toggle command test passed for 16 built-in profiles and a saved Creator profile: exact receipt selection, raw/local command dispatch, persistent Off state and exact restored hashes. The extended run also tests failed-update rollback.
- Rechecked 37 previously downloaded and hashed source archives: 18 direct install/disable/enable/uninstall cases, 15 external-manager handoffs and four deliberately unsupported packages. No real game files were changed in these checks.

## Release Gates

The final packaged-app and installer qualification results are appended after execution. A successful build or process launch alone is not an installation/runtime test.

## Outlast Launch Fix And Publication Hold

Publication is on hold at the owner's request. No 2.0.3 release was published.

The failed launch log reported Steam API initialization failure; Tsuki launched a mapped game executable directly. The independently signed backend applied successfully when the game was closed. Outlast now launches through Steam's normal app launch, with a cross-process launch lock covering preparation and the running game. Running-game checks precede PAK operations, backend errors retain their returned message, and vanilla receipt restoration waits for game exit rather than Steam's forwarding process.

- Managed-loader unit tests: 12 passed, one opt-in release-bundle test excluded.
- Packaged running-game rejection: `D:/TsukiReleaseQualification/outlast-launch-1791657915049/report.json`.
- Packaged fresh launch and duplicate rejection: `D:/TsukiReleaseQualification/outlast-launch-1791657937445/report.json`. The actual game log reached `MainMenu` without Steam API initialization failure.
- Local executable replaced with a hash-verified backup: `C:/Users/jeffe/AppData/Local/Tsuki Mod Manager/tsukimodmanagerapp.exe.before-outlast-launch-20261010-114631.bak.manifest.json`.
- Local installed SHA-256: `336B0DB44D21C18D3DFB28D2B4BC1B06F56BD56CD5AAAF7166E7AEBF0105FB58`.
- No game executable or protection components were replaced. Existing source mods and recovery records were retained. Some existing mod assets report missing packages; reaching the menu does not validate every mod or online gameplay.

The installer has not yet been requalified after the final local launch changes. Public release remains blocked pending the owner's authorization and remaining release checks.

## Outlast PAK, Movie And Custom UI Follow-Up

Publication remains on hold. The signed backend 1.0.1 was installed locally through production signature, ownership and payload verification; it has not been published. Its previous runtime was backed up under `D:/TsukiReleaseQualification/outlast-runtime-backup-20261010-movie-integration`.

- Latest Rust suite: 91 passed, 11 opt-in checks ignored. Frontend production build, Tauri installer build, `cargo check` and `git diff --check` passed.
- Original loader source suite: 36 passed. Compiled backend lifecycle and movie protocol checks passed, including loose Bink, movie-only PAK, nested subtitles, selection, disable/restore and escaped-path rejection.
- Real packaged movie lifecycle: install/apply, disable, enable and uninstall passed in `D:/TsukiReleaseQualification/outlast-movies-1791658867596/report.json`. The original movie was restored with SHA-256 `269e21a276eb7456b444015ae85e9cd21a127da69b53d33267be879d281fd993`.
- Windows verbatim canonical paths now use normalized drive/UNC comparisons. The regression check still rejects sibling roots and traversal. The actual Original Custom UI file was disabled through Tsuki's receipt system; Plus Hawk was retained.
- Read-only Plus Hawk payload audit verified 3,671 winning payloads and 130 overridden paths in `D:/TsukiReleaseQualification/outlast-payload-plus-hawk.json`. Byte verification is not visual compatibility proof.
- Packaged Plus Hawk launch and duplicate-launch rejection passed in `D:/TsukiReleaseQualification/outlast-custom-ui-1791659174542/report.json`; the actual game reached MainMenu without Steam API initialization failure. The owner subsequently confirmed that the Plus Hawk menu opens in-game and answered "Yeah it works" to the harmless-option/reopen check. This is owner-observed UI verification, not automated visual verification of every mod.
- Latest installed local app SHA-256: `568A22976F363FB8992C37F452FC23491E515D3DF14893D0D3034433E939E352`. Backup manifest: `C:/Users/jeffe/AppData/Local/Tsuki Mod Manager/tsukimodmanagerapp.exe.before-outlast-movies-20261010-120934.bak.manifest.json`.
- No game executable, protection components or saves were replaced. The installer was rebuilt, but its final install/upgrade qualification remains outstanding.

Supported native movie payloads are `.bk2` and `.srt`; MP4 renaming is not conversion. IoStore, unknown encryption keys/codecs, external audio-manager packages and outdated cooked assets are not universally supported. Existing missing-package warnings need individual mod compatibility checks. Movie playback, online trials and every individual mod's visual effect have not been verified.

## Full Outlast Catalog Qualification In Progress

The owner requested every available Outlast package be fetched, tested separately and removed without deleting existing mods. A fresh Nexus catalog query returned 301 entries. All four pages of ModWorkshop's 66-game directory were checked; no Outlast game entry was present. These figures describe this snapshot, not a permanent complete mod universe.

- `scripts/outlast-catalog-qualification.mjs` downloads available, non-archived Nexus files and records hashes and per-file results under `D:/TsukiReleaseQualification/outlast-full-catalog`. It does not edit the source index, API credentials, user receipts or live game files.
- `scripts/outlast-package-loader-test.py` stages each package into a disposable synthetic game and exercises the compiled backend with byte readback and restore/disable/reenable checks. Direct staging tests the loader, not the frontend install workflow or live cooked-asset compatibility.
- Current files are protected by `current-mods-baseline.json`; its first comparison confirmed all 54 recorded source, receipt, selection and executable files unchanged. The original main game PAK is excluded from this source-mod inventory; no live append was performed in this pass.
- With Outlast still running, apply checks remain deferred. Read-only source-container inspection continues. Global closed-game checks have not been bypassed.
- The No-Intro package contains zero-length startup `.bk2` replacements; backend 1.0.1 rejects these. This is an unresolved compatibility case, not a corrupt-download claim. Presets, configuration files and external tools without PAK/Bink/subtitle payloads are classified separately.

The catalog pass is checkpointed at the closed-game gate, not complete: 119 downloaded files, with 102 source-container checks deferred for compiled lifecycle testing, 16 packages without supported loader payloads and one rejected empty-video package. One download was still pending when the runner stopped. No test process remains running. The final preservation comparison again reported all 54 recorded existing files unchanged. No test mods were installed in the live game, and downloaded test archives remain in the isolated workspace for the next phase. No all-mod compatibility claim or public release is authorized by these preliminary results.

## No-Intro Fix Installed Locally

The first catalog pass identified the intentional empty startup replacements as a compatibility gap in backend 1.0.1. The source fix accepts only the exact root movie targets `RedBarrelsLogo.bk2` and `TOT_ThirdParty.bk2`. Nested targets, unrelated empty files and malformed nonempty Bink files remain rejected. Both accepted targets retain the existing original-file backup, disable/reapply and restoration lifecycle.

- Private source suite: 38 passed, including both empty startup replacements and exact original-byte restoration, plus negative validation cases.
- Nuitka standalone backend rebuilt successfully and signed as 1.0.2 under `D:/TsukiReleaseQualification/outlast-loader-1.0.2-local`. Production pinned-signature, archive and owned-payload verification passed. Archive SHA-256: `1ece141f999319e10ab16b0868f3dc004e15a9f21dc901b90f1ce072f48d40db`.
- App updates now compare semantic-version precedence before changing cached release metadata or downloading a replacement. An intact newer runtime is retained; a damaged newer runtime requires repair, not downgrade. Version parsing fails closed.
- Latest Rust suite: 92 passed, 11 opt-in checks ignored. `cargo check`, frontend production build and Tauri MSI/NSIS packaging passed. Existing dead-code warnings remain.
- The owner authorized closing Outlast. It exited gracefully; no process guard was bypassed. Signed backend 1.0.2 was installed through production ownership/signature/hash checks, with the prior runtime backed up under `D:/TsukiReleaseQualification/outlast-runtime-backup-20261010-startup-skip`.
- Compiled backend PAK lifecycle and movie protocol tests passed, including loose and packed empty startup replacements, exact original restoration and escaped-path rejection. The actual downloaded No-Intro archive passed isolated compiled apply/readback/restore/disable/reenable testing; its disposable test copies were removed.
- Real packaged No-Intro import, enable/disable, uninstall and both original-movie hash restorations passed in `D:/TsukiReleaseQualification/outlast-movies-1791663557187/report.json`. Steam reached a fresh main-menu log while both empty startup replacements were active. The test launch was closed gracefully and the temporary package was uninstalled. This is startup/log verification, not automated visual proof of every movie or UI mod.
- The loader recorded a temporary test selection. Removing only that entry and preserving the original CRLF serialization reproduced the baseline selection SHA-256 exactly. All 54 recorded existing files then matched their baseline. The lifecycle harness now backs up the original selection and restores its exact bytes only when no unrelated selection changes occurred.
- Local app SHA-256: `C7B50C7DE653C142656546506E5D492EA235A591658BE88CE241F097267C5574`. Backup manifest: `C:/Users/jeffe/AppData/Local/Tsuki Mod Manager/tsukimodmanagerapp.exe.before-outlast-startup-skip-20261010-132052.bak.manifest.json`. An initial replacement attempt hit a transient executable lock without changing the old file; the retry waited for exit and verified the replacement hash.
- The final packaged app recognizes signed backend 1.0.2. A real public-release Update action retained that newer local runtime and every payload/receipt hash: `D:/TsukiReleaseQualification/outlast-loader-update-1791663791630/report.json`. Its first isolated check encountered the expected disclosure state before consent; the authorized rerun passed without changing the owner's consent store.
- The final installed app then passed the full live No-Intro lifecycle and fresh main-menu launch again, with automatic exact selection restoration: `D:/TsukiReleaseQualification/outlast-movies-1791663809524/report.json`.

The complete catalog lifecycle pass remains unfinished. This correction does not assert visual compatibility for every cooked PAK, movie or configuration package. Existing mod sources, selections, the game executable, protection components and saves were preserved. Live PAK/movie state was temporarily applied for testing and the original movies were restored; this is not a claim that no game data was touched during the authorized lifecycle test.

## General Release Boundaries

- In-game compatibility has not been proven for every supported game or mod.
- External-manager formats require their actual manager/import step; handoffs do not activate them.
- Original-game-file overwrite mods require manual review before replacement, to preserve their original backups.
- Source/account permissions may hide files or block downloads; no permission bypass is provided.
- Signed Outlast-loader authorization remains separate from general dependency downloads.
- The installer is unsigned; Windows may show SmartScreen warnings.

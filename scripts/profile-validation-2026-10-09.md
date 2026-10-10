# Profile Workflow Validation - 2026-10-09

The original pass below is retained as history. The continuation section at the end supersedes its package counts, format boundaries, and installed executable hash.

## Delivered

- Full-window lunar startup screen with a generated, compressed WebP backdrop.
- Removed the artificial startup delay and lazy-loaded secondary pages. Production entry JavaScript is 365.95 kB (109.66 kB gzip), down from approximately 1008 kB before this pass. This is a payload reduction, not a measured claim about launch time.
- Sidebar navigation icons, real determinate progress, and animated indeterminate progress. A missing completion event no longer creates a fake 100% success.
- Colorful semantic tags and mint Install, gold Update, and red destructive actions. Fixed conflicting legacy CSS and keyboard activation bubbling from a card button into the card.
- Compact mod details without an empty media placeholder; functional file actions and DOMPurify-backed browser HTML sanitization.
- Saved PAYDAY 2 drafts remain distinct from the built-in profile. Draft artwork, backups, selected mod profiles, and per-game ownership were tested with isolated persistence.
- Generic Installed state now excludes records with no files on disk; receipt history is retained. Disabled files still count only when they exist in the real disabled storage.
- SuperBLT packages identified by supermod.xml retain their authored folder. REFramework scripts retain authored data files; root proxy DLLs cannot be misplaced into the plugins directory.
- Overstrike and Fluffy Mod Manager packages have a Prepare action that copies the original archive unchanged, verifies SHA-256, writes a profile-scoped handoff manifest, and opens the handoff folder. It does not run downloaded code or falsely mark the archive installed.

## Evidence

All test downloads and game writes were confined to src-tauri/target/profile-smoke. Real game installations were not changed.

- All 16 built-in profiles: 21 API source/version cases (17 Nexus and 4 ModWorkshop), including separate PAYDAY 3 UE4.27 and UE5.5 ModWorkshop cases.
- 42 actual downloaded packages, with hashes and content-aware routing recorded.
- Latest recheck: 11 complete install -> disable -> enable -> uninstall receipt lifecycles, 14 external-manager handoffs verified, 14 unsupported packages blocked, and 3 PAYDAY 3 archive-routing checks.
- Separate PAYDAY 3 UE5 loader + Lua + PAK receipt-lifecycle test passed using the downloaded UE5 dependency archive.
- 49 Rust unit tests passed; four opt-in sandbox/network tests are excluded from ordinary unit-test runs. Relevant opt-in tests were run separately.
- Eleven frontend/data regression scripts passed, including workflow, versions, universal runtime, source authentication, encoding, dependency links/parser, runtime workflow, file selection, installed presence, and research manifest validation.
- Fourteen viewport/theme UI cases passed. Startup, card, and detail layouts checked at 1500x900, 1100x700, and 390x844; sidebar checked at the supported desktop widths. Screenshot fixture and assertions ensure sidebar progress is visibly within the window.
- Native debug app: real ModWorkshop and Nexus pages loaded in their embedded webviews; leaving Browse closed the webview; Settings Back restored Browse; game selector showed all built-ins and the separate restored PAYDAY 2 draft.
- npm run build, cargo check, cargo test --lib, cargo build --release --features tauri/custom-protocol, and git diff --check passed. Existing dead-code and Git CRLF notices remain warnings.

Evidence directory: src-tauri/target/profile-smoke/2026-10-09T16-11-06-551Z.
Reports: report.json, recheck-report.json, workflow-persistence-report.json.
UI screenshots and report: src-tauri/target/profile-smoke/ui-verification.
UE5 dependency lifecycle: src-tauri/target/profile-smoke/ue5-loader-verification.

## Explicit Boundaries

This does not establish that every arbitrary archive or every game runtime works.

- External-manager handoff is verified; actual imports and in-game activation in Overstrike/Fluffy were not executed.
- Unsupported samples include Engine.ini alternatives, PAYDAY: The Heist raw asset/PDMod formats, Borderlands saves/BLCMM/Oak SDK packages, and Wonderlands packages outside the currently verified direct rules. These remain blocked instead of being copied into guessed destinations.
- Some newest Nexus entries returned HTTP 403 because the mod/file was unavailable. Those errors are preserved in the live report; available subsequent files were used for download tests.
- Real in-game launch and compatibility for every profile were not tested. A simulated executable marker proves routing/identity checks, not gameplay.
- Native image-picker click-through was not completed in this pass; backend artwork persistence was verified. No missing historical draft was fabricated.

## Installed Release

Installed path: C:\Users\jeffe\AppData\Local\Tsuki Mod Manager\tsukimodmanagerapp.exe

SHA-256: 35E10C8AD829B48FB8E9441B7AEF8A655E756D7B7C78B4C3DE677B491C7FE16A

Previous executable: tsukimodmanagerapp.exe.before-profile-validation-20261009-094100.bak

The installed release was reopened and visually verified rendering its Home page, colorful tags, populated ModWorkshop/Nexus cards, and updated sidebar icons.

The workspace contains pre-existing changes from earlier work. They were preserved, not reset.

## Continuation Results

Latest 42-package recheck: 18 install/disable/enable/uninstall lifecycles, 17 verified manager/conversion handoffs, 3 PAYDAY 3 archive-routing checks (plus its separate loader/Lua/PAK lifecycle test), and 4 blocked manual cases.

The remaining manual cases are Outlast Trials Engine.ini alternatives (mod 401), Borderlands 2 HDR proxy runtime (685), Borderlands 2 save variants (684), and a Borderlands 3 mixed save/hotfix archive (555). They are not counted as installed or supported automatic installs.

- Added dependency-gated Oak SDK .sdkmod and authored pyproject.toml folder routes for Borderlands 3 and Wonderlands, based on https://bl-sdk.github.io/oak-mod-db/ and a downloaded official bl3-sdk.zip runtime inventory. Shared runtime/proxy DLLs remain blocked from plugin routing.
- Matching Oak plugin .ini companions retain their plugin destination. Unrelated INI files remain blocked.
- PAYDAY: The Heist raw asset trees retain the package name and units/guis structure, gated by DINPUT8.dll and PDTHModOverrides.dll. Authored assets/mod_overrides trees are preserved without duplicate prefixes.
- Corrected legacy PDTH BLT detection to its documented IPHLPAPI.dll proxy and added its verified GitHub dependency link: https://github.com/simon-wh/Payday-The-Heist-BLT .
- Added content-aware OpenBLCMM, legacy PDMod conversion, and mixed PDTH Mod Organizer 2 handoffs. Each writes human-readable import instructions. Saves are never classified as BLCMM patches. REFramework proxy archives are labeled runtime review, not Fluffy asset imports.
- Wonderlands PAK destination is OakGame/Content/Paks, verified against the mod author's installation instructions: https://www.nexusmods.com/tinytinaswonderlands/mods/90 .
- External archives now extract once per install transaction instead of once per file. Short, unique extraction directory names avoid the observed long-filename temporary-directory failure.
- Blocked staged packages now show their warnings in the download result instead of only showing archive type/size.
- 52 ordinary Rust tests passed. Backend PNG/JPEG/WebP imports were hash-verified; pasted WebP data was byte-verified. Draft persistence, overwrite backup, malformed-draft preservation, and per-game mod-profile selection passed in a fresh isolated app-data root.
- Native Choose Image opened successfully with supported file filters. Completing selection through the computer-use helper failed because the returned owned-dialog accessibility indexes were unavailable to input; this is not claimed as a passed end-to-end picker test. The isolated test app was closed afterward.
- Artwork/workflow evidence: src-tauri/target/profile-smoke/workflow-20261009-103759/workflow-persistence-report.json.
- Frontend build, source/profile self-tests, UI viewport tests, cargo check, release build, and diff check passed.

Current installed executable SHA-256: 8E7604B99E3AAD7DAE806F90CEA9D5905B4654AE272DF53645F062AFBD322EDD.

Current backup: tsukimodmanagerapp.exe.before-format-completion-20261009-104257.bak.

The installed release was reopened and verified rendering from http://tauri.localhost/, not the Vite development server.

Real-game installs/launches and actual external-manager activation still require the user's testing-scope decision. All test game writes remain isolated. Save replacement and alternative user configs require an explicit target/variant choice; the manager does not guess these destinations or overwrite user saves.

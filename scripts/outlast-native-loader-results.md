# Native PAK Integration Results

## Implemented

- Signed external release manager: HTTPS host restrictions, pinned Ed25519 public key, bounded ZIP/member verification, SHA-256, source/debug exclusions and Windows-safe paths.
- Profile initialization, disclosure/authorization, automatic setup, offline Retry, Repair, optional Update and Remove Loader, using existing sidebar task progress.
- Asynchronous pre-launch apply/restore and existing profile-owned PAK receipt selection. Dependency diagnostics include the managed backend.
- A distinct managed-loader receipt using Tsuki's existing schema, outside normal user-mod enumeration.
- Cross-process locks, verified staging, runtime-directory replacement, journal recovery and refusal to overwrite unknown files. Repairs/removal preserve source mods and archive recovery records.
- Private headless adapter and optimized standalone compiled backend; no source or binary added to Tsuki's base resources.

## Files

Public workspace additions: `src-tauri/src/managed_loaders.rs`, `src-tauri/managed-loader-release.json`, `src/components/ManagedLoaderStatus.tsx`, companion CSS, packaging helper, UI preview/test and integration/results documents. Existing changes: `Cargo.toml`, `Cargo.lock`, `lib.rs`, `profile_installs.rs`, `App.tsx`.

Private build workspace: `C:\Users\jeffe\Documents\TsukiPrivateLoaderBuild`. The original loader remains in the installed game's private local source folder. Neither location has been pushed to a remote repository.

Validated backend: `compiled-release/tsuki_outlast_backend.dist/TsukiOutlastLoader.exe` under the private workspace.
Executable SHA-256: `7cd61f6c744e5405def5425f8bd6fd09a10de6fc683835e176d50abec0b1bcdc`.
Only compiled EXE/DLL/PYD and license/data text files are packaged; no Python/C source, PDB or private keys.

## Verification

| Check | Result |
|---|---|
| Original loader unit tests | 36 passed |
| Tsuki Rust unit tests | 64 passed, 7 existing opt-in tests ignored |
| New signed runtime/recovery tests | 10 passed, included above |
| Managed loader desktop/mobile UI scenarios | 12 passed |
| Release packaging/signature/source-exclusion tests | Passed against fixture and actual compiled runtime |
| Compiled backend generated-game lifecycle | Apply, status, disable, enable, restore, game update and mod removal passed; original PAK restored byte-for-byte |
| Compiled backend against real installed game | Read-only status passed: applied, 41 active mods, sources current; runtimeVerified=false |
| Frontend production build | Passed |
| cargo check | Passed; existing dead-code warnings remain |
| Optimized Tsuki release build | Passed |
| git diff --check | Passed; existing CRLF normalization warnings only |

The compiler initially failed during startup because a module named `loader` collides with a generated local C variable named `module_loader`. The private build copies that module under the name `tsuki_loader_core` without changing its logic. Nuitka 2.8.10, Python 3.12.7, MSVC 14.3, link-time optimization and removed docstrings produced the validated backend. Failed diagnostic builds are not release candidates.

## Release Preparation Follow-up (2026-10-10)

The owner selected `Itsukiomo/OutlastTrialsNativePakLoader`. Release v1.0.0 assets are prepared in `C:\Users\jeffe\Downloads\Honk\OutlastTrialsNativePakLoader-v1.0.0`: compiled runtime ZIP, `manifest.json`, `manifest.sig`, upload instructions and release notes. A production Ed25519 key was generated locally with Windows account-restricted access outside the public repository and upload directory. Tsuki now pins its public key and selected repository.

The actual signed release ZIP passed Tsuki's signature, member hash, extraction and receipt validation in an isolated temporary game directory. Publication and public-download verification are recorded below. The private source repository and gameplay validation still remain separate work.

The updated Tsuki release executable was installed on 2026-10-10 with an executable backup, graceful restart, matching source/destination hashes and a responding process. Installed executable SHA-256: `99161d0f0e1402d8c59b1586cec82ab09cd305b0615ddcc50be144b9b0d502e7`.

## Release Publication (2026-10-10)

At the owner's request, created the public binary-release repository and published the stable latest release: https://github.com/Itsukiomo/OutlastTrialsNativePakLoader/releases/tag/v1.0.0.

Published exactly three assets: `outlast-native-pak-win64.zip`, `manifest.json`, and `manifest.sig`. Release notes describe the validation limits. No private source, signing key, local upload instructions, game data or mods were uploaded.

Downloaded both manifest assets through the public `releases/latest/download` URLs and the ZIP through its signed version-specific URL. The downloaded bundle passed `managed_loaders::tests::prepared_release_bundle` using Tsuki's production trust configuration: signature, archive/member hashes, sandbox extraction and receipt validation. This verifies the public download artifacts, not the complete production first-use UI flow or in-game behavior.

## Initial Configuration and Limits

At the initial integration handoff, no dedicated binary-release repository existed in the signed-in account and production release configuration was empty. The follow-up above records the owner's selected repository and production key preparation. Test-only deterministic keys are not production trust anchors and are never installed into the shipping configuration.

At that initial handoff, real GitHub download/update and a production first-use install remained unverified, and the newly built app had not yet replaced the installed executable. The follow-ups above supersede the configuration, publication and executable-installation status. The complete production first-use UI flow and future update flow remain unverified.

This run did not launch Outlast Trials or enter online gameplay. Read-only installed-game status proves file/deployment recognition, not visible mod effects, loader acceptance by the game's protection systems, future-version compatibility or account safety. Existing game files were not changed by the real-installation check.

Binary compilation does not prevent reverse engineering or redistribution. Encryption with an embedded shared key was not added; no such key would remain secret. Commercial obfuscation and Authenticode signing are not implemented. Review third-party redistribution terms and Nexus policy separately before publication.

See `outlast-native-loader-integration.md` for release asset names, trust configuration, private build workflow, recovery behavior and update policy.

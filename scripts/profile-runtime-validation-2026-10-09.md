# Profile Runtime Validation - 2026-10-09

## Scope And Evidence

Fresh run: `src-tauri/target/profile-smoke/2026-10-10T01-04-19-127Z`.
All 16 built-in profiles and their 20 API source configurations were probed.
PAYDAY 3 was tested as UE5.5 only. Cyberpunk received sample in-app downloads, not bulk indexing.

- `report.json`: live provider selection, downloaded archive hashes, extracted content hashes and routes.
- `recheck-report.json`: 37 downloaded packages tested again against the final backend.
- `real-game-inventory.json`: read-only detection using Tsuki's installation detector.
- `real-deployment-builtin.payday2.json` and `real-deployment-builtin.payday3.json`: explicit deployment destinations, receipts and successful restoration.
- `payday3-runtime-ue4ss.log`: retained real-game log from the authorized launch.

Results: 16 full install/disable/enable/uninstall passes, 16 verified external-manager handoffs, and 5 unsupported packages. A handoff is NOT an installed or runtime-verified mod. Unsupported packages remain blocked rather than being copied into guessed destinations.

## Per-Profile Results

Numbers below count downloaded packages, not every mod on the provider.

| Profile | Receipt Lifecycle Passes | Handoff Passes | Unsupported | Runtime |
| --- | ---: | ---: | ---: | --- |
| Cyberpunk 2077 | 1 | 0 | 0 | Not installed |
| The Outlast Trials | 1 | 0 | 1 | Deferred; mod restriction risk |
| PAYDAY: The Heist | 2 | 2 | 0 | Not installed |
| PAYDAY 2 | 2 | 0 | 2 | Main menu reached; incompatible existing loader |
| PAYDAY 3 UE5.5 | 2 | 0 | 0 | Modded main menu reached; sample appearance not verified |
| Resident Evil 7 | 1 | 2 | 0 | Not installed |
| Resident Evil Village | 1 | 0 | 0 | Not installed |
| Resident Evil Requiem | 1 | 2 | 0 | Not installed |
| Borderlands / Enhanced | 2 | 0 | 0 | Not installed |
| Borderlands 2 | 0 | 1 | 2 | Not installed |
| Borderlands 3 | 1 | 0 | 0 | Not installed |
| Borderlands 4 | 1 | 0 | 0 | Not installed |
| Tiny Tina's Wonderlands | 1 | 0 | 0 | Not installed |
| Spider-Man Remastered | 0 | 3 | 0 | Not installed |
| Spider-Man 2 | 0 | 3 | 0 | Folder remnants only; no executable |
| Monster Hunter Wilds | 0 | 3 | 0 | Folder remnants only; no executable |

External activation inside Overstrike, Fluffy or other managers was not verified. The handoff tests verify package integrity, correct manager/profile metadata, false installed state, and rejection of foreign-profile paths.

Unsupported sample classes: Outlast user-config Engine.ini variants; two PAYDAY 2 standalone BeardLib music packages; Borderlands 2 HDR proxy and save packages. These need dedicated workflows or explicit manual/external-manager installation. This report does not claim universal archive support.

## Real-Game Phase

Only three profiles were positively detected as installed. No game executables, save files, existing mod payloads or shared loader DLLs were replaced.

PAYDAY 3:
- Cosmetic ModWorkshop sample 59445, file 104370, installed through the production backend.
- All 21 PAK/UTOC/UCAS files matched their receipt hashes.
- Existing destinations were required to be absent; the test refused to overwrite mods.
- Both possible loader mods.txt manifests were narrowly backed up before deployment.
- Steam launch reached the existing YOLO UI main menu; the real log confirms engine version 5.5.
- Existing AllowModsMod reported `Delegate not found. Unable to patch.` This is a runtime warning, not successful dependency activation.
- CAR-4 sample appearance was not established. No online match or equipment changes were performed.
- Game closed; sample files uninstalled; original manifests restored with matching SHA-256 hashes.

PAYDAY 2:
- ModWorkshop sample 58117 installed through the production profile backend; its seven files matched receipt hashes.
- Game reached its main menu without starting a match.
- Existing PAYDAY2.exe is PE machine 0x8664 (64-bit), while WSOCK32.dll is 0x014c (32-bit).
- No fresh SuperBLT log or sample activation was established. The loader was not replaced.
- Game closed and the sample removed. Restoration verified.

Outlast Trials:
- Kept in the sandbox. The sampled author's page warns about newer mod restrictions; launching with another mod was deferred to avoid account risk.
- This is not a claim that every mod is prohibited or that the sampled archive is compatible with the installed build.
- Author source: https://www.nexusmods.com/theoutlasttrials/mods/376

## Fixes And Verification

- Added content-preserving REFramework image asset routes under `reframework/images`, with regression coverage.
- PAYDAY 2 dependency detection now rejects a SuperBLT DLL whose PE machine does not match a recognized game executable. Invalid DLLs are rejected when executable architecture is known.
- Removed UE4 from the live-download smoke run and added freshly checked explicit UE5 Nexus candidates.
- PAYDAY 3 downloaded samples now pass production receipt lifecycle checks with the real current UE5 loader archive, not just a routing simulation. Current ModWorkshop UE5 loader file 102150 was rechecked via its API.
- Added an opt-in, isolated-appdata real-game deployment/restoration harness with no-overwrite boundaries and pre-write manifests.

Passed: 54 Rust unit tests; 10 workflow/source/dependency/index regression scripts; 30 UI viewport/theme checks; final 37-package receipt/handoff recheck; isolated artwork/draft/mod-profile persistence; separate UE5 loader/Lua/PAK receipt lifecycle; npm production build; cargo check; release build; git diff --check (line-ending notices only).

Installed executable: `C:/Users/jeffe/AppData/Local/Tsuki Mod Manager/tsukimodmanagerapp.exe`.
SHA-256: `1640334556650D2203097241C7719DD9C436389811B98A43D0E14662EBA8389C`.
Previous executable backup: `.before-runtime-verification-20261009-182022.bak`.
Restarted process 39004 was responding after deployment.

The all-games archive-index worker remains in `downloading-and-hashing`; it is not claimed complete.
Remaining runtime verification requires compatible local loaders, an uninterrupted game view, installed copies of the missing games, and actual external-manager activation where applicable.

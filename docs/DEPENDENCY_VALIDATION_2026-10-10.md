# Dependency And Profile Validation

## Requirements UI

The file picker now shows live forward source requirements with names,
thumbnails where supplied by the source, author notes, Required/Optional labels,
source links and game-scoped setup actions. Parent frameworks are expanded and
deduplicated. Single-file installs, updates and individual file actions open
the same picker. Installation waits for the lookup to finish. Failures show
Retry rather than reporting that the mod has no dependencies.

Live ModWorkshop BeardLib metadata returned its SuperBLT requirement with its
thumbnail. Live Nexus Equipment-EX returned ArchiveXL, Codeware, RED4ext,
redscript and TweakXL; all five names and thumbnails resolved. Nexus returns
blank requirement URLs, so these are constructed from verified game identities.
Cross-game requirements retain their own domain. Dependency record IDs are not
mistaken for mod IDs, and lookalike source URL hosts are rejected.

## Tests

- Rust: 83 passed, nine opt-in tests skipped in the regular suite.
- Live source-requirement test: passed separately.
- Requirement cards: desktop/mobile layout, loaded images, required/optional,
  parent deduplication, profile forwarding, loading and error/retry passed.
- Packaged Nexus picker: real requirements region, newest main selection and
  Install enabled after lookup passed in isolated app data.
- Dependency links, actions, graph/parser, profile workflow/version/runtime,
  source file selection/authentication and installed presence tests passed.
- npm build, cargo check, NSIS build and git diff --check passed.
- Clean NSIS install and real 1.8.2 upgrade preserved settings and WebView data.

## Real Archives In Simulated Games

All 16 game profiles and 20 source mappings were probed. 37 archives were
downloaded, hashed and rechecked against the production routing and receipt
commands in isolated game folders. PAYDAY 3 used UE5.5 only.

| Profile | Receipt Lifecycle | Manager Handoff | Unsupported |
| --- | ---: | ---: | ---: |
| Borderlands (classic/enhanced) | 2 | 0 | 0 |
| Borderlands 2 | 0 | 1 | 2 |
| Borderlands 3 | 1 | 0 | 0 |
| Borderlands 4 | 1 | 0 | 0 |
| Cyberpunk 2077 | 1 | 0 | 1 |
| Monster Hunter Wilds | 2 | 1 | 0 |
| The Outlast Trials | 1 | 0 | 1 |
| PAYDAY: The Heist | 2 | 2 | 0 |
| PAYDAY 2 | 2 | 0 | 0 |
| PAYDAY 3 UE5 | 2 | 0 | 0 |
| Resident Evil 7 | 1 | 2 | 0 |
| Resident Evil Village | 1 | 2 | 0 |
| Resident Evil Requiem | 1 | 1 | 0 |
| Spider-Man Remastered | 0 | 3 | 0 |
| Spider-Man 2 | 0 | 3 | 0 |
| Tiny Tina's Wonderlands | 1 | 0 | 0 |
| Total | 18 | 15 | 4 |

Receipt lifecycle means install, disable, enable, hash comparison and uninstall.
Manager handoffs preserve and hash the package, validate profile isolation and
do not pretend the external manager has activated it.

Remaining blocked samples: Cyberpunk NightCityHaptics companion executables,
Outlast alternative Engine.ini packages, Borderlands 2 HDR proxy DLL, and a
Borderlands 2 save bundle. These require explicit/manual workflows, not guessed
destinations. Some source files were quarantined/unavailable or too large for
the bounded smoke test; those errors were recorded, not bypassed.

Detailed evidence is in
`src-tauri/target/profile-smoke/2026-10-10T17-35-28-367Z/report.json` and
`recheck-report.json`. Installer evidence is in
`D:/TsukiReleaseQualification/installer-20261010-104925/installer-report.json`.
Packaged picker evidence is in
`D:/TsukiReleaseQualification/nexus-download-live-1791654524455/report.json`.

## Deployment And Limits

The installed app was replaced only after backing up its executable. New SHA-256:
`51622BE4B9E29231EC5C9A6F5DC12B0C90A75A79118B480EC144F4E7A5DCB86C`.
The restarted app was responding. No real-game files were modified in this run.

These tests do not establish in-game compatibility for every profile or mod.
DLC, unknown requirement recipes, legacy loaders and manager-only formats
remain explicit review/setup boundaries. API requirements can omit dependencies
listed only in an author's description. The earlier Loona LAS test established
menu registration of nine variants, not visual/heist correctness. No new
GitHub release was published in this run.

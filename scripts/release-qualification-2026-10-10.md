# Tsuki 2.0 Release Qualification - 2026-10-10

## Artifact

Prepared folder: `C:\Users\jeffe\Downloads\Honk\TsukiModManager-v2.0.0`.

Installer: `Tsuki.Mod.Manager_2.0.0_x64-setup.exe` (18,117,006 bytes; rebuilt with the Installed performance and aligned full-cover profile-card layout follow-ups).
SHA-256: `fa7afe149c7df04e8c999afef4fef3b65ba43d2b5e5ea1c6cf83125153357017`.

The folder also contains the portable application ZIP, `latest.json`, release notes and generated file checksums. Only the explicitly selected application executable and release notes are included in the portable ZIP. No API keys, app data, game mods, proprietary Outlast source or Outlast runtime payload are included. The Windows installer is not Authenticode-signed. This run did not publish Tsuki 2.0 or change the public updater manifest.

## Completed Checks

| Check | Result |
| --- | --- |
| Frontend production build and NSIS bundle | Passed |
| Rust release tests | 67 passed; 8 opt-in tests ignored; source-index sandbox also passed separately |
| Cargo release check | Passed; existing dead-code warnings |
| Workflow, encoding, versions, runtime, source-auth, dependency links, dependency graph, source-file selection, interrupted-index retry, installed presence, trending slots | 12 final script runs passed |
| Source-index isolated hash-identification test | Passed earlier in this turn |
| Downloaded archive lifecycle/handoff recheck | 37 packages rechecked earlier in this turn |
| UI layout/theme tests | 30 cases passed |
| Featured carousel | Three viewports passed; secondary cards remain stable |
| Managed-loader UI states | 12 mocked scenarios passed |
| Actual clean NSIS install | Passed, registered version 2.0.0 |
| Actual 1.8.2 NSIS upgrade | Passed; settings and WebView storage preserved |
| Packaged Outlast UI | Consent, public download, signature/hash verification, intact reopen, repair and signed update passed in simulated game |
| Packaged navigation | Installed, Profiles, Backups, Settings and Home passed without captured frontend exceptions |
| Native PAYDAY 3 dependency diagnostics | Recorded AllowModsMod patch failure surfaced correctly |
| PAYDAY 2 current official x64 runtime | Fresh temporary Lua startup probe loaded; original loader/base restored and hashed |
| Git diff whitespace check | Passed; CRLF normalization notices only |

Installer checks use isolated application/browser storage and explicit test install directories. The two existing Windows installer-registration keys were exported before testing and restored afterward. Existing application executable hashes were unchanged by installer qualification.

## Evidence

Final installer report and clean/upgrade screenshots:
`D:\TsukiReleaseQualification\final\installer-20261010-054724`.

Final packaged Outlast report:
`D:\TsukiReleaseQualification\final\loader-1791636641953\loader-report.json`.

Final packaged navigation report:
`D:\TsukiReleaseQualification\final\ui-1791636742534\ui-report.json`.

PAYDAY 2 deployment/restoration manifest and fresh runtime log:
`D:\TsukiReleaseQualification\payday2-runtime-20261010`.

Earlier generated qualification artifacts were relocated from the workspace target directory to `D:\TsukiReleaseQualification\20261010-qualification` after C: reached approximately 40 MB free. Original report paths describe their locations at execution time. Game folders, application data, mods and pre-existing backups were not moved by that relocation.

## Fixes

- Replaced the stale native updater version `1.8.3` with the Cargo package version; added regression coverage.
- Populated `latest.json` with the final installer checksum and current release description.
- Removed the stale sidebar release slogan.
- Added bounded recent-log diagnostics for AllowModsMod failure without treating file detection as successful activation or modifying third-party binaries.
- Added repeatable native-app, actual-installer and reversible PAYDAY 2 startup-probe harnesses.
- Updated the public README and added release notes describing actual supported workflows and limits.

## Local Deployment

Updated local executable after graceful app closure; source/destination SHA-256 matched:
`f77cc846378e1d15d8718e85cff6a8c2e5684c3540d59ed2d56fb258cc574b3b`.

Backup: `C:\Users\jeffe\AppData\Local\Tsuki Mod Manager\tsukimodmanagerapp.exe.before-release-qualification-20261010-055312.bak`.
Restarted PID 41712 was responding.

## Installed Performance Follow-Up

The rebuilt candidate keeps live filesystem reconciliation and exact SHA-256 source identification. Source lookup now groups proofs and receipts by source/mod identity rather than repeatedly searching the full catalog. UE5 archive eligibility still requires the verified engine policy and exact catalog file ID; only the lookup algorithm changed. Source Index storage format is unchanged.

Installed no longer transfers the whole source catalog into React during ordinary loading. Disk-validated receipt cards render before exact identification finishes. Initial scanning begins as soon as the profile runtime is ready. Old page requests cannot update loading progress after unmount. Card rendering is incremental (48 initially, then Show More); search, totals and Select Filtered cover the entire library. Automatic metadata hydration targets displayed cards only. Existing real toggle/batch commands are unchanged.

Final packaged test used 40,000 source records and 1,000 actual generated payload files, not mocked scan responses:

| Measurement | Previous package | Final package |
| --- | --- | --- |
| First indexed card after opening Installed | 80.00 s | 1.25 s |
| Cold exact identification | 5.85 s | 3.12 s |
| Warm exact identification, two runs | 3.49 / 3.34 s | 0.58 / 0.54 s |

These are local stress-fixture observations, not guaranteed timings for every game. The previous package became unresponsive during subsequent UI inspection and its baseline harness did not complete; the measured times above were captured before that failure. The final package completed all checks with no captured frontend exceptions.

Reliability checks passed for exact payload matches, shared-hash ambiguity exclusion, Nexus game identity, external removal, same-size changed contents with changed modification time, disabled-live receipt handling, missing receipt handling, 48/96-card rendering, searching an initially unrendered card, bulk selecting all 998 filtered cards, and cached-page reopening removing another externally deleted file.

Final performance report and screenshot:
`D:\TsukiReleaseQualification\installed-performance-final\performance-1791638079245`.

Previous-package baseline:
`D:\TsukiReleaseQualification\installed-performance\performance-1791637759434\performance-report.json`.

Final rebuilt installer clean/upgrade report:
`D:\TsukiReleaseQualification\installed-performance-final\installer-20261010-061400\installer-report.json`.
Original application registration was restored and the existing executable was unchanged during qualification. Rust release suite: 67 passed, eight opt-in tests ignored; isolated source-index identification was additionally run and passed. Frontend build, Cargo release check, installed-presence, source-file selection, source authentication and diff checks passed.

Updated executable SHA-256:
`defe492be3db1cb1e14eadb436e18ff3ec28b8d4888cca0e739116bd636c46a9`.
Deployed after graceful app closure, with source/destination hashes matching; restarted PID 32316 was responding. Previous executable retained at `C:\Users\jeffe\AppData\Local\Tsuki Mod Manager\tsukimodmanagerapp.exe.before-installed-performance-20261010-061547.bak`.

## Remaining Limits

### Profile Card Layout Follow-Up

The final layout lowers the title and metadata into an equal-height 116-pixel translucent footer. The separate version label is removed; the selector retains its accessible name. Title baselines and metadata rows align, including wrapped names. The cover fills each card and the compact game-version control remains contained without changing card size.

The actual React component passed dimension, metadata alignment, control containment and overflow checks at 1500, 1100, 800 and 390 pixels, switching UE4/UE5 at each width. The rebuilt native application passed equal-height cards, full-cover dimensions, contained controls, persisted UE4/UE5 selection and no captured frontend exceptions. Report and genuine app screenshot: `D:\TsukiReleaseQualification\profile-card-layout-native\profile-layout-1791639766479`. Frontend and NSIS builds passed; existing Rust dead-code warnings remain. Earlier clean/upgrade and performance evidence above applies to the preceding performance package, not a fresh installer run of this CSS follow-up.

Final executable SHA-256: `9d7dd4f0cbbb6d5d033649b6935fb2da1aaf4913191e7f5e218cbc9cb1845dd2`.

### Final Public Package Gate

The exact final installer above subsequently passed clean NSIS installation, native 2.0.0 startup, Windows version registration, and an actual 1.8.2 installer upgrade preserving settings and WebView storage. Existing application registration was restored and the user's installed executable was unchanged. Report: `D:\TsukiReleaseQualification\public-2.0-final\installer-20261010-064651\installer-report.json`.

Requested delivery folder: `C:\Users\jeffe\OneDrive\Documents\AutoHotkey\Honk`. The installer-only ZIP contains the final NSIS installer and release notes; the separately named portable ZIP contains the application executable and release notes. No personal app data or separately distributed loader backend is included.

This is a qualified release candidate with documented limits, not universal in-game certification. PAYDAY 3's installed UE5 DLLs match the current official beta release, but its latest recorded AllowModsMod session cannot patch the tested game build. A Tsuki-side reinstall is not a proven fix. Its warning remains disclosed rather than reported as success.

Missing games and real external-manager activation cannot be verified on this machine without those installations. Archive-routing and handoff tests are not substituted for gameplay or import/activation proof. Outlast tests did not enter online play or establish protection-system acceptance.

Bulk indexing remains incomplete: the last saved job contains 42,639 catalog records, 6,031 hashed archives and 187,957 hashed files and stopped at the index-storage reserve. Unavailable archives and unverified PAYDAY history are excluded from completion claims. The owner was asked for additional index storage; this run did not silently relocate app data or restart a multi-hour bulk job.

Publish `RELEASE_NOTES_2.0.0.md` alongside any public release and retain these distinctions. Do not advertise every profile as game-tested or every archive as indexed.

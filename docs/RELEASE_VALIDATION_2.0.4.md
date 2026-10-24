# Release 2.0.4 And Native Runtime 1.0.3 Validation

## Cause And Recovery

On 2026-10-24 Steam reported Outlast's target build 25886771 pending over installed build 25334040. Its log recorded failure to preallocate approximately 59.43 GiB because of insufficient disk space. The existing runtime still recognized the installed old build; that did not mean the game could launch through Steam with the mandatory update incomplete.

The owner authorized deleting verified obsolete generated Tsuki staging data only. 31 inactive append stages (44,207,308,195 bytes) were removed after copying their manifests. The active stage, recent retained stage, original-index/movie backups, source mods and recovery records were preserved. 52 source files were recorded and subsequently hash-checked unchanged. The baseline archive was restored while Steam was paused, then Steam resumed its normal update. Staging and download activity were observed; target-build gameplay is not yet verified.

Audit files are under `D:/TsukiReleaseQualification/outlast-update-20261024`. No game executable, protection component or save was patched. Steam itself supplies the updated game files.

## Runtime And Channel

- 43 private source tests passed. Compiled PAK/movie lifecycle checks passed, including update-pending rejection without selection/archive mutation, paused-update restoration, busy-update refusal, incomplete-archive status and completed-update handling.
- Runtime 1.0.3 was compiled and signed with the existing pinned Ed25519 key. Production signature/archive/payload qualification passed for the public-channel manifest. The archive SHA-256 is `74b20f776f2ffa07241d23e1a9579530ccb9dfdd4bc6fe16b9ce6b0402e2da2f`.
- The former release repository was private, producing anonymous 404 responses. The owner elected to keep it private and use a neutrally named public compiled-release channel. The new channel is `Itsukiomo/runtime-channel-7f3a`; only compiled payloads, licenses and signed metadata are distributed. The URL and public content remain discoverable.
- Existing signed local receipts may migrate from the former channel using the same pinned key. Remote manifests remain restricted to the new channel. The added test rejects modified signatures and unrelated repositories.
- Actual packaged in-app Update upgraded the real signed runtime from 1.0.2 to public-channel 1.0.3 and verified every installed payload. Report: `D:/TsukiReleaseQualification/outlast-update-20261024/public-update-1792861261667/report.json`. An earlier trial encountered the private-channel 404; another trial was interrupted by simultaneous installer qualification. The isolated sequential rerun passed.

## App And Installer

- Rust suite: 93 passed, 11 opt-in checks ignored. Profile workflow regression and frontend/Tauri production builds passed. Existing dead-code warnings remain.
- The exact 2.0.4 installer passed clean installation and an actual 1.8.2 upgrade preserving settings/WebView storage, native/sidebar version checks, large Windows taskbar-icon readback and no captured frontend exceptions. Report: `D:/TsukiReleaseQualification/public-2.0.4-final/installer-20261024-095851/installer-report.json`.
- Local app upgraded through the qualified installer, retaining an executable backup. Its installed executable matches the qualified clean-install payload SHA-256 `3b9df87d693c655f49e35efd529f26e7bf998a824ead73ae27ccb0842056302f`.
- Installer SHA-256: `eef4c4b6a9c1211cc75dca0ebc0085a663f1045d32dc7dbe1b327740ed4a2cf6`. The installer-only ZIP was copied and hash-verified in the owner's specified Honk folder.

The game update must complete before the new build can be tested with the selected mods. No universal mod compatibility, successful new-build gameplay or completed catalog qualification is claimed. The Windows installer is not Authenticode-signed.

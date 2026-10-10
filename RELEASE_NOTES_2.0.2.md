# Tsuki Mod Manager 2.0.2

- Add live Nexus and ModWorkshop requirement rows to the download file picker, with names, source thumbnails, Required/Optional labels, parent frameworks and game-scoped setup actions.
- Resolve Nexus requirement game IDs into canonical source links; preserve ModWorkshop linked-mod identity and thumbnails instead of treating dependency row IDs as mod IDs.
- Wait for requirements before enabling file installation; show lookup failures and a retry action.
- Recognize manager cover/screenshot metadata alongside modinfo.ini without blocking otherwise supported REFramework scripts. External-manager asset formats remain separate handoffs.

Latest validation (2026-10-10): 83 Rust unit tests passed; live ModWorkshop and Nexus requirement metadata passed, including thumbnails. Desktop/mobile requirements UI, error/retry, profile-scoped actions and the packaged Nexus file picker passed. All 16 profiles and 20 source mappings were probed, downloading and hashing 37 archives. Current routing recheck: 18 install/disable/enable/uninstall cases, 15 external-manager handoffs, and four intentionally unsupported packages. Clean installation and actual 1.8.2 upgrade preserved settings and WebView storage. These are sandbox/deployment checks, not universal in-game proof.

- Fix dependency action buttons passing a missing game-profile ID, including file pickers and setup screens.
- Add hash-verified downloads for standalone mod tools, kept separate from game installations; large tools stream to disk with a 2 GiB bound.
- Install REFramework before CatLib even when CatLib is selected independently.
- Verify Loona LAS registration with all nine variations in current 64-bit PAYDAY 2; restore all temporary test files. Visual/heist compatibility remains unverified, and LAS retains an upstream missing-hook warning.

Nexus file-list and download-routing hotfix.

Profile dependency setup:

- Install required, approved frameworks before an in-app mod installation, with profile-specific Ask/Automatic/Off settings and an Install / Update action.
- Resolve parent requirements first, including PAYDAY 2 SuperBLT basemod, SuperBLT, BeardLib and Legendary Armour Skins for LAS packages.
- Parse BeardLib manifests and preserve authored folders instead of treating every main.xml package as an asset override.
- Add exact current-game recipes for PAYDAY 3 UE5, PDTH overrides, Borderlands SDK variants, REFramework, CatLib and the catalogued Cyberpunk frameworks.
- Preserve configuration, protect other receipt-owned files, back up updates and obsolete owned files, verify native architecture and recover interrupted transactions.
- Show managed frameworks in Installed using the existing disable/enable system. Keep archives available when dependency setup requires review.
- Keep Outlast's separate signed-loader authorization and manual/external-manager boundaries intact.

Dependency validation: 28 live recipe cases across 14 simulated installation variants passed after correcting CatLib's wrapper. A fresh Loona LAS 1.1 install verified all 35 destination file hashes and installed its dependency chain. Normal Installed visibility, real disable/enable, shared removal protection and cross-game rejection were tested. Rust suite: 79 passed, eight opt-in tests skipped. The packaged Nexus UI exposed its real file picker with the newest file selected and Install enabled.

- Resolve numeric Nexus game IDs to the profile's game domain slug before requesting files or downloads. This includes cached cards and Borderlands Enhanced.
- Return canonical game domains in live mod details so reinstall and update downloads use the right endpoint.
- Report file-list HTTP failures instead of disguising them as empty file lists.
- Report download-link authorization failures directly instead of trying to download a Nexus website page as an archive.

Validation: live file lists checked for all 17 configured Nexus API sources. Real PAYDAY 3, PAYDAY 2, and Outlast archives downloaded, hashed, and inspected through the packaged app in isolated storage. Rust suite: 71 passed, eight opt-in tests skipped. Clean Windows installation and a 1.8.2-to-2.0.2 upgrade preserved settings and WebView storage.

These checks do not prove in-game compatibility for every mod. Nexus download permissions still depend on your account and the selected file; Tsuki does not bypass them. The installer is not Authenticode-signed. Existing loader and external-manager limitations remain unchanged.

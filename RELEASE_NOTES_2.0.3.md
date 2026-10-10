# Tsuki Mod Manager 2.0.3

## Fixed

- Recognize intentional empty Outlast startup replacements for `RedBarrelsLogo.bk2` and `TOT_ThirdParty.bk2` in backend 1.0.2. Keep backup/restoration and reject other empty or malformed videos. The independently signed backend is distributed through the separate OutlastTrialsNativePakLoader release.
- Prevent automatic signed-loader updates from downgrading a newer installed local fix to an older public release. Refuse a downgrade when the installed runtime needs repair.
- Launch Outlast Trials through Steam instead of directly starting its game executable. Block duplicate/running-game launches before applying PAK changes, preserve backend error details, and wait for actual game exit before restoring vanilla receipt state.
- Stage Outlast Bink movies and subtitles in package-owned loader folders. A capable signed backend backs up original movies, applies enabled replacements, and restores originals after disable or uninstall.
- Normalize Windows canonical drive and UNC paths before validating local mod destinations. Keep traversal and sibling-folder rejection while allowing legitimate local files to be disabled and restored.
- Restore Installed enable/disable actions for all game profiles, including local files. Tracked actions use exact profile/receipt ownership rather than choosing the first source-mod variant.
- Route tracked PAYDAY 3 raw-file actions through the same receipt system. Retain restore compatibility with older disabled PAK locations.
- Preserve recovery manifests when a disabled file is missing, reject restore collisions, and roll back failed file moves. Preset changes do not disable shared managed dependencies.
- Check source updates for every profile using exact file IDs, upload timestamps, file families/categories and engine compatibility. Parse ISO dates as well as numeric timestamps; preserve the original MAIN/OPTIONAL category when old files are archived.
- Check local receipt hashes, including disabled files. Modified/missing/unverified files require review; manual hash matches do not silently become automatic replacement authority.
- Download the proven newer file instead of selecting the old installed file again. Receipt-backed non-PAYDAY 3 replacements retain the previous version and restore it when installation fails. Mods that overwrite original game files remain manual-review replacements.
- Keep update caches profile-scoped. Background checks use a bounded cache; manual checks re-hash tracked files.
- Require full indexed archive payload coverage for Verified hash matching. Partial matches are Likely, shared payloads are not identity proof, and identical file variants do not invent an installed file ID.
- Use shared backend routes in the SuperBLT/REFramework Creator templates. Specific routes take priority over catch-all loose files; Unreal/REFramework/BepInEx templates no longer add an automatic root catch-all.
- Restore missing receipt-edit, managed-thumbnail and official ModWorkshop-category commands. Add an audit for every frontend Tauri command.

## Included Since 2.0.1

- Fix Nexus file-list/download requests using numeric game IDs and canonical game domains.
- Show live Nexus/ModWorkshop requirements with names, thumbnails, Required/Optional labels and profile-scoped setup actions. Wait for requirements and show lookup failures/retry.
- Install/update approved profile dependencies in dependency order, including PAYDAY 2 SuperBLT, BeardLib and Legendary Armour Skins. Preserve configuration, back up updates and protect other receipt-owned files.
- Keep standalone tool downloads and external-manager packages separate from direct game installation. Preserve Outlast's signed-loader authorization requirements.
- Recognize manager cover/screenshot metadata alongside supported REFramework scripts.

## Verification And Limits

The release validation report describes unit, UI, real-download, isolated profile lifecycle, installer and upgrade checks separately. All-profile toggle tests use simulated game directories and compare restored hashes. External-manager handoffs are not in-game installations. No universal in-game compatibility or bug-free claim is made.

Nexus account/file permissions still apply. The Windows installer is not Authenticode-signed. Unsupported companion apps, alternate configuration targets, saves and external-manager-only formats remain blocked or handed off for review.

Full-catalog Outlast testing and bulk source indexing remain incomplete. No-Intro passed a real Steam startup to the main menu and exact movie restoration; CustomUI Plus Hawk was confirmed working by the owner. These results do not certify every Outlast mod or online gameplay. The current PAYDAY 3 AllowModsMod build-compatibility warning remains applicable; automatic dependency installation cannot guarantee that an external loader supports a new game build.

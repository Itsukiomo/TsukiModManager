# Lunar Header and Installed Cards

## Implemented

- New generated transparent lunar identity, optimized 256-pixel UI asset, and native app icons. Original assets remain intact; prompt and processing are recorded in `src/assets/tsuki-lunar-logo-v2.meta.json`.
- Redesigned 58-pixel title bar with grouped glossy launch/update commands and Lucide window controls. Existing backend commands and runtime readiness checks remain unchanged.
- Shared rounded command surfaces retain semantic install/update/danger colors.
- Installed cards use a full-height image with a compact information overlay instead of the previous 140-pixel black footer. Unavailable artwork is honestly represented by a local placeholder.
- Two visible installed tags, or three browse tags, followed by a plus/count control. The full tag list opens in a viewport-positioned portal and supports Escape, outside click, focus restoration, and long labels.
- Interrupted archive downloads now retry instead of being immediately classified as permanently unavailable. Existing completed hashes are retained.

## Verified

- `npm run build`: passed.
- `cargo check`: passed with existing dead-code warnings.
- `cargo test --lib`: 53 passed, 5 ignored.
- `node scripts/source-index-self-test.mjs`: isolated installed-mod hash/receipt identification passed.
- `node scripts/source-index-errors.test.mjs`: retry classifications and attempt limits passed.
- `node scripts/ui-regression-test.mjs`: 27 viewport/theme/state cases passed, including loaded image checks, installed overlay bounds, tag dropdown placement and keyboard behavior, long title-bar names, disabled launch states, and update callbacks.
- `git diff --check`: passed; only CRLF conversion warnings.
- Release build and installed executable have identical SHA256: `5FBF127BD08E99D2C2FF4B658DDFE63C39CA96D7BD56ED545FEB5536C9589764`.

Screenshots and the UI report are under `src-tauri/target/profile-smoke/ui-verification`.

## Continuing Work

The bulk archive worker was resumed with preserved checkpoints. At verification it held 42,639 catalog records, 2,483 hashed archives, and 20,036 content hashes. Archive processing is not complete; it continues in the background with PAYDAY 3 restricted to UE5 and Cyberpunk restricted to in-app downloads. Current status is in `%APPDATA%/Tsuki Mod Manager/cache/all-games-index-job.json`.

No real games were launched and no mods were installed into real game directories during this UI verification.

## Follow-Up Polish

- Fixed tag count alignment by removing inherited badge padding/minimum height from the count and giving badges and the plus button matching 22-pixel tracks.
- Reduced the installed information overlay to 48-68 percent opacity instead of an opaque lower edge.
- Added a shared glossy On/Off control with stable 62-pixel width, distinct pressed states, disabled/busy indicators, and unchanged receipt/local-file toggle callbacks.
- Updated the actual desktop shortcut to an explicit installed lunar `.ico` file and refreshed Windows icon presentation. The original shortcut was backed up under `src-tauri/target/profile-smoke`.
- `npm run build` and all 27 UI cases passed again. Added assertions for badge/plus alignment, centered count, overlay transparency, On/Off dimensions and pressed states, and busy controls.

## All Mod Cards

- Promoted the image-led styling into the shared `ModCard.css` for Home, Browse, and Installed, removing the Installed-only stylesheet.
- Home featured cards now reuse the same card implementation, including install/open actions, tag overflow, source controls, and compact stats.
- Preserved each source's install, update, uninstall, detail, and website callbacks. Dense stats can wrap without expanding the card or hiding its actions.
- `npm run build`, `git diff --check`, and 30 UI viewport/theme/state cases passed. Added shared-card artwork/bounds checks and featured-card install keyboard checks across 1500-, 1100-, and 390-pixel viewports.

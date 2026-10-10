# Tsuki Mod Manager 2.0.1

Nexus browsing hotfix for the 2.0 multi-game release.

## Fixed

- Nexus browsing now keeps results for every configured game instead of discarding non-PAYDAY 3 mods.
- Pages consistently request 20 results, preventing skipped mods between pages.
- Next-page availability uses Nexus result counts, so filtering a few cards no longer stops pagination early.
- Previous Page remains usable at the end of a listing.
- Failed live requests report the error instead of silently substituting source-index cache results. Cached placeholders are still labeled while live requests load.
- Borderlands Enhanced uses its selected Nexus listing rather than the classic game's listing.
- Switching sources during a pending request starts the newly selected source and ignores outdated responses.

## Validation

- Live page-one and page-two requests checked across all 17 configured Nexus sources, with game-domain checks and no repeated page-one IDs on page two.
- Actual packaged PAYDAY 2 Browse UI checked with Next Page and Previous Page.
- Missing credentials reject live requests even when the source index is populated.
- Rust regression suite: 70 passed, eight opt-in tests skipped.

Nexus API browsing still requires an API key in Settings. These checks verify browsing, not every third-party mod's in-game compatibility. See [2.0 release notes](RELEASE_NOTES_2.0.0.md) for existing loader, external-manager, and indexing limitations. The Windows installer is not Authenticode-signed.

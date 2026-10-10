# Profile Dependency Setup

The download file picker loads forward requirements from each source and shows
names, thumbnails where available, Required/Optional labels, author notes,
source links, and approved setup actions. Parent frameworks are expanded once.
The installer uses the same resolved required-dependency list. API failures are
visible with Retry; absence of an API requirement is not proof that an author
has no additional requirements in their description. DLC and unknown recipes
remain manual review items, not pretend automatic installations.

Dependency setup runs before a downloaded mod is installed. The profile's Ask,
Automatic, or Off preference is respected. Automatic mode verifies managed
frameworks and checks upstream versions at most once per day; Install / Update
forces a fresh upstream check. This is not an always-running background updater.

Approved automatic recipes cover current x64 PAYDAY 2 SuperBLT (including its
basemod), BeardLib, Legendary Armour Skins; PAYDAY 3 UE5 UE4SS/AllowMods;
PAYDAY: The Heist's asset override loader; the game-specific Borderlands Python
SDKs, PluginLoader and OpenHotfixLoader; current REFramework; Monster Hunter
Wilds CatLib; and the catalogued Cyberpunk Nexus frameworks. Nexus permissions
are still required. Mod-specific requirements outside this catalog need review.

PAYDAY 2 routing preserves authored `mods`, `Maps`, and `assets/mod_overrides`
trees. Unwrapped BeardLib manifests are parsed: map definitions go to `Maps`,
asset definitions to `assets/mod_overrides`, script-only packages to `mods`.
Unrecognized manifests are blocked instead of guessing. Loona LAS requires
SuperBLT, BeardLib and Legendary Armour Skins and belongs under
`assets/mod_overrides/Loona LAS`.

Outlast Native PAK support uses its existing signed release and requires its
separate protection disclosure to be authorized. Dependency automation cannot
grant that consent. Iris, Janus, Odessa, Fluffy/Overstrike packages, REDmod DLC,
legacy PDTH BLT, old x86 PAYDAY 2 loaders, and RE7 non-RT compatibility require
their documented manual or external-manager workflow. They are not silently
replaced with another game's or architecture's runtime.

Updates validate game identity, native file architecture, HTTPS source hosts,
archive paths, expanded sizes, file ownership and destination hashes. Game
processes must be closed. Settings and user-modified files are preserved.
Unchanged obsolete owned files are backed up before removal. Interrupted
transactions are recovered before another update. Frameworks use ordinary
Installed receipts and the existing disable/enable system. Forgetting their
receipts is blocked; shared frameworks cannot be uninstalled while other mods
remain installed. Externally installed frameworks are not automatically adopted
or overwritten; Install / Update requires compatible, unchanged content.

Download, placement and hash checks do not establish in-game compatibility.
In particular, Legendary Armour Skins is an older upstream release and PAYDAY 3
AllowMods is game-build-sensitive. Runtime failures must remain visible, not be
reported as successful installs or repaired by copying the same files again.

## Standalone Tools And Runtime Checks

Iris, Janus, Odessa, Fluffy, Overstrike and OpenBLCMM have a managed
Download / Update Tool action. The newest main portable ZIP (or official
Windows OpenBLCMM asset) is saved separately from the game, checked for unsafe
paths and size limits, and SHA-256 verified. Downloads are not executions or
mod installations: users still extract/configure/import through the manager.
Official DLC and unavailable legacy loader releases remain explicit manual
requirements. Tsuki does not replace these with unrelated packages.

CatLib resolves REFramework first, including when selected on its own.

Current PAYDAY 2 Steam build 25506656 was tested with the real 64-bit game.
The read-only menu hook reported BeardLib=true, LAS=true, LoonaStyle=true,
Variations=9. All temporarily deployed files were restored from the manifest.
This confirms menu/runtime registration, not visual correctness or heist play.
LAS 4.1.9 also logs a missing upstream heist_outfits.lua hook; it did not
prevent this test from reaching a responsive menu.

# All-game source indexing

## Scope

- 15 built-in profiles receive bulk catalogs and content fingerprints.
- Cyberpunk is excluded from bulk indexing. Successful in-app source installs retain their own source identities and installed-file hashes.
- PAYDAY 3 bulk matching is UE5-only. ModWorkshop tag 97 is excluded, and unverified historical files on upgraded pages are excluded. Nexus files without explicit UE5 evidence are excluded rather than relabeled.
- Both Borderlands editions are cataloged, but Installed reads the edition matching the actual game executable.
- No mod archives are installed into real game folders by this job.

## Implementation

- `index-all-game-downloads.mjs` enumerates paginated sources, downloads eligible archives, checks archive paths/links, extracts into temporary D: scratch storage, and computes SHA-256 for their files.
- Completed archives have a crash-recoverable journal and periodic compact checkpoints. Temporary archive contents are removed after processing. Existing index files receive a backup.
- `source-index-worker.mjs` manages the long-running job, logs progress, and waits before retrying transient/provider rate-limit failures. Permanent unavailable files remain explicitly reported.
- App data: `%APPDATA%/Tsuki Mod Manager/profile-data/<profile>/source-index/`.
- Live job status: `%APPDATA%/Tsuki Mod Manager/cache/all-games-index-job.json`.
- Job log: `%APPDATA%/Tsuki Mod Manager/cache/all-games-index-worker.log`.
- Restored the missing `match_installed_source_index_v2` command used by Installed Refresh.
- Matching uses live receipts or exact, unambiguous payload hashes. Shared documentation and hashes claimed by different mods do not establish identity. Missing files do not stay installed.
- Large installed files are hashed off the UI thread by the explicit Installed refresh command.
- Existing source-index record format is preserved; content hashes and job state use separate sidecars.

## Verification

- Catalog pass completed with 42,637 indexed source records across 15 profiles.
- Archive download/content-hash work is still running. The catalog count is not an archive-completion claim.
- 53 ordinary Rust tests passed; five opt-in tests are ignored by the ordinary run.
- The isolated source-index test passed: exact hash identification, deleted-file removal, game-domain separation, and Cyberpunk in-app-only indexing.
- Frontend build and release build passed. Updated installed executable was backed up and hash-compared.
- Provider-blocked files, ambiguous PAYDAY engine versions, and transformed external-manager assets cannot be claimed as fully identified.

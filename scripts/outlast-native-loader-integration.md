# Outlast Trials Managed Native PAK Backend

## Distribution boundary

Tsuki contains the external-runtime manager, a pinned public-key configuration and UI only. The proprietary implementation is not copied into this repository, app resources or the Tsuki release archive.

Private adapter and compiler workspace: `C:\Users\jeffe\Documents\TsukiPrivateLoaderBuild`.
Existing proprietary sources remain in `D:\SteamLibrary\steamapps\common\The Outlast Trials\NativePakLoader`.
Move both into an access-controlled private source repository before collaborative publishing. Neither a private repository nor compiled binaries prevent a recipient from redistributing binaries.

The inspected implementation is a pre-launch archive append/recovery manager, not DLL injection. The adapter calls its existing apply/restore functions and never imports its GUI at runtime. Tsuki owns launches and game profiles.

## Required Release Configuration

`src-tauri/managed-loader-release.json` must contain an authorized dedicated binary-release `repository` (`owner/name`) and a base64-encoded raw 32-byte Ed25519 `publicKey`. Both are pinned at application build time, not loaded from remotely supplied manifests. Empty values fail closed. Do not use the main Tsuki release repository or create a signing key without the owner's decision.

Release assets:

```text
dedicated-repository / releases / v<loader-version>
  manifest.json
  manifest.sig
  outlast-native-pak-win64.zip
```

The signature covers the exact manifest bytes. The manifest pins the archive URL, archive length/hash, protocol, entry point and each payload path/length/hash. The initial manifest comes from GitHub's latest-release asset endpoint. Installed releases stay pinned; repair uses their signed manifest, not a forced newer release. An authenticated signed metadata cache survives interrupted archive downloads. The explicit Update action fetches a newer signed release independently of game updates; it is never forced during ordinary navigation.

Run `scripts/package-managed-loader.py` with a compiled standalone runtime, output directory outside that runtime, dedicated repository, independent loader version, and private PEM Ed25519 key outside the public repository. It rejects source/debug artifacts and prints only the public key and public hashes. Publish exactly the three assets above, with required third-party licenses inside the runtime. Never upload `.build`, `.py`, `.pyc`, `.pdb`, source archives or signing keys.

## Protection

The private build uses Nuitka standalone compilation, MSVC, link-time optimization, no docstrings, no GUI modules and no one-file executable packing. The private build copy renames `loader.py` to `tsuki_loader_core.py` to avoid a generated C variable collision with Nuitka's `module_loader`; original source and archive behavior remain unchanged. Publish only the `.dist` files after checking the payload inventory. Compiled Python retains a runtime and recoverable strings; this is a source-distribution boundary and increases reverse-engineering effort, not copy prevention or strong obfuscation. No commercial obfuscation, anti-debugging, kernel component, stealth or antivirus evasion is used.

Ed25519 signatures use `ed25519-dalek` strict verification. SHA-256 covers the ZIP and every extracted file. HTTPS is mandatory; redirects are restricted to exact GitHub/release-asset hosts. Windows traversal, device paths, alternate streams, ZIP links, duplicate paths, unknown members and excessive sizes are rejected. Runtime paths reject junctions/reparse points. Every payload is rehashed before execution, even when navigation uses a stat-based cache.

Package encryption was deliberately not added. A shared decryption key embedded in Tsuki would be recoverable and would not prevent copying an installed backend. Signatures provide authenticity without pretending encryption provides access control. Authenticode signing is still recommended when an owner-controlled code-signing certificate becomes available.

## Lifecycle and Recovery

Opening the profile checks status asynchronously. First-use authorization explicitly discloses the external GitHub download, pre-launch PAK modification and runtime/online risks. An authorized missing runtime automatically installs; offline errors leave Browse/Installed accessible, with Retry. Sidebar progress uses Tsuki's existing task indicator.

Owned destination: `<game>/NativePakLoader/ManagedRuntime`. The receipt uses Tsuki's existing `InstallReceipt` schema but stays within the managed runtime, outside user-mod receipt enumeration. User mod toggles and bulk uninstall therefore cannot disable or remove the backend.

Downloads are bounded and held in temporary memory until archive verification; extraction uses a private staging directory. Runtime-directory replacement is journaled. A previous runtime is renamed to a sibling backup, the verified staging folder becomes the runtime, and only then is the journal committed. Next status/launch/install recovers interrupted replacement. Cross-process OS file locks serialize operations and automatically release after process termination.

Repair changes only the managed runtime folder, refusing unknown extra files. It preserves `Mods`, loader selection/configuration, append backups, original indexes, user PAKs and movies. Uninstall first asks the verified backend to restore the baseline, then removes only its owned runtime and revokes automatic-download consent. Failed restore retains the runtime and all recovery data.

Before Outlast modded launch, the adapter applies the current sources. Enabled Tsuki-owned PAK receipts explicitly override stale loader selection for those files only; existing user loader selections remain intact. Disabled/uninstalled PAK files are absent from discovery. Vanilla launch restores the baseline before starting the game. PAK rebuilding and downloads use blocking-worker tasks, not the UI thread. Mods remain staged until the next launch; changing installed files does not hot-reload a running game.

Movie receipts stage `.bk2` and `.srt` under `NativePakLoader/Mods/Tsuki-<package>/Movies`, preserving authored movie-relative subtitle paths. The backend owns original movie backups and restoration, not the generic mod receipt. Enabled staged files are passed as `--managed-movie` only after a read-only status check reports the `managed-movies` capability. Older runtimes require a signed backend update before applying these receipts. Disabling or uninstalling the staging files takes effect on the next closed-game apply. MP4 files require actual Bink conversion; renaming extensions is unsupported.

The locally validated signed backend 1.0.1 introduced this capability. Version 1.0.2 is now publicly available from the dedicated release repository after the owner lifted the release hold. See `docs/RELEASE_VALIDATION_2.0.3.md` for the movie restoration and Custom UI checks.

Backend 1.0.2 additionally accepts intentional empty root movie targets `RedBarrelsLogo.bk2` and `TOT_ThirdParty.bk2`, used by No-Intro. These use the same original-file backup and restoration lifecycle as other movie replacements. Empty unrelated targets, nested names and malformed nonempty Bink files remain rejected. This signed version is publicly released and verified locally, including compiled lifecycle, real No-Intro import/toggles/restoration and a Steam launch to the main menu with both replacements active. Update compares semantic-version precedence before writing release metadata or downloading payloads and never replaces a newer installed runtime with an older release. A damaged newer runtime requires repair rather than downgrade.

## Game Update Policy

Runtime installation does not inspect or allowlist Steam builds. Loader versions are independent. The original backend's baseline/footer, source-hash, executable identity and stale-stage checks remain because they prevent applying generated data to a different archive. Those checks can require rebuilding staged data after an update, not downloading a new loader. Structural parsing or successful deployment is not proof that any particular mod renders correctly in game.

## Verification

See the accompanying task results for exact test counts and compiled-backend validation. Production auto-download cannot be verified until a real dedicated release repository and pinned public signing key are configured. Online gameplay compatibility, future game versions and Nexus distribution-policy acceptance are not guaranteed by this implementation.

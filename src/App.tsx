import "./App.css";
import { invoke } from "@tauri-apps/api/core";
import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { WindowTitleBar } from "./components/WindowTitleBar/WindowTitleBar";
import type { AppPage } from "./models/navigation";
import type { AppSettings } from "./models/settings";
import type { SourceModSummary, SourceUpdateStatus } from "./models/source";
import type { InstallReceipt } from "./models/receipt";
import { HomePage } from "./pages/Home/HomePage";
import { BrowsePage } from "./pages/Browse/BrowsePage";
import { InstalledPage } from "./pages/Installed/InstalledPage";
import { BackupsPage } from "./pages/Backups/BackupsPage";
import { SettingsPage } from "./pages/Settings/SettingsPage";


interface AppUpdateStatus {
  currentVersion: string;
  currentSemver: string;
  latestVersion?: string | null;
  updateAvailable: boolean;
  notes?: string | null;
  pubDate?: string | null;
  downloadUrl?: string | null;
  releaseUrl?: string | null;
  sha256?: string | null;
  manifestUrl?: string | null;
  checkedAtUnix: number;
  error?: string | null;
}

interface TaskProgressState {
  active: boolean;
  label: string;
  detail?: string;
  progress?: number | null;
}

interface DebugFeatureTestResult {
  name: string;
  status: "passed" | "failed" | "warning";
  detail: string;
}


class PageCrashGuard extends Component<{ pageName: string; children: ReactNode }, { error: string | null }> {
  constructor(props: { pageName: string; children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown) {
    console.error("Page crashed", this.props.pageName, error);
  }

  componentDidUpdate(previousProps: { pageName: string }) {
    if (previousProps.pageName !== this.props.pageName && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <section className="page">
          <article className="card">
            <p className="eyebrow">Page safety catch</p>
            <h1>{this.props.pageName} crashed instead of blanking the app</h1>
            <p>{this.state.error}</p>
          </article>
        </section>
      );
    }

    return this.props.children;
  }
}


const TSUKI_RECEIPT_UPDATE_CACHE_KEY = "tsuki-receipt-update-check:v1";
const TSUKI_RECEIPT_UPDATE_CHECK_THROTTLE_MS = 30 * 60 * 1000;

interface ReceiptUpdateCheckCache {
  savedAt: number;
  updates: SourceUpdateStatus[];
  checkedCount: number;
  updateCount: number;
  source: "launch" | "manual";
}

function readReceiptUpdateCheckCache(): ReceiptUpdateCheckCache | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TSUKI_RECEIPT_UPDATE_CACHE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;

    return {
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
      updates: Array.isArray(parsed.updates) ? parsed.updates : [],
      checkedCount: typeof parsed.checkedCount === "number" ? parsed.checkedCount : 0,
      updateCount: typeof parsed.updateCount === "number" ? parsed.updateCount : 0,
      source: parsed.source === "manual" ? "manual" : "launch",
    };
  } catch {
    return null;
  }
}

function writeReceiptUpdateCheckCache(updates: SourceUpdateStatus[], source: "launch" | "manual") {
  const payload: ReceiptUpdateCheckCache = {
    savedAt: Date.now(),
    updates,
    checkedCount: updates.length,
    updateCount: updates.filter((update) => update.updateAvailable).length,
    source,
  };

  try {
    window.localStorage.setItem(TSUKI_RECEIPT_UPDATE_CACHE_KEY, JSON.stringify(payload));
    window.dispatchEvent(new CustomEvent("tsuki-receipt-update-check", { detail: payload }));
  } catch {
    // Optional launch update cache.
  }
}


interface ModProfile {
  id: string;
  name: string;
  createdUnix: number;
  enabledPakFiles: string[];
  enabledReceiptIds: string[];
}

interface DependencyStatusItem {
  id: string;
  label: string;
  status: string;
  found: boolean;
  path?: string | null;
  details: string;
  recommendation: string;
}

interface DependencyReport {
  gameRoot: string;
  win64: string;
  modsFolder: string;
  items: DependencyStatusItem[];
  warnings: string[];
}

interface ReceiptRepairItem {
  receiptId: string;
  displayName: string;
  source: string;
  sourceModId?: string | null;
  installedAtUnix?: number | null;
  liveFiles: number;
  missingFiles: number;
  disabledFiles: number;
  stale: boolean;
  trackedFiles: string[];
  missingPaths: string[];
}

interface MovieValidationItem {
  receiptId: string;
  displayName: string;
  archiveOrInstalledPath: string;
  destination: string;
  exactTargetExists: boolean;
  sameFileNameMatches: string[];
  verdict: string;
}

function RepairPage() {
  const [dependencies, setDependencies] = useState<DependencyReport | null>(null);
  const [receipts, setReceipts] = useState<ReceiptRepairItem[]>([]);
  const [movies, setMovies] = useState<MovieValidationItem[]>([]);
  const [status, setStatus] = useState("Repair bay ready.");
  const [busyId, setBusyId] = useState<string | null>(null);

  const repairTsukiPairingCache = () => {
    try {
      window.localStorage.removeItem("tsuki-installed-pair-state:v0.51");
      window.localStorage.removeItem("tsuki-installed-pair-state:v0.84-proof-first");
      window.localStorage.removeItem("tsuki-installed-pair-state:v0.85-one-to-one");
      window.localStorage.removeItem("tsuki-installed-pair-state:v0.86-fast");
      window.localStorage.removeItem("tsuki-installed-pair-state:v0.87-index");
      window.localStorage.removeItem("tsuki-installed-pair-state:v0.88-auto-pair");
      window.localStorage.removeItem("tsuki-installed-pair-state:v0.88-stable");
      window.localStorage.removeItem("tsuki-rejected-pairings:v0.44");
      window.localStorage.removeItem("tsuki-rejected-pairings:v0.84-proof-first");
      window.localStorage.removeItem("tsuki-rejected-pairings:v0.85-one-to-one");
      window.localStorage.removeItem("tsuki-rejected-pairings:v0.86-fast");
      window.localStorage.removeItem("tsuki-rejected-pairings:v0.88-auto-pair");
      window.localStorage.removeItem("tsuki-rejected-pairings:v0.88-stable");
      window.localStorage.removeItem("tsuki-custom-installed-groups:v0.44");
      window.localStorage.removeItem("tsuki-custom-installed-groups:v0.84-proof-first");
      window.localStorage.removeItem("tsuki-custom-installed-groups:v0.85-one-to-one");
      window.localStorage.removeItem("tsuki-custom-installed-groups:v0.86-fast");
      window.localStorage.removeItem("tsuki-custom-installed-groups:v0.88-auto-pair");
      window.localStorage.removeItem("tsuki-custom-installed-groups:v0.88-stable");
      window.localStorage.removeItem("tsuki-installed-unpairable-groups:v0.44");
      window.localStorage.removeItem("tsuki-installed-unpairable-groups:v0.84-proof-first");
      window.localStorage.removeItem("tsuki-installed-unpairable-groups:v0.85-one-to-one");
      window.localStorage.removeItem("tsuki-installed-unpairable-groups:v0.86-fast");
      window.localStorage.removeItem("tsuki-installed-unpairable-groups:v0.88-auto-pair");
      window.localStorage.removeItem("tsuki-installed-unpairable-groups:v0.88-stable");
      setStatus("Old pairing cache/skips cleared. Open Installed and the stable auto-pair will retry without Nexus sweep spam.");
    } catch {
      setStatus("Could not clear pairing cache.");
    }
  };

  const refresh = () => {
    setBusyId("refresh-repair");
    Promise.allSettled([
      invoke<DependencyReport>("get_dependency_report"),
      invoke<ReceiptRepairItem[]>("list_receipt_repair_items"),
      invoke<MovieValidationItem[]>("validate_movie_replacer_receipts"),
    ])
      .then(([deps, receiptItems, movieItems]) => {
        if (deps.status === "fulfilled") setDependencies(deps.value);
        if (receiptItems.status === "fulfilled") setReceipts(receiptItems.value);
        if (movieItems.status === "fulfilled") setMovies(movieItems.value);

        const failed = [deps, receiptItems, movieItems].filter((result) => result.status === "rejected").length;
        setStatus(failed > 0 ? `Repair data loaded with ${failed} failed check(s).` : "Repair data refreshed.");
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusyId(null));
  };

  useEffect(() => {
    refresh();
  }, []);

  const pruneStale = () => {
    setBusyId("prune");
    invoke<string>("prune_stale_install_receipts")
      .then((message) => {
        setStatus(message);
        refresh();
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusyId(null));
  };

  const removeReceipt = (receipt: ReceiptRepairItem) => {
    setBusyId(receipt.receiptId);
    invoke<string>("remove_receipt_by_id", { receiptId: receipt.receiptId })
      .then((message) => {
        setStatus(message);
        refresh();
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusyId(null));
  };

  return (
    <section className="page repair-page">
      <div className="page-header hero-glass">
        <div>
          <p className="eyebrow">Repair bay</p>
          <h1>Fix receipts, dependencies, and movie replacers</h1>
          <p className="page-description">
            Check what Tsuki can prove from the game folders instead of trusting stale cached cards.
          </p>
        </div>
        <div className="button-row hero-actions">
          <button className="ghost-button" type="button" disabled={busyId === "refresh-repair"} onClick={refresh}>
            {busyId === "refresh-repair" ? "Refreshing..." : "Refresh checks"}
          </button>
          <button className="ghost-button danger-button" type="button" disabled={busyId === "prune"} onClick={pruneStale}>
            {busyId === "prune" ? "Cleaning..." : "Prune stale receipts"}
          </button>
          <button className="ghost-button" type="button" onClick={repairTsukiPairingCache}>
            Repair Pair Cache
          </button>
        </div>
      </div>

      <article className="card repair-status-card">
        <p className="eyebrow">Status</p>
        <h2>{status}</h2>
        <p>Use this when deleted mods still show as installed, movie replacers route weirdly, or UE4SS-style mods do not load.</p>
      </article>

      <div className="repair-grid">
        <article className="card">
          <div className="home-feed-header">
            <div>
              <p className="eyebrow">Dependency scan</p>
              <h2>UE4SS / Moolah / Logic Loader</h2>
            </div>
            <span className="badge">{dependencies?.items.filter((item) => item.found).length ?? 0} found</span>
          </div>

          <div className="managed-list">
            {dependencies?.items.map((item) => (
              <div className={`managed-row ${item.found ? "" : "disabled"}`} key={item.id}>
                <div>
                  <strong>{item.label}</strong>
                  <p>{item.details}</p>
                  <small>{item.path ?? item.recommendation}</small>
                </div>
                <span className={item.found ? "badge good" : "badge"}>{item.status}</span>
              </div>
            ))}
            {!dependencies && <p>Loading dependency scan...</p>}
          </div>

          {dependencies && dependencies.warnings.length > 0 && (
            <div className="repair-warning-list">
              {dependencies.warnings.map((warning) => <p key={warning}>⚠ {warning}</p>)}
            </div>
          )}
        </article>

        <article className="card">
          <div className="home-feed-header">
            <div>
              <p className="eyebrow">Receipts</p>
              <h2>Repair install records</h2>
            </div>
            <span className="badge">{receipts.filter((item) => item.stale).length} stale</span>
          </div>

          <div className="managed-list receipt-repair-list">
            {receipts.map((receipt) => (
              <div className={`managed-row ${receipt.stale ? "disabled" : ""}`} key={receipt.receiptId}>
                <div>
                  <strong>{receipt.displayName}</strong>
                  <p>
                    {receipt.source} #{receipt.sourceModId ?? "?"} · live {receipt.liveFiles} · disabled {receipt.disabledFiles} · missing {receipt.missingFiles}
                  </p>
                  {receipt.missingPaths.slice(0, 2).map((path) => <small key={path}>{path}</small>)}
                </div>
                <button
                  className="ghost-button compact danger-button"
                  type="button"
                  disabled={busyId === receipt.receiptId || !receipt.stale}
                  onClick={() => removeReceipt(receipt)}
                >
                  {busyId === receipt.receiptId ? "Removing..." : receipt.stale ? "Remove stale" : "Live"}
                </button>
              </div>
            ))}
            {receipts.length === 0 && <p>No install receipts found.</p>}
          </div>
        </article>
      </div>

      <article className="card movie-validator-card">
        <div className="home-feed-header">
          <div>
            <p className="eyebrow">Movie validator</p>
            <h2>Video replacer path check</h2>
          </div>
          <span className="badge">{movies.length} tracked</span>
        </div>

        <div className="managed-list">
          {movies.map((movie) => (
            <div className={`managed-row ${movie.exactTargetExists ? "" : "disabled"}`} key={`${movie.receiptId}-${movie.destination}`}>
              <div>
                <strong>{movie.displayName}</strong>
                <p>{movie.verdict}</p>
                <small>Destination: {movie.destination}</small>
                {movie.sameFileNameMatches.slice(0, 3).map((match) => <small key={match}>Same filename: {match}</small>)}
              </div>
              <span className={movie.exactTargetExists ? "badge good" : "badge"}>{movie.exactTargetExists ? "exact" : "review"}</span>
            </div>
          ))}
          {movies.length === 0 && <p>No movie/video replacer receipts found yet.</p>}
        </div>
      </article>
    </section>
  );
}


function ProfilesPage() {
  const [profiles, setProfiles] = useState<ModProfile[]>([]);
  const [profileName, setProfileName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, setStatus] = useState("Profiles ready.");
  const [folderNotice, setFolderNotice] = useState<string | null>(null);
  const [expandedProfileId, setExpandedProfileId] = useState<string | null>(null);

  const showFolderNotice = useCallback((message: string) => {
    setFolderNotice(message);
    window.setTimeout(() => {
      setFolderNotice((current) => current === message ? null : current);
    }, 2600);
  }, []);

  const refresh = useCallback(() => {
    invoke<ModProfile[]>("list_mod_profiles")
      .then((profileList) => {
        setProfiles(profileList);
        setStatus(profileList.length ? `${profileList.length} saved profile${profileList.length === 1 ? "" : "s"}.` : "No profiles saved yet.");
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const saveProfile = () => {
    const name = profileName.trim();
    setBusyId("save-profile");
    invoke<ModProfile>("save_current_mod_profile", { name: name || `Profile ${new Date().toLocaleString()}` })
      .then((profile) => {
        setStatus(`Saved profile: ${profile.name}`);
        setProfileName("");
        setExpandedProfileId(profile.id);
        refresh();
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusyId(null));
  };

  const applyProfile = (profile: ModProfile) => {
    setBusyId(`profile-${profile.id}`);
    invoke<string>("apply_mod_profile", { profileId: profile.id })
      .then((message) => {
        setStatus(message);
        refresh();
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusyId(null));
  };

  const deleteProfile = (profile: ModProfile) => {
    const confirmed = window.confirm(`Delete profile "${profile.name}"? This only removes the saved profile, not your installed mods.`);
    if (!confirmed) return;

    setBusyId(`delete-profile-${profile.id}`);
    invoke<string>("delete_mod_profile", { profileId: profile.id })
      .then((message) => {
        setStatus(message);
        setExpandedProfileId((current) => current === profile.id ? null : current);
        refresh();
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusyId(null));
  };


  const openProfilesFolder = () => {
    setBusyId("open-profiles-folder");
    invoke<string>("open_mod_profiles_folder")
      .then(() => showFolderNotice("Profiles folder opened."))
      .catch((error) => showFolderNotice(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusyId(null));
  };

  return (
    <section className="page profiles-page simple-profiles-page profiles-page-clean-v2">
      <div className="page-header clean-page-header">
        <div>
          <p className="eyebrow">Loadouts</p>
          <h1>Profiles</h1>
          <p className="page-description">Save your current enabled mods as a loadout and apply it later.</p>
        </div>
        <div className="profile-header-actions">
          <button className="ghost-button compact" type="button" onClick={openProfilesFolder} disabled={busyId === "open-profiles-folder"}>
            {busyId === "open-profiles-folder" ? "Opening..." : "Open Profiles Folder"}
          </button>
          <button className="ghost-button compact" type="button" onClick={refresh}>Refresh</button>
        </div>
      </div>

      <div className="profiles-clean-layout">
        <article className="card profile-create-panel">
          <p className="eyebrow">Create</p>
          <h2>Save current setup</h2>
          <p className="muted-inline">Profiles remember enabled PAK files and Tsuki-managed installs. Technical toggles live in Debug.</p>
          <div className="profile-save-controls profile-create-controls">
            <input
              className="setting-input"
              value={profileName}
              onChange={(event) => setProfileName(event.target.value)}
              placeholder="Example: Stealth setup"
            />
          <button className="ghost-button install-button" type="button" disabled={busyId === "save-profile"} onClick={saveProfile}>
              {busyId === "save-profile" ? "Saving..." : "Save Profile"}
            </button>
          </div>
          <small>Save your current enabled mods as a reusable loadout.</small>
        </article>

        {folderNotice && (
          <div className="profile-folder-toast" role="status" aria-live="polite">
            {folderNotice}
          </div>
        )}

        <article className="card profile-list-panel">
          <div className="home-feed-header">
            <div>
              <p className="eyebrow">Saved</p>
              <h2>Saved profiles</h2>
            </div>
            <span className="status-pill">{profiles.length} total</span>
          </div>

          {profiles.length === 0 ? (
            <div className="profile-empty-state">
              <strong>No profiles yet.</strong>
              <p>Create one from your current enabled mods.</p>
            </div>
          ) : (
            <div className="profile-list-clean">
              {profiles.map((profile) => {
                const expanded = expandedProfileId === profile.id;
                const profileBusy = busyId === `profile-${profile.id}`;
                const deleteBusy = busyId === `delete-profile-${profile.id}`;

                return (
                  <div className={`profile-row-clean ${expanded ? "expanded" : ""}`} key={profile.id}>
                    <div className="profile-row-main">
                      <div>
                        <strong>{profile.name}</strong>
                        <p>{profile.enabledPakFiles.length} PAK files · {profile.enabledReceiptIds.length} Tsuki installs</p>
                        <small>{profile.createdUnix ? new Date(profile.createdUnix * 1000).toLocaleString() : "Unknown date"}</small>
                      </div>
                      <div className="profile-row-actions">
                        <button
                          className="ghost-button compact"
                          type="button"
                          onClick={() => setExpandedProfileId(expanded ? null : profile.id)}
                        >
                          {expanded ? "Hide" : "View"}
                        </button>
                        <button
                          className="ghost-button compact install-button"
                          disabled={profileBusy || deleteBusy}
                          type="button"
                          onClick={() => applyProfile(profile)}
                        >
                          {profileBusy ? "Applying..." : "Apply"}
                        </button>
                        <button
                          className="ghost-button compact danger"
                          disabled={profileBusy || deleteBusy}
                          type="button"
                          onClick={() => deleteProfile(profile)}
                        >
                          {deleteBusy ? "Deleting..." : "Delete"}
                        </button>
                      </div>
                    </div>
                    {expanded && (
                      <div className="profile-detail-panel profile-detail-card-view">
                        <div className="profile-detail-summary">
                          <div>
                            <span>Saved</span>
                            <strong>{profile.createdUnix ? new Date(profile.createdUnix * 1000).toLocaleString() : "Unknown date"}</strong>
                          </div>
                          <div>
                            <span>PAK files</span>
                            <strong>{profile.enabledPakFiles.length}</strong>
                          </div>
                          <div>
                            <span>Tsuki installs</span>
                            <strong>{profile.enabledReceiptIds.length}</strong>
                          </div>
                        </div>

                        <div className="profile-mod-section">
                          <div className="profile-section-heading">
                            <span>PAK files</span>
                            <small>{profile.enabledPakFiles.length} saved</small>
                          </div>
                          <div className="profile-chip-list">
                            {profile.enabledPakFiles.length ? profile.enabledPakFiles.map((fileName) => (
                              <span className="profile-mod-chip" key={fileName} title={fileName}>
                                <strong>{fileName.split(/[\/]/).pop()}</strong>
                                <small>~mods PAK</small>
                              </span>
                            )) : <span className="profile-empty-chip">No PAK files saved in this profile.</span>}
                          </div>
                        </div>

                        <div className="profile-mod-section">
                          <div className="profile-section-heading">
                            <span>Tsuki receipt-backed installs</span>
                            <small>{profile.enabledReceiptIds.length} saved</small>
                          </div>
                          <div className="profile-chip-list">
                            {profile.enabledReceiptIds.length ? profile.enabledReceiptIds.map((receiptId) => (
                              <span className="profile-mod-chip receipt" key={receiptId} title={receiptId}>
                                <strong>{receiptId.replace(/_/g, " ")}</strong>
                                <small>receipt tracked</small>
                              </span>
                            )) : <span className="profile-empty-chip">No receipt-backed installs saved in this profile.</span>}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </article>
      </div>
    </section>
  );
}

function BootScreen({ message = "Loading paths, theme, source cache, installed state, and app updates..." }: { message?: string }) {
  return (
    <main className="boot-screen">
      <div className="boot-card">
        <div className="boot-logo-orb">
          <span>月</span>
        </div>
        <div>
          <p className="eyebrow">TSUKI MOD MANAGER</p>
          <h1>Opening Tsuki</h1>
          <p>{message}</p>
        </div>
        <div className="boot-progress">
          <div />
        </div>
      </div>
    </main>
  );
}



function redactDebugValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 12).map(redactDebugValue);

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (lower.includes("apikey") || lower.includes("api_key") || lower.includes("token") || lower.includes("secret") || lower.includes("bearer")) {
        output[key] = entry ? "[saved/redacted]" : null;
      } else {
        output[key] = redactDebugValue(entry);
      }
    }

    return output;
  }

  if (typeof value === "string") {
    return value
      .replace(/([A-Za-z0-9+/]{24,}={0,2}--[A-Za-z0-9+/=+\-]{8,}--[A-Za-z0-9+/=+\-]{8,})/g, "[redacted-api-key]")
      .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]")
      .replace(/apikey[=:\\"]+[^\\"&\s]+/gi, "apikey=[redacted]");
  }

  return value;
}

type DebugTab = "overview" | "browse" | "installed" | "receipts" | "launcher" | "updates" | "paths" | "backups";

interface DebugAction {
  label: string;
  command: string;
  args: Record<string, unknown>;
}

const DEBUG_TAB_META: Record<DebugTab, { label: string; description: string; checks: string[] }> = {
  overview: {
    label: "Overview",
    description: "Run a broad health check and copy safe debug output.",
    checks: ["Settings load", "Debug report", "Feature test summary"],
  },
  browse: {
    label: "Browse",
    description: "Checks Nexus, ModWorkshop, source cache, source tags, and browse responses.",
    checks: ["Nexus browse sample", "ModWorkshop browse sample", "Source index"],
  },
  installed: {
    label: "Installed",
    description: "Checks local PAK scan, managed installs, and installed-state records.",
    checks: ["PAK mod scan", "Managed installs", "Installed state records"],
  },
  receipts: {
    label: "Receipts",
    description: "Inspects install receipts, tracked files, and receipt repair data.",
    checks: ["Install receipts", "Receipt repair items", "Installed mod updates"],
  },
  launcher: {
    label: "Launcher",
    description: "Checks game path detection and launcher-facing state.",
    checks: ["PAYDAY 3 path detection", "Vanilla/modded launch prerequisites"],
  },
  updates: {
    label: "Updates",
    description: "Checks app update manifest and update status.",
    checks: ["App update check"],
  },
  paths: {
    label: "Paths",
    description: "Checks PAYDAY 3, AppData, cache, backups, receipts, and profiles paths.",
    checks: ["PAYDAY 3 path detection", "Settings load", "Debug report paths"],
  },
  backups: {
    label: "Backups",
    description: "Checks backup status and backup folder access.",
    checks: ["Backups status"],
  },
};
const DEBUG_TAB_ACTIONS: Record<DebugTab, DebugAction[]> = {
  overview: [
    { label: "Load settings", command: "get_app_settings", args: {} },
    { label: "Copy debug report data", command: "get_debug_report", args: {} },
  ],
  browse: [
    { label: "Nexus browse sample", command: "fetch_source_mods_page", args: { source: "nexus", page: 1, sort: "updated" } },
    { label: "ModWorkshop browse sample", command: "fetch_modworkshop_browse_live_page", args: { page: 1, sort: "recent" } },
    { label: "Read source index", command: "list_source_index", args: { source: null, limit: 25 } },
  ],
  installed: [
    { label: "Scan PAK mods", command: "scan_pak_mods", args: {} },
    { label: "List managed installs", command: "list_managed_installs", args: {} },
    { label: "Read installed-state", command: "list_installed_state_records", args: {} },
  ],
  receipts: [
    { label: "List receipts", command: "list_install_receipts", args: {} },
    { label: "Receipt repair data", command: "list_receipt_repair_items", args: {} },
    { label: "Check receipt updates", command: "check_installed_source_updates", args: {} },
  ],
  launcher: [
    { label: "Detect PAYDAY 3 path", command: "detect_payday3_path", args: {} },
  ],
  updates: [
    { label: "Check app update", command: "check_app_update", args: { manifestUrl: null } },
    { label: "Check installed mod updates", command: "check_installed_source_updates", args: {} },
  ],
  paths: [
    { label: "Detect PAYDAY 3 path", command: "detect_payday3_path", args: {} },
    { label: "Load settings paths", command: "get_app_settings", args: {} },
    { label: "Generate debug report", command: "get_debug_report", args: {} },
  ],
  backups: [
    { label: "Backup status", command: "get_backup_status", args: {} },
    { label: "List backups", command: "list_pak_backups", args: {} },
  ],
};


function resultBelongsToTab(result: DebugFeatureTestResult, tab: DebugTab) {
  if (tab === "overview") return true;

  const lower = result.name.toLowerCase();
  if (tab === "browse") return lower.includes("nexus") || lower.includes("modworkshop") || lower.includes("source");
  if (tab === "installed") return lower.includes("installed") || lower.includes("pak") || lower.includes("managed");
  if (tab === "receipts") return lower.includes("receipt") || lower.includes("update");
  if (tab === "launcher") return lower.includes("payday") || lower.includes("launcher");
  if (tab === "updates") return lower.includes("update");
  if (tab === "paths") return lower.includes("path") || lower.includes("settings") || lower.includes("debug report");
  if (tab === "backups") return lower.includes("backup");
  return false;
}

function DebugTestPanel({ open, onClose, onOpenSetupWizard }: { open: boolean; onClose: () => void; onOpenSetupWizard: () => void }) {
  const [position, setPosition] = useState({ x: 190, y: 86 });
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<DebugFeatureTestResult[]>([]);
  const [sessionLog, setSessionLog] = useState("Tsuki debug session started: " + new Date().toISOString());
  const [tab, setTab] = useState<DebugTab>("overview");
  const [receipts, setReceipts] = useState<InstallReceipt[]>([]);
  const [receiptStatus, setReceiptStatus] = useState("Receipts not loaded yet.");
  const dragOffsetRef = useRef({ x: 0, y: 0 });

  const receiptStats = useMemo(() => {
    const fileCount = receipts.reduce((total, receipt) => total + receipt.files.length, 0);
    return { count: receipts.length, fileCount };
  }, [receipts]);

  useEffect(() => {
    if (!dragging) return;

    const onMove = (event: MouseEvent) => {
      setPosition({
        x: Math.max(8, Math.min(window.innerWidth - 220, event.clientX - dragOffsetRef.current.x)),
        y: Math.max(32, Math.min(window.innerHeight - 120, event.clientY - dragOffsetRef.current.y)),
      });
    };

    const onUp = () => setDragging(false);

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  function startDrag(event: ReactMouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select")) return;

    dragOffsetRef.current = {
      x: event.clientX - position.x,
      y: event.clientY - position.y,
    };
    setDragging(true);
  }

  async function loadReceipts() {
    setReceiptStatus("Loading receipts...");

    try {
      const result = await invoke<InstallReceipt[]>("list_install_receipts");
      setReceipts(result);
      setReceiptStatus(result.length > 0 ? `Loaded ${result.length} receipt(s).` : "No install receipts found.");
    } catch (error) {
      setReceipts([]);
      setReceiptStatus(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    if (!open || tab !== "receipts") return;
    void loadReceipts();
  }, [open, tab]);

  async function runFeatureTests() {
    if (running) return;

    setRunning(true);
    setProgress(0);
    setResults([]);

    const tests: Array<{ name: string; tab: DebugTab; command: string; args: Record<string, unknown>; warning?: (value: unknown) => string | null }> = [
      { name: "Settings load", tab: "overview", command: "get_app_settings", args: {} },
      { name: "PAYDAY 3 path detection", tab: "paths", command: "detect_payday3_path", args: {} },
      { name: "PAK mod scan", tab: "installed", command: "scan_pak_mods", args: {} },
      { name: "Managed installs", tab: "installed", command: "list_managed_installs", args: {} },
      { name: "Installed state records", tab: "installed", command: "list_installed_state_records", args: {} },
      { name: "Source index", tab: "browse", command: "list_source_index", args: { source: null, limit: 25 } },
      { name: "Nexus browse sample", tab: "browse", command: "fetch_source_mods_page", args: { source: "nexus", page: 1, sort: "updated" } },
      { name: "ModWorkshop browse sample", tab: "browse", command: "fetch_modworkshop_browse_live_page", args: { page: 1, sort: "recent" } },
      { name: "Backups status", tab: "backups", command: "get_backup_status", args: {} },
      { name: "Profiles list", tab: "overview", command: "list_mod_profiles", args: {} },
      { name: "Install receipts", tab: "receipts", command: "list_install_receipts", args: {} },
      { name: "Runtime lock", tab: "launcher", command: "payday3_runtime_lock_status", args: {} },
      { name: "Last install diagnostic", tab: "installed", command: "get_last_install_diagnostic", args: {} },
      { name: "App update check", tab: "updates", command: "check_app_update", args: { manifestUrl: null } },
      { name: "Debug report", tab: "overview", command: "get_debug_report", args: {} },
    ];

    const nextResults: DebugFeatureTestResult[] = [];

    for (let index = 0; index < tests.length; index += 1) {
      const test = tests[index];
      setTab(test.tab);
      setProgress(Math.round((index / tests.length) * 100));

      try {
        const value = await Promise.race([
          invoke<unknown>(test.command, test.args),
          new Promise((_, reject) => window.setTimeout(() => reject(new Error("Timed out after 15 seconds.")), 15000)),
        ]);

        const safeValue = redactDebugValue(value);
        const json = typeof safeValue === "string" ? safeValue : JSON.stringify(safeValue);
        const detail = json && json.length > 220 ? `${json.slice(0, 220)}...` : (json || "Command completed.");
        const warning = test.warning?.(value) ?? null;
        nextResults.push({ name: test.name, status: warning ? "warning" : "passed", detail: warning ?? detail });
      } catch (error) {
        nextResults.push({ name: test.name, status: "failed", detail: error instanceof Error ? error.message : String(error) });
      }

      setResults([...nextResults]);
    }

    const finalLog = [
      "Tsuki Feature Test Log",
      new Date().toISOString(),
      "",
      ...nextResults.map((result) => `[${result.status.toUpperCase()}] ${result.name}: ${result.detail}`),
    ].join("\n");
    setSessionLog(finalLog);
    window.dispatchEvent(new CustomEvent("tsuki-debug-log-updated", { detail: finalLog }));

    setProgress(100);
    setRunning(false);
  }

  async function copyFeatureTestLog() {
    const text = sessionLog || [
      "Tsuki Feature Test Log",
      new Date().toISOString(),
      "",
      ...results.map((result) => `[${result.status.toUpperCase()}] ${result.name}: ${result.detail}`),
    ].join("\n");

    await navigator.clipboard.writeText(text);
  }

  async function copyDebugReport() {
    try {
      const report = await invoke<string>("get_debug_report");
      await navigator.clipboard.writeText(report);
    } catch (error) {
      await navigator.clipboard.writeText(error instanceof Error ? error.message : String(error));
    }
  }

  async function runSingleDebugAction(action: DebugAction) {
    if (running) return;

    setRunning(true);
    setProgress(18);

    try {
      const value = await Promise.race([
        invoke<unknown>(action.command, action.args),
        new Promise((_, reject) => window.setTimeout(() => reject(new Error("Timed out after 15 seconds.")), 15000)),
      ]);

      const safeValue = redactDebugValue(value);
      const json = typeof safeValue === "string" ? safeValue : JSON.stringify(safeValue);
      const detail = json && json.length > 320 ? `${json.slice(0, 320)}...` : (json || "Command completed.");
      if (action.command === "list_install_receipts" && Array.isArray(value)) {
        setReceipts(value as InstallReceipt[]);
        setReceiptStatus(`Loaded ${(value as InstallReceipt[]).length} receipt(s).`);
      }
      setResults((current) => [
        { name: action.label, status: "passed", detail },
        ...current.filter((result) => result.name !== action.label),
      ]);
      setSessionLog((current) => `${current}\n[PASSED] ${action.label}: ${detail}`);
      setProgress(100);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setResults((current) => [
        { name: action.label, status: "failed", detail },
        ...current.filter((result) => result.name !== action.label),
      ]);
      setSessionLog((current) => `${current}\n[FAILED] ${action.label}: ${detail}`);
      setProgress(100);
    } finally {
      window.setTimeout(() => {
        setRunning(false);
        setProgress(0);
      }, 350);
    }
  }

  if (!open) return null;

  const activeInfo = DEBUG_TAB_META[tab];
  const visibleResults = results.filter((result) => resultBelongsToTab(result, tab));

  return (
    <aside className="secret-debug-panel" style={{ left: position.x, top: position.y }}>
      <div className="secret-debug-header" onMouseDown={startDrag}>
        <div>
          <p className="eyebrow">Secret debug</p>
          <h2>Tsuki Diagnostics</h2>
        </div>
        <button className="ghost-button compact" type="button" onClick={onClose}>Close</button>
      </div>

      <div className="secret-debug-tabs">
        {(Object.keys(DEBUG_TAB_META) as DebugTab[]).map((id) => (
          <button className={tab === id ? "active" : ""} type="button" key={id} onClick={() => setTab(id)}>{DEBUG_TAB_META[id].label}</button>
        ))}
      </div>

      <article className="secret-debug-tab-panel">
        <div>
          <p className="eyebrow">{activeInfo.label}</p>
          <h3>{activeInfo.description}</h3>
        </div>
        <div className="secret-debug-tab-actions">
          {DEBUG_TAB_ACTIONS[tab].map((action) => (
            <button className="ghost-button compact" type="button" key={action.label} onClick={() => runSingleDebugAction(action)} disabled={running}>
              {action.label}
            </button>
          ))}
        </div>
        <ul>
          {activeInfo.checks.map((check) => <li key={check}>{check}</li>)}
        </ul>
      </article>

      {tab === "receipts" && (
        <section className="secret-debug-receipts" aria-label="Receipt diagnostics">
          <div className="secret-debug-receipt-stats">
            <article>
              <span>Receipts</span>
              <strong>{receiptStats.count}</strong>
            </article>
            <article>
              <span>Tracked Files</span>
              <strong>{receiptStats.fileCount}</strong>
            </article>
            <button className="ghost-button compact" type="button" onClick={loadReceipts} disabled={running}>
              Refresh Receipts
            </button>
          </div>
          <p className="muted-inline">{receiptStatus}</p>
          {receipts.length > 0 && (
            <div className="secret-debug-receipt-list">
              {receipts.slice(0, 8).map((receipt) => (
                <article className="secret-debug-receipt-row" key={receipt.id}>
                  <strong>{receipt.displayName}</strong>
                  <span>{receipt.source} - {receipt.files.length} files</span>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      <div className="secret-debug-actions">
        <button className="ghost-button compact install-button" type="button" onClick={runFeatureTests} disabled={running}>
          {running ? "Testing..." : "Test All Features"}
        </button>
        <button className="ghost-button compact" type="button" onClick={copyFeatureTestLog} disabled={results.length === 0}>Copy Test Log</button>
        <button className="ghost-button compact" type="button" onClick={copyDebugReport}>Copy Debug Report</button>
        <button className="ghost-button compact" type="button" onClick={onOpenSetupWizard}>Open Setup Wizard</button>
      </div>

      <div className="secret-debug-progress" aria-label="Feature test progress">
        <span style={{ width: `${progress}%` }} />
      </div>

      <div className="secret-debug-log">
        {visibleResults.map((result) => (
          <article className={`secret-debug-result ${result.status}`} key={`${result.name}-${result.detail}`}>
            <strong>{result.status === "passed" ? "✓" : result.status === "warning" ? "!" : "×"} {result.name}</strong>
            <p>{result.detail}</p>
          </article>
        ))}
        {visibleResults.length === 0 && (
          <p className="muted-inline">No {activeInfo.label.toLowerCase()} results yet. Use one of this tab's buttons or run Test All Features.</p>
        )}
      </div>
    </aside>
  );
}


const SETUP_WIZARD_DONE_KEY = "tsuki-setup-wizard-complete:v1";

function SetupWizard({ open, onClose, onOpenSettings, onOpenBrowse }: { open: boolean; onClose: () => void; onOpenSettings: () => void; onOpenBrowse: () => void }) {
  const [step, setStep] = useState(0);
  const [pathStatus, setPathStatus] = useState("Not checked yet.");
  const [sourceStatus, setSourceStatus] = useState("Not verified yet.");
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const finish = () => {
    window.localStorage.setItem(SETUP_WIZARD_DONE_KEY, "true");
    onClose();
  };

  const detectPath = async () => {
    setBusy(true);
    try {
      setPathStatus(await invoke<string>("detect_payday3_path"));
    } catch (error) {
      setPathStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const verifySources = async () => {
    setBusy(true);
    try {
      setSourceStatus(await invoke<string>("verify_source_settings"));
    } catch (error) {
      setSourceStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const steps = [
    { title: "Welcome to Tsuki", body: "This wizard checks your PAYDAY 3 paths, explains source keys, and gets you to Browse without making the normal UI noisy." },
    { title: "Game path", body: "Tsuki can auto-detect PAYDAY 3. Manual path editing lives in Settings → Game." },
    { title: "Sources", body: "ModWorkshop works without login. Nexus needs your personal API key for browsing/downloading." },
    { title: "Ready", body: "You can reopen this wizard from the secret Debug panel by double-clicking the version badge." },
  ];

  return (
    <div className="setup-wizard-overlay" role="dialog" aria-modal="true">
      <section className="setup-wizard-panel card">
        <div className="setup-wizard-topline">
          <p className="eyebrow">First launch setup</p>
          <button className="ghost-button compact" type="button" onClick={finish}>Skip</button>
        </div>
        <div className="setup-wizard-progress">
          {steps.map((item, index) => <span className={index <= step ? "active" : ""} key={item.title} />)}
        </div>
        <h1>{steps[step].title}</h1>
        <p>{steps[step].body}</p>

        {step === 1 && (
          <div className="setup-wizard-action-card">
            <strong>PAYDAY 3 detection</strong>
            <p>{pathStatus}</p>
            <button className="ghost-button install-button" type="button" onClick={detectPath} disabled={busy}>{busy ? "Checking..." : "Detect PAYDAY 3"}</button>
            <button className="ghost-button compact" type="button" onClick={onOpenSettings}>Open Game Settings</button>
          </div>
        )}

        {step === 2 && (
          <div className="setup-wizard-action-card">
            <strong>Source access</strong>
            <p>{sourceStatus}</p>
            <button className="ghost-button install-button" type="button" onClick={verifySources} disabled={busy}>{busy ? "Verifying..." : "Verify Sources"}</button>
            <button className="ghost-button compact" type="button" onClick={onOpenSettings}>Open Source Settings</button>
          </div>
        )}

        {step === 3 && (
          <div className="setup-wizard-action-card ready">
            <strong>Next stop: Browse</strong>
            <p>Search, install, make backups, and keep receipts tracked from here.</p>
            <button className="ghost-button install-button" type="button" onClick={() => { finish(); onOpenBrowse(); }}>Open Browse</button>
          </div>
        )}

        <div className="setup-wizard-footer">
          <button className="ghost-button compact" type="button" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0}>Back</button>
          {step < steps.length - 1 ? (
            <button className="ghost-button install-button" type="button" onClick={() => setStep((current) => Math.min(steps.length - 1, current + 1))}>Next</button>
          ) : (
            <button className="ghost-button install-button" type="button" onClick={finish}>Finish</button>
          )}
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [activePage, setActivePage] = useState<AppPage>("home");
  const [refreshTick, setRefreshTick] = useState(0);
  const [bootReady, setBootReady] = useState(false);
  const [bootMessage, setBootMessage] = useState("Opening Tsuki...");
  const [homeOpenMod, setHomeOpenMod] = useState<SourceModSummary | null>(null);
  const [taskProgress, setTaskProgress] = useState<TaskProgressState>({ active: false, label: "", detail: "", progress: null });
  const taskProgressTimerRef = useRef<number | null>(null);
  const taskProgressOrphanTimerRef = useRef<number | null>(null);
  const [activeThemeId, setActiveThemeId] = useState(() => window.localStorage.getItem("tsuki-theme-id") ?? "neon-rift");
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus | null>(null);
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);
  const [debugPanelOpen, setDebugPanelOpen] = useState(false);
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);


  const goToPage = (page: AppPage) => {
    setActivePage((current) => {
      if (current === page) setRefreshTick((tick) => tick + 1);
      return page;
    });
  };

  const openSourceModInApp = (mod: SourceModSummary) => {
    setHomeOpenMod(mod);
    setActivePage("browse");
    setRefreshTick((tick) => tick + 1);
  };


  async function checkAppUpdate(manual = false) {
    if (appUpdateBusy) return;

    setAppUpdateBusy(true);
    if (!manual && !bootReady) setBootMessage("Checking for Tsuki app updates...");

    try {
      const result = await invoke<AppUpdateStatus>("check_app_update", { manifestUrl: null });
      setAppUpdate(result);

      if (!manual && !bootReady) {
        setBootMessage(result.updateAvailable ? `Update ${result.latestVersion ?? "available"} found. Finishing startup...` : "No app update found. Finishing startup...");
      }

      if (manual && result.error) {
        console.warn("App update check:", result.error);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAppUpdate({
        currentVersion: "unknown",
        currentSemver: "unknown",
        latestVersion: null,
        updateAvailable: false,
        checkedAtUnix: Math.floor(Date.now() / 1000),
        error: message,
      });
      if (!manual && !bootReady) setBootMessage("Update check failed. Continuing startup...");
    } finally {
      setAppUpdateBusy(false);
    }
  }

  async function installAppUpdate() {
    if (appUpdateBusy) return;

    if (!appUpdate?.updateAvailable) {
      await checkAppUpdate(true);
      return;
    }

    setAppUpdateBusy(true);

    try {
      const result = await invoke<string>("download_and_launch_app_update", { manifestUrl: null });
      setAppUpdate((current) => current ? { ...current, notes: result } : current);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAppUpdate((current) => current ? { ...current, error: message } : current);
    } finally {
      setAppUpdateBusy(false);
    }
  }

  useEffect(() => {
    invoke<AppSettings>("get_app_settings")
      .then((settings) => {
        if (settings.themeId) setActiveThemeId(settings.themeId);
      })
      .catch(() => {
        // Keep localStorage theme fallback.
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let readyTimer: number | null = null;
    let updateTimer: number | null = null;

    readyTimer = window.setTimeout(() => {
      if (cancelled) return;
      setBootMessage("Ready.");
      setBootReady(true);
      window.performance.mark?.("tsuki-boot-ready-before-background-update-check");

      updateTimer = window.setTimeout(() => {
        if (!cancelled) void checkAppUpdate(false);
      }, 8000);
    }, 450);

    return () => {
      cancelled = true;
      if (readyTimer !== null) window.clearTimeout(readyTimer);
      if (updateTimer !== null) window.clearTimeout(updateTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!bootReady) return;

    const cached = readReceiptUpdateCheckCache();
    if (cached?.savedAt && Date.now() - cached.savedAt < TSUKI_RECEIPT_UPDATE_CHECK_THROTTLE_MS) {
      return;
    }

    const timer = window.setTimeout(() => {
      invoke<SourceUpdateStatus[]>("check_installed_source_updates")
        .then((updates) => writeReceiptUpdateCheckCache(updates, "launch"))
        .catch(() => {
          // Silent launch check. Manual Check Updates still reports errors in Installed.
        });
    }, 45000);

    return () => window.clearTimeout(timer);
  }, [bootReady]);

  useEffect(() => {
    if (!bootReady) return;
    if (window.localStorage.getItem(SETUP_WIZARD_DONE_KEY) !== "true") {
      window.setTimeout(() => setSetupWizardOpen(true), 450);
    }
  }, [bootReady]);

  useEffect(() => {
    window.localStorage.setItem("tsuki-active-page", activePage);
  }, [activePage]);

  useEffect(() => {
    const clearProgressTimer = () => {
      if (taskProgressTimerRef.current !== null) {
        window.clearTimeout(taskProgressTimerRef.current);
        taskProgressTimerRef.current = null;
      }
    };
    const clearOrphanTimer = () => {
      if (taskProgressOrphanTimerRef.current !== null) {
        window.clearTimeout(taskProgressOrphanTimerRef.current);
        taskProgressOrphanTimerRef.current = null;
      }
    };

    const onTaskProgress = (event: Event) => {
      const detail = (event as CustomEvent<TaskProgressState>).detail;
      clearProgressTimer();
      clearOrphanTimer();

      if (!detail || detail.active === false) {
        setTaskProgress({ active: false, label: "", detail: "", progress: null });
        return;
      }

      const progress = typeof detail.progress === "number" ? Math.max(0, Math.min(100, detail.progress)) : null;
      const next = {
        active: true,
        label: detail.label || "Working",
        detail: detail.detail ?? "",
        progress,
      };

      setTaskProgress(next);

      if (progress !== null && progress >= 100) {
        taskProgressTimerRef.current = window.setTimeout(() => {
          setTaskProgress({ active: false, label: "", detail: "", progress: null });
          taskProgressTimerRef.current = null;
        }, 900);
      } else {
        // Safety net for any task that stops reporting before it sends a final clear event.
        taskProgressOrphanTimerRef.current = window.setTimeout(() => {
          setTaskProgress((current) => current.active
            ? { ...current, detail: current.detail ? `${current.detail} (stopped reporting)` : "Task stopped reporting.", progress: 100 }
            : current);
          taskProgressTimerRef.current = window.setTimeout(() => {
            setTaskProgress({ active: false, label: "", detail: "", progress: null });
            taskProgressTimerRef.current = null;
          }, 1200);
          taskProgressOrphanTimerRef.current = null;
        }, 30000);
      }
    };

    window.addEventListener("tsuki-task-progress", onTaskProgress);

    return () => {
      clearProgressTimer();
      clearOrphanTimer();
      window.removeEventListener("tsuki-task-progress", onTaskProgress);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (taskProgressTimerRef.current !== null) {
        window.clearTimeout(taskProgressTimerRef.current);
        taskProgressTimerRef.current = null;
      }
      if (taskProgressOrphanTimerRef.current !== null) {
        window.clearTimeout(taskProgressOrphanTimerRef.current);
        taskProgressOrphanTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem("tsuki-theme-id", activeThemeId);
    document.documentElement.dataset.theme = activeThemeId;
  }, [activeThemeId]);


  const openSecretDebugPanel = useCallback(() => {
    setDebugPanelOpen(true);
  }, []);

  const page = useMemo(() => {
    switch (activePage) {
      case "browse":
        return <BrowsePage initialMod={homeOpenMod} onInitialModConsumed={() => setHomeOpenMod(null)} />;
      case "installed":
        return <InstalledPage />;
      case "profiles":
        return <ProfilesPage />;
      case "repair":
        return <RepairPage />;
      case "backups":
        return <BackupsPage />;
      case "settings":
        return <SettingsPage activeThemeId={activeThemeId} onThemeChange={setActiveThemeId} />;
      case "home":
      default:
        return <HomePage onOpenPage={goToPage} onOpenModInApp={openSourceModInApp} refreshTick={refreshTick} />;
    }
  }, [activePage, activeThemeId, refreshTick, homeOpenMod]);

  if (!bootReady) {
    return <BootScreen message={bootMessage} />;
  }

  return (
    <div className="app-shell">
      <WindowTitleBar activePage={activePage} appUpdate={appUpdate} updateBusy={appUpdateBusy} onCheckUpdate={() => checkAppUpdate(true)} onInstallUpdate={installAppUpdate} />
      <div className="app-body">
        <Sidebar activePage={activePage} onChangePage={goToPage} taskProgress={taskProgress} onOpenDebug={openSecretDebugPanel} />
        <main className="app-main">
          <div className="page-scroll"><PageCrashGuard pageName={activePage}>{page}</PageCrashGuard></div>
          <DebugTestPanel open={debugPanelOpen} onClose={() => setDebugPanelOpen(false)} onOpenSetupWizard={() => setSetupWizardOpen(true)} />
        </main>
      </div>
      <SetupWizard
        open={setupWizardOpen}
        onClose={() => setSetupWizardOpen(false)}
        onOpenSettings={() => { setSetupWizardOpen(false); setActivePage("settings"); }}
        onOpenBrowse={() => { setActivePage("browse"); }}
      />
    </div>
  );
}

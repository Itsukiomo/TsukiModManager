import "./App.css";
import { invoke } from "@tauri-apps/api/core";
import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { WindowTitleBar } from "./components/WindowTitleBar/WindowTitleBar";
import { ProfileArtwork } from "./components/ProfileArtwork";
import type { AppPage } from "./models/navigation";
import { applyAppearanceSettings, normalizeAppSettings, normalizeThemeId, type AppSettings } from "./models/settings";
import { BUILTIN_GAME_PROFILES, BUILTIN_PAYDAY3_PROFILE_ID, getGameProfile } from "./models/gameProfiles";
import type { GameProfile } from "./models/gameProfiles";
import { normalizeProfileImageReference } from "./models/profileArtwork";
import type { SourceModSummary, SourceUpdateStatus } from "./models/source";
import type { ActiveProfileRuntime } from "./models/profileRuntime";
import { HomePage } from "./pages/Home/HomePage";
import { DragDropInstallWizard } from "./components/DragDropInstallWizard";
import { DependencyActions, DependencyName } from "./components/DependencyActions";
import { ManagedLoaderStatus } from "./components/ManagedLoaderStatus";
import { dependenciesForProfile, dependencySourceLabel, dependencyToSourceSummary, findDependency, type DependencyDefinition } from "./models/dependency";
import { repairMojibakeText } from "./utils/textEncoding";
import { safeLocalStorageSet, safeSessionStorageSet } from "./utils/browserStorage";
import lunarStartup from "./assets/lunar-startup-v2.webp";

const BrowsePage = lazy(() => import("./pages/Browse/BrowsePage").then((module) => ({ default: module.BrowsePage })));
const InstalledPage = lazy(() => import("./pages/Installed/InstalledPage").then((module) => ({ default: module.InstalledPage })));
const SettingsPage = lazy(() => import("./pages/Settings/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const ProfileCreatorPage = lazy(() => import("./pages/ProfileCreator/ProfileCreatorPage").then((module) => ({ default: module.ProfileCreatorPage })));
const GameSelectorPage = lazy(() => import("./pages/GameSelector/GameSelectorPage").then((module) => ({ default: module.GameSelectorPage })));
const BackupsPage = lazy(() => import("./pages/Backups/BackupsPage").then((module) => ({ default: module.BackupsPage })));
const DebugCenter = lazy(() => import("./components/DebugCenter/DebugCenter").then((module) => ({ default: module.DebugCenter })));

const THEME_STORAGE_KEY = "tsuki-theme-id";
const INITIAL_THEME_ID = normalizeThemeId(window.localStorage.getItem(THEME_STORAGE_KEY) ?? "moonveil");
document.documentElement.dataset.theme = INITIAL_THEME_ID;


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

interface AppCapabilities {
  isDeveloperMode: boolean;
  canEditOfficialProfiles: boolean;
}

type GameProfileDraftRecord = Record<string, unknown>;

function draftString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function draftObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function draftArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function draftSafeKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
function startupPageFromSettings(settings: AppSettings): AppPage {
  const destination = settings.startupDestination ?? "home";
  if (destination === "last") {
    const saved = window.localStorage.getItem("tsuki-active-page") as AppPage | null;
    const allowed: AppPage[] = ["home", "browse", "installed", "games", "profiles", "repair", "backups", "settings"];
    return saved && allowed.includes(saved) ? saved : "home";
  }
  if (destination === "browse" || destination === "installed" || destination === "games") return destination;
  return "home";
}

function draftSetupProgress(draft: GameProfileDraftRecord) {
  const overview = draftObject(draft.overview);
  const artwork = draftObject(draft.artwork);
  const sections = draftObject(draft.sections);
  const customPaths = draftArray(draft.customPaths);
  const customFileTypes = draftArray(draft.customFileTypes);
  const checks = [
    Boolean(draftString(overview.gameName)),
    Boolean(draftString(overview.profileTitle)),
    Boolean(draftString(overview.gameKey)),
    Boolean(draftString(artwork.imageUrl) || draftObject(artwork.imageReference).kind && draftObject(artwork.imageReference).kind !== "none"),
    draftArray(sections.detectionStores).length > 0,
    customPaths.length > 0,
    draftArray(sections.sources).length > 0,
    draftArray(sections.modTypes).length > 0 || customFileTypes.length > 0,
    draftArray(sections.installBehavior).length > 0 || customFileTypes.length > 0,
    draftArray(sections.dependencies).length > 0,
  ];
  const configured = checks.filter(Boolean).length;
  const total = checks.length;
  return { configured, total, label: `${configured}/${total} configured` };
}

function gameProfileFromDraft(draft: GameProfileDraftRecord): GameProfile {
  const overview = draftObject(draft.overview);
  const artwork = draftObject(draft.artwork);
  const profileId = draftString(draft.profileId) || `user.${Date.now()}`;
  const gameName = repairMojibakeText(draftString(overview.gameName));
  const profileTitle = repairMojibakeText(draftString(overview.profileTitle));
  const displayName = gameName || profileTitle || "Untitled Game Profile";
  const gameKey = draftString(overview.gameKey) || draftSafeKey(gameName || profileTitle || profileId) || profileId.replace(/^user\./, "custom-");
  const imageReference = normalizeProfileImageReference(artwork.imageReference, draftString(artwork.imageUrl));
  const progress = draftSetupProgress(draft);

  return {
    profileId,
    gameKey,
    displayName,
    profileVersion: draftString(overview.version) || "1.0.0",
    gameVersion: draftString(overview.gameVersion) || undefined,
    gameVersions: draftString(overview.supportedVersions).split(",").map((version) => version.trim()).filter(Boolean),
    profileType: "user_created",
    profileTypeLabel: "Custom Draft",
    statusLabel: progress.configured === 0 ? "Blank draft" : repairMojibakeText(`Setup incomplete - ${progress.label}`),
    image: imageReference.kind === "none" ? "" : imageReference.value,
    imageReference,
    artwork: {
      objectFit: artwork.objectFit === "contain" ? "contain" : "cover",
      focalX: typeof artwork.focalX === "number" ? artwork.focalX : 50,
      focalY: typeof artwork.focalY === "number" ? artwork.focalY : 50,
      scale: typeof artwork.scale === "number" ? artwork.scale : 1,
    },
    isPermanent: false,
    isRemovable: true,
    editMode: "full",
    normalUserEditMode: "full",
    maintainerEditMode: "full",
    allowNormalUserExport: true,
    sourceConfig: {},
    lifecycleState: "draft",
    setupStatus: "incomplete",
    setupProgress: progress,
    draft,
    draftStoragePath: draftString(draft.draftStoragePath),
    createdAt: draftString(draft.createdAt),
    updatedAt: draftString(draft.updatedAt),
  };
}

function findProfileInList(profiles: GameProfile[], profileId?: string | null) {
  return profiles.find((profile) => profile.profileId === profileId)
    ?? BUILTIN_GAME_PROFILES.find((profile) => profile.profileId === profileId)
    ?? getGameProfile(BUILTIN_PAYDAY3_PROFILE_ID);
}

function findProfileInListExact(profiles: GameProfile[], profileId?: string | null) {
  if (!profileId) return null;
  return profiles.find((profile) => profile.profileId === profileId) ?? BUILTIN_GAME_PROFILES.find((profile) => profile.profileId === profileId) ?? null;
}

interface GameProfileInstallationResult {
  profileId: string;
  installed: boolean;
  storefront: "steam" | "manual" | null;
  gameRoot: string | null;
  matchedAppId: string | null;
}

async function withDetectedInstallations(profiles: GameProfile[]): Promise<GameProfile[]> {
  const probes = profiles
    .filter((profile) => profile.steamAppIds?.length)
    .map((profile) => ({ profileId: profile.profileId, steamAppIds: profile.steamAppIds ?? [] }));
  if (probes.length === 0) return profiles;

  let results: GameProfileInstallationResult[];
  try {
    results = await invoke<GameProfileInstallationResult[]>("detect_game_profile_installations", { profiles: probes });
  } catch (error) {
    console.warn("Failed to detect installed games:", error);
    return profiles;
  }
  const byProfileId = new Map(results.map((result) => [result.profileId, result]));
  return profiles.map((profile) => {
    const result = byProfileId.get(profile.profileId);
    if (!result) return profile;
    return {
      ...profile,
      installation: {
        checked: true,
        installed: result.installed,
        storefront: result.storefront,
        gameRoot: result.gameRoot,
        matchedAppId: result.matchedAppId,
      },
    };
  });
}

function draftDateLabel(value?: string | null) {
  const raw = draftString(value);
  if (!raw) return "Unknown";
  const numeric = Number(raw);
  const date = Number.isFinite(numeric) && numeric > 0 ? new Date(numeric * 1000) : new Date(raw);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
const INSTALLED_SESSION_CACHE_INVALIDATED_AT_KEY = "tsuki-installed-session-cache-invalidated-at";

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
    safeLocalStorageSet(TSUKI_RECEIPT_UPDATE_CACHE_KEY, JSON.stringify(payload));
    window.dispatchEvent(new CustomEvent("tsuki-receipt-update-check", { detail: payload }));
  } catch {
    // Optional launch update cache.
  }
}


interface ModProfile {
  id: string;
  gameProfileId: string;
  name: string;
  createdUnix: number;
  enabledPakFiles: string[];
  enabledReceiptIds: string[];
  migrationState?: string | null;
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

function RepairPage({ profileId }: { profileId: string }) {
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
      invoke<DependencyReport>("get_dependency_report", { profileId }),
      invoke<ReceiptRepairItem[]>("list_receipt_repair_items", { profileId }),
      invoke<MovieValidationItem[]>("validate_movie_replacer_receipts", { profileId }),
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
  }, [profileId]);

  const pruneStale = () => {
    setBusyId("prune");
    invoke<string>("prune_stale_install_receipts", { profileId })
      .then((message) => {
        setStatus(message);
        refresh();
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusyId(null));
  };

  const removeReceipt = (receipt: ReceiptRepairItem) => {
    setBusyId(receipt.receiptId);
    invoke<string>("remove_receipt_by_id", { receiptId: receipt.receiptId, profileId })
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
                  {findDependency(item.label, profileId) ? <DependencyName dependency={findDependency(item.label, profileId)!} /> : <strong>{item.label}</strong>}
                  <p>{item.details}</p>
                  <small>{item.path ?? item.recommendation}</small>
                </div>
                <span className={item.found ? "badge good" : "badge"}>{item.status}</span>
                {findDependency(item.label, profileId) ? <DependencyActions dependency={findDependency(item.label, profileId)!} /> : <span className="dependency-source-unverified">Source not verified</span>}
              </div>
            ))}
            {!dependencies && <p>Loading dependency scan...</p>}
          </div>

          {dependencies && dependencies.warnings.length > 0 && (
            <div className="repair-warning-list">
              {dependencies.warnings.map((warning) => <p key={warning}>- {warning}</p>)}
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
                    {receipt.source} #{receipt.sourceModId ?? "?"} - live {receipt.liveFiles} - disabled {receipt.disabledFiles} - missing {receipt.missingFiles}
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


interface ProfilesPageProps {
  currentGameProfile: GameProfile;
  draftProfiles: GameProfile[];
  onEditDraft: (profileId: string) => void;
  onDeleteDraft: (profileId: string) => Promise<void>;
}

function ProfilesPage({ currentGameProfile, draftProfiles, onEditDraft, onDeleteDraft }: ProfilesPageProps) {
  const [profiles, setProfiles] = useState<ModProfile[]>([]);
  const [profileName, setProfileName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, setStatus] = useState("Profiles ready.");
  const [folderNotice, setFolderNotice] = useState<string | null>(null);
  const [expandedProfileId, setExpandedProfileId] = useState<string | null>(null);
  const [activeModProfileId, setActiveModProfileId] = useState<string | null>(null);

  const showFolderNotice = useCallback((message: string) => {
    setFolderNotice(message);
    window.setTimeout(() => {
      setFolderNotice((current) => current === message ? null : current);
    }, 2600);
  }, []);

  const refresh = useCallback(() => {
    Promise.all([
      invoke<ModProfile[]>("list_mod_profiles", { gameProfileId: currentGameProfile.profileId }),
      invoke<AppSettings>("get_app_settings").catch(() => null),
    ])
      .then(([profileList, settings]) => {
        const ownedProfiles = profileList.filter((profile) => profile.gameProfileId === currentGameProfile.profileId);
        setProfiles(ownedProfiles);
        setActiveModProfileId(settings?.activeModProfileByGameProfileId?.[currentGameProfile.profileId] ?? null);
        setStatus(ownedProfiles.length ? `${ownedProfiles.length} saved profile${ownedProfiles.length === 1 ? "" : "s"}.` : "No profiles saved yet.");
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
  }, [currentGameProfile.profileId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const visibleDraftProfiles = useMemo(
    () => draftProfiles.filter((profile) => profile.lifecycleState === "draft"),
    [draftProfiles],
  );

  const saveProfile = () => {
    const name = profileName.trim();
    setBusyId("save-profile");
    invoke<ModProfile>("save_current_mod_profile", { name: name || `Profile ${new Date().toLocaleString()}`, gameProfileId: currentGameProfile.profileId })
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
    invoke<string>("apply_mod_profile", { profileId: profile.id, gameProfileId: currentGameProfile.profileId })
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
    invoke<string>("delete_mod_profile", { profileId: profile.id, gameProfileId: currentGameProfile.profileId })
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
    invoke<string>("open_mod_profiles_folder", { gameProfileId: currentGameProfile.profileId })
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
          <p className="page-description">Save and apply mod loadouts for {currentGameProfile.displayName}.</p>
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
          <h2>Save {currentGameProfile.displayName} setup</h2>
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

        <article className="card profile-drafts-panel">
          <div className="home-feed-header">
            <div>
              <p className="eyebrow">Drafts</p>
              <h2>Game profile drafts</h2>
            </div>
            <span className="status-pill">{visibleDraftProfiles.length} draft{visibleDraftProfiles.length === 1 ? "" : "s"}</span>
          </div>

          {visibleDraftProfiles.length === 0 ? (
            <div className="profile-empty-state">
              <strong>No saved game profile drafts.</strong>
              <p>Drafts created in the profile creator will appear here for every game.</p>
            </div>
          ) : (
            <div className="profile-draft-grid">
              {visibleDraftProfiles.map((profile) => {
                const overview = draftObject(profile.draft);
                const overviewFields = draftObject(overview.overview);
                const profileName = draftString(overviewFields.profileTitle) || profile.displayName;
                const selectedGame = draftString(overviewFields.gameName) || profile.displayName;
                return (
                  <article className="profile-draft-card" key={profile.profileId}>
                    <div className="profile-draft-art">
                      <ProfileArtwork
                        imageReference={profile.imageReference}
                        legacySrc={profile.image}
                        profileId={profile.profileId}
                        alt={`${profileName} artwork`}
                        fit={profile.artwork?.objectFit ?? "cover"}
                        focalX={profile.artwork?.focalX ?? 50}
                        focalY={profile.artwork?.focalY ?? 35}
                        scale={profile.artwork?.scale ?? 1}
                        fallback={<span className="profile-artwork-placeholder" aria-hidden="true" />}
                      />
                      <span className="profile-draft-badge">Draft</span>
                    </div>
                    <div className="profile-draft-copy">
                      <h3>{profileName}</h3>
                      <p>{selectedGame}</p>
                      <small>Last edited {draftDateLabel(profile.updatedAt)}</small>
                      <div className="profile-draft-actions">
                        <button className="ghost-button compact install-button" type="button" onClick={() => onEditDraft(profile.profileId)}>Continue Editing</button>
                        <button className="ghost-button compact danger-button" type="button" onClick={() => void onDeleteDraft(profile.profileId)}>Delete Draft</button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </article>

        <article className="card profile-list-panel">
          <div className="home-feed-header">
            <div>
              <p className="eyebrow">Saved</p>
              <h2>{currentGameProfile.displayName} profiles</h2>
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
                const activeProfile = activeModProfileId === profile.id;

                return (
                  <div className={`profile-row-clean ${expanded ? "expanded" : ""} ${activeProfile ? "active" : ""}`} key={profile.id}>
                    <div className="profile-row-main">
                      <div>
                        <strong className="profile-name-line">{profile.name}{activeProfile && <span className="status-pill profile-active-pill">Active</span>}</strong>
                        <p>{profile.enabledPakFiles.length} PAK files - {profile.enabledReceiptIds.length} Tsuki installs</p>
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

export function BootScreen({ message = "Starting Tsuki..." }: { message?: string }) {
  return (
    <main className="boot-screen lunar-startup" style={{ backgroundImage: `url(${lunarStartup})` }}>
      <section className="boot-card" aria-live="polite">
        <div className="boot-brand">
          <p className="eyebrow">TSUKI MOD MANAGER</p>
          <h1>Tsuki</h1>
        </div>
        <div className="boot-status">
          <span>{message}</span>
          <strong>v2.0.1</strong>
        </div>
        <div className="boot-progress" role="progressbar" aria-label="Starting Tsuki">
          <div />
        </div>
      </section>
    </main>
  );
}



const SETUP_WIZARD_DONE_KEY = "tsuki-setup-wizard-complete:v1";

type SettingsRouteState =
  | { scope: "global"; origin: "select-game" | "manager" }
  | { scope: "profile"; profileId: string; origin: "select-game" | "manager"; initialCategory?: "profileOverview" | "profileSetup" };

function SetupWizard({ open, currentGameProfile, profileRuntime, onClose, onOpenSettings, onOpenBrowse, onOpenDependency }: { open: boolean; currentGameProfile: GameProfile; profileRuntime: ActiveProfileRuntime | null; onClose: () => void; onOpenSettings: () => void; onOpenBrowse: () => void; onOpenDependency: (dependency: DependencyDefinition) => boolean | void }) {
  const [step, setStep] = useState(0);
  const [pathStatus, setPathStatus] = useState("Not checked yet.");
  const [sourceStatus, setSourceStatus] = useState("Not verified yet.");
  const [busy, setBusy] = useState(false);
  const [dependencyReport, setDependencyReport] = useState<DependencyReport | null>(null);

  useEffect(() => {
    if (!open) return;
    invoke<DependencyReport>("get_dependency_report", { profileId: currentGameProfile.profileId }).then(setDependencyReport).catch(() => setDependencyReport(null));
  }, [open, currentGameProfile.profileId]);

  if (!open) return null;

  const finish = () => {
    safeLocalStorageSet(SETUP_WIZARD_DONE_KEY, "true");
    onClose();
  };

  const detectPath = async () => {
    setBusy(true);
    try {
      setPathStatus(await invoke<string>("detect_active_profile_path", { profileId: currentGameProfile.profileId }));
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

  const gameName = profileRuntime?.gameName || currentGameProfile.displayName || "this game";
  const setupDependencies = dependenciesForProfile(currentGameProfile.profileId, currentGameProfile.gameVersion);
  const hasSources = Boolean(
    profileRuntime?.sources?.length ||
    currentGameProfile.sourceConfig?.modworkshopGameId ||
    currentGameProfile.sourceConfig?.modworkshopSlug ||
    currentGameProfile.sourceConfig?.modworkshopGamePageUrl ||
    currentGameProfile.sourceConfig?.modworkshopEmbeddedStartUrl ||
    currentGameProfile.sourceConfig?.nexusDomain ||
    currentGameProfile.sourceConfig?.nexusGameId ||
    currentGameProfile.sourceConfig?.nexusGamePageUrl ||
    currentGameProfile.sourceConfig?.nexusEmbeddedStartUrl
  );
  const steps = [
    { title: "Welcome to Tsuki", body: `This wizard checks ${gameName}'s game path, source access, and profile readiness.` },
    { title: `${gameName} game path`, body: `Tsuki can detect ${gameName} using this profile's configured paths and rules. You can also choose the game folder manually in Profile Settings.` },
    { title: "Sources", body: hasSources ? `${gameName} sources use this profile's game mappings.` : `No sources are configured for ${gameName} yet. Add sources in Profile Creator when you want Browse support.` },
    { title: "Set Up Modding", body: setupDependencies.length ? `Review the verified frameworks and tools used by ${gameName} mods.` : `This profile has no built-in framework requirements.` },
    { title: "Ready", body: `${gameName} is ready to browse, install, back up files, and keep receipts tracked from this profile.` },
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
            <strong>{gameName} detection</strong>
            <p>{pathStatus}</p>
            <button className="ghost-button install-button" type="button" onClick={detectPath} disabled={busy}>{busy ? "Checking..." : `Detect ${gameName}`}</button>
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
          <div className="setup-wizard-action-card">
            <strong>Frameworks and tools</strong>
            <div className="managed-list">
              {setupDependencies.map((dependency) => {
                const reportItem = dependencyReport?.items.find((item) => findDependency(item.label, currentGameProfile.profileId)?.id === dependency.id);
                return <div className={`managed-row ${reportItem?.found ? "" : "disabled"}`} key={dependency.id}>
                  <div>
                    <DependencyName dependency={dependency} onOpenNative={onOpenDependency} />
                    <p>{dependencySourceLabel(dependency)} - {dependency.required ? "Required" : dependency.optional ? "Optional" : "Recommended"}</p>
                    <small>{reportItem?.found ? reportItem.details : dependency.sourceUnverified ? "Source not verified" : reportItem?.recommendation ?? "Not detected"}</small>
                  </div>
                  <span className={reportItem?.found ? "badge good" : "badge"}>{reportItem?.found ? "Installed" : "Not detected"}</span>
                  <DependencyActions dependency={dependency} onOpenNative={onOpenDependency} />
                </div>;
              })}
              {setupDependencies.length === 0 && <p>No built-in dependencies for this profile.</p>}
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="setup-wizard-action-card ready">
            <strong>Next stop: Browse</strong>
            <p>{gameName} Browse will use this profile's sources, install paths, and receipt store.</p>
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
  const previousSettingsPageRef = useRef<AppPage>("home");
  const [refreshTick, setRefreshTick] = useState(0);
  const [bootReady, setBootReady] = useState(false);
  const [bootMessage, setBootMessage] = useState("Opening Tsuki...");
  const [homeOpenMod, setHomeOpenMod] = useState<SourceModSummary | null>(null);
  const [taskProgress, setTaskProgress] = useState<TaskProgressState>({ active: false, label: "", detail: "", progress: null });
  const taskProgressTimerRef = useRef<number | null>(null);
  const taskProgressOrphanTimerRef = useRef<number | null>(null);
  const [activeThemeId, setActiveThemeId] = useState(() => INITIAL_THEME_ID);
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus | null>(null);
  const autoUpdateChecksRef = useRef(true);
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);
  const [debugPanelOpen, setDebugPanelOpen] = useState(false);
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);
  const [appCapabilities, setAppCapabilities] = useState<AppCapabilities>({ isDeveloperMode: false, canEditOfficialProfiles: false });
  const [gameProfiles, setGameProfiles] = useState<GameProfile[]>(BUILTIN_GAME_PROFILES);
  const [currentGameProfile, setCurrentGameProfile] = useState<GameProfile>(() => findProfileInList(BUILTIN_GAME_PROFILES, window.localStorage.getItem("tsuki-current-game-profile-id") ?? window.localStorage.getItem("tsuki-active-game-profile-id") ?? BUILTIN_PAYDAY3_PROFILE_ID));
  const [settingsRoute, setSettingsRoute] = useState<SettingsRouteState>(() => ({ scope: "profile", profileId: window.localStorage.getItem("tsuki-current-game-profile-id") ?? window.localStorage.getItem("tsuki-active-game-profile-id") ?? BUILTIN_PAYDAY3_PROFILE_ID, origin: "manager" }));
  const [profileCreatorSource, setProfileCreatorSource] = useState<string | null>(null);
  const [draftRuntimeProfileId, setDraftRuntimeProfileId] = useState<string | null>(null);
  const [profileRuntime, setProfileRuntime] = useState<ActiveProfileRuntime | null>(null);
  const [profileSwitching, setProfileSwitching] = useState(false);
  const [profileRuntimeError, setProfileRuntimeError] = useState<string | null>(null);
  const profileRuntimeRequestRef = useRef(0);

  const refreshGameProfiles = useCallback(async () => {
    try {
      const drafts = await invoke<GameProfileDraftRecord[]>("list_game_profile_drafts");
      const builtinIds = new Set(BUILTIN_GAME_PROFILES.map((profile) => profile.profileId));
      const allDraftProfiles = drafts.map(gameProfileFromDraft);
      const mergedBuiltins = BUILTIN_GAME_PROFILES;
      const draftProfiles = allDraftProfiles.filter((profile) => !builtinIds.has(profile.profileId));
      const versionedProfiles = await Promise.all([...mergedBuiltins, ...draftProfiles].map(async (profile) => {
        if (!profile.gameVersions?.length) return profile;
        const settings = await invoke<{ gameVersion?: string }>("get_profile_settings", { profileId: profile.profileId });
        const version = settings.gameVersion && profile.gameVersions.includes(settings.gameVersion) ? settings.gameVersion : profile.gameVersion;
        return { ...profile, gameVersion: version, sourceConfig: { ...profile.sourceConfig, sources: profile.sourceConfig.sources?.map((source) => ({ ...source, gameVersion: version })) } };
      }));
      const nextProfiles = await withDetectedInstallations(versionedProfiles);
      setGameProfiles(nextProfiles);
      return nextProfiles;
    } catch (error) {
      console.warn("Failed to load custom game profile drafts:", error);
      setGameProfiles(BUILTIN_GAME_PROFILES);
      return BUILTIN_GAME_PROFILES;
    }
  }, []);

  const openProfileCreator = useCallback((profileId: string | null = null) => {
    setProfileCreatorSource(profileId);
    setActivePage("profileCreator");
  }, []);

  const deleteGameProfileDraft = useCallback(async (profileId: string) => {
    const profile = findProfileInList(gameProfiles, profileId);
    const confirmed = window.confirm(`Delete draft "${profile.displayName}"? This only removes the custom game profile draft.`);
    if (!confirmed) return;
    await invoke<string>("delete_game_profile_draft", { profileId });
    if (profileCreatorSource === profileId) setProfileCreatorSource(null);
    await refreshGameProfiles();
  }, [gameProfiles, profileCreatorSource, refreshGameProfiles]);

  const duplicateGameProfileDraft = useCallback(async (profileId: string) => {
    try {
      const profile = findProfileInList(gameProfiles, profileId);
      const { makeDraft } = await import("./pages/ProfileCreator/ProfileCreatorPage");
      const draft = makeDraft(profile);
      const duplicateId = `user.${crypto.randomUUID()}`;
      const duplicate = { ...draft, profileId: duplicateId, profileType: "user_created", status: "draft", overview: { ...draft.overview, profileTitle: `${draft.overview.profileTitle || profile.displayName} Copy` } };
      await invoke("save_game_profile_draft", { profileId: duplicateId, draft: duplicate });
      await refreshGameProfiles();
      openProfileCreator(duplicateId);
    } catch (error) {
      window.alert(`Could not duplicate profile: ${String(error)}`);
    }
  }, [gameProfiles, openProfileCreator, refreshGameProfiles]);

  const activateProfileRuntime = useCallback(async (profile: GameProfile, options: { page?: AppPage; previewSetup?: boolean } = {}) => {
    const requestId = profileRuntimeRequestRef.current + 1;
    profileRuntimeRequestRef.current = requestId;
    setProfileSwitching(true);
    setProfileRuntimeError(null);
    setHomeOpenMod(null);
    setCurrentGameProfile(profile);
    setDraftRuntimeProfileId(profile.lifecycleState === "draft" ? profile.profileId : null);
    window.dispatchEvent(new CustomEvent("tsuki-profile-runtime-switching", { detail: { profileId: profile.profileId } }));

    try {
      const runtime = await invoke<ActiveProfileRuntime>("activate_game_profile_runtime", { profileId: profile.profileId, profile });
      if (profileRuntimeRequestRef.current !== requestId) return runtime;
      setCurrentGameProfile(profile);
      setProfileRuntime(runtime);
      setProfileRuntimeError(runtime.error ?? null);
      safeLocalStorageSet("tsuki-current-game-profile-id", profile.profileId);
      safeSessionStorageSet(INSTALLED_SESSION_CACHE_INVALIDATED_AT_KEY, String(Date.now()));
      window.dispatchEvent(new CustomEvent("tsuki-current-game-profile-changed", { detail: { profile, runtime } }));
      setProfileCreatorSource(null);
      const nextPage = options.page ?? (options.previewSetup ? "settings" : "home");
      if (nextPage === "settings") {
        setSettingsRoute({ scope: "profile", profileId: profile.profileId, origin: "manager", initialCategory: options.previewSetup ? "profileSetup" : "profileOverview" });
      }
      setActivePage(nextPage);
      if (options.previewSetup) setSetupWizardOpen(true);
      setRefreshTick((tick) => tick + 1);
      return runtime;
    } catch (error) {
      if (profileRuntimeRequestRef.current === requestId) {
        setProfileRuntime(null);
        setProfileRuntimeError(errorMessage(error));
        setActivePage("games");
      }
      throw error;
    } finally {
      if (profileRuntimeRequestRef.current === requestId) {
        setProfileSwitching(false);
      }
    }
  }, []);
  const openDraftRuntimeProfile = useCallback(async (profileId: string, options: { previewSetup?: boolean } = {}) => {
    const profiles = await refreshGameProfiles();
    const nextProfile = findProfileInListExact(profiles, profileId);
    if (!nextProfile) {
      throw new Error(`Game profile was not found: ${profileId}`);
    }
    await activateProfileRuntime(nextProfile, { page: options.previewSetup ? "settings" : "home", previewSetup: options.previewSetup });
  }, [activateProfileRuntime, refreshGameProfiles]);

  const openSettingsPage = useCallback((route: SettingsRouteState) => {
    previousSettingsPageRef.current = activePage === "settings" ? previousSettingsPageRef.current : activePage;
    setSettingsRoute(route);
    setActivePage("settings");
  }, [activePage]);

  const goBackFromSettings = useCallback(() => {
    const previous = previousSettingsPageRef.current === "settings" ? "home" : previousSettingsPageRef.current;
    setActivePage(previous);
  }, []);

  const changeProfileVersion = useCallback(async (profileId: string, version: string) => {
    try {
      const profile = gameProfiles.find((item) => item.profileId === profileId);
      if (!profile?.gameVersions?.includes(version)) throw new Error("Unsupported game version.");
      const settings = await invoke<Record<string, unknown>>("get_profile_settings", { profileId });
      await invoke("save_profile_settings", { profileId, settings: { ...settings, gameVersion: version } });
      const refreshed = await refreshGameProfiles();
      const updated = refreshed.find((item) => item.profileId === profileId);
      if (updated && currentGameProfile.profileId === profileId) {
        const runtime = await invoke<ActiveProfileRuntime>("activate_game_profile_runtime", { profileId, profile: updated });
        setCurrentGameProfile(updated);
        setProfileRuntime(runtime);
      }
    } catch (error) {
      window.alert(`Could not save game version: ${String(error)}`);
    }
  }, [gameProfiles, refreshGameProfiles, currentGameProfile.profileId]);

  useEffect(() => {
    let cancelled = false;
    const onSettingsChanged = (event: Event) => {
      const profileId = (event as CustomEvent<{ profileId: string }>).detail?.profileId;
      if (!profileId) return;
      void refreshGameProfiles().then(async (profiles) => {
        const profile = profiles.find((item) => item.profileId === profileId);
        if (cancelled || !profile || profileId !== currentGameProfile.profileId) return;
        const runtime = await invoke<ActiveProfileRuntime>("activate_game_profile_runtime", { profileId, profile });
        if (cancelled) return;
        setCurrentGameProfile(profile);
        setProfileRuntime(runtime);
      }).catch((error) => setProfileRuntimeError(errorMessage(error)));
    };
    window.addEventListener("tsuki-profile-settings-changed", onSettingsChanged);
    return () => { cancelled = true; window.removeEventListener("tsuki-profile-settings-changed", onSettingsChanged); };
  }, [currentGameProfile.profileId, refreshGameProfiles]);

  const goToPage = (page: AppPage) => {
    if (page === "settings") {
      openSettingsPage({ scope: "profile", profileId: currentGameProfile.profileId, origin: "manager" });
      return;
    }
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

  const openDependencyNative = (dependency: DependencyDefinition) => {
    const summary = dependencyToSourceSummary(dependency);
    if (!summary) return false;
    setSetupWizardOpen(false);
    openSourceModInApp(summary);
    return true;
  };


  const selectGameProfile = useCallback((profileId: string) => {
    const nextProfile = findProfileInListExact(gameProfiles, profileId);
    if (!nextProfile) {
      setProfileRuntimeError(`Game profile was not found: ${profileId}`);
      return;
    }
    void activateProfileRuntime(nextProfile, { page: "home" })
      .catch((error) => console.warn("Failed to activate game profile:", error));
  }, [activateProfileRuntime, gameProfiles]);
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
    let cancelled = false;
    let updateTimer: number | null = null;

    const finishBoot = async () => {
      let settings: AppSettings | null = null;
      let profiles = BUILTIN_GAME_PROFILES;

      try {
        setBootMessage("Loading settings...");
        settings = normalizeAppSettings(await invoke<AppSettings>("get_app_settings"));
        if (cancelled) return;
        setActiveThemeId(settings.themeId);
        safeLocalStorageSet(THEME_STORAGE_KEY, settings.themeId);
        document.documentElement.dataset.theme = settings.themeId;
        applyAppearanceSettings(settings);
        autoUpdateChecksRef.current = settings.autoUpdateChecks;
        setAppCapabilities({
          isDeveloperMode: settings.developerMode ?? false,
          canEditOfficialProfiles: settings.developerMode ?? false,
        });
      } catch (error) {
        console.warn("Failed to load app settings:", error);
      }

      try {
        setBootMessage("Loading game profiles...");
        profiles = await refreshGameProfiles();
        if (cancelled) return;
      } catch (error) {
        console.warn("Failed to load game profile drafts:", error);
      }

      const storedProfileId = settings?.currentGameProfileId
        ?? settings?.activeGameProfileId
        ?? window.localStorage.getItem("tsuki-current-game-profile-id");
      const persistedProfile = findProfileInListExact(profiles, storedProfileId) ?? getGameProfile(BUILTIN_PAYDAY3_PROFILE_ID);

      try {
        setBootMessage("Restoring session...");
        await activateProfileRuntime(persistedProfile, { page: settings ? startupPageFromSettings(settings) : "home" });
        if (cancelled) return;
        setBootMessage("Loading profile data...");
      } catch (error) {
        console.warn("Failed to activate startup game profile:", error);
        if (cancelled) return;
        setBootMessage("Profile runtime unavailable. Opening Tsuki...");
      }

      if (cancelled) return;
      setBootMessage("Ready.");
      setBootReady(true);
      window.performance.mark?.("tsuki-boot-ready-before-background-update-check");
      updateTimer = window.setTimeout(() => {
        if (!cancelled && autoUpdateChecksRef.current) void checkAppUpdate(false);
      }, 8000);
    };

    void finishBoot();

    return () => {
      cancelled = true;
      if (updateTimer !== null) window.clearTimeout(updateTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activateProfileRuntime, refreshGameProfiles]);

  useEffect(() => {
    if (!bootReady) return;

    const timer = window.setTimeout(() => {
      invoke("migrate_receipts_to_v2")
        .catch((error) => console.warn("Receipt v2 migration failed:", error));
    }, 1800);

    return () => window.clearTimeout(timer);
  }, [bootReady]);

  useEffect(() => {
    if (!bootReady) return;

    const timer = window.setTimeout(() => {
      invoke<string>("refresh_source_index_v2_remote_if_stale")
        .then((message) => console.info("Source Index v2:", message))
        .catch((error) => console.warn("Source Index v2 stale refresh failed:", error));
    }, 12000);

    return () => window.clearTimeout(timer);
  }, [bootReady]);

  useEffect(() => {
    if (!bootReady) return;

    const cached = readReceiptUpdateCheckCache();
    if (cached?.savedAt && Date.now() - cached.savedAt < TSUKI_RECEIPT_UPDATE_CHECK_THROTTLE_MS) {
      return;
    }

    const timer = window.setTimeout(() => {
      invoke<SourceUpdateStatus[]>("check_installed_source_updates", { profileId: currentGameProfile.profileId })
        .then((updates) => writeReceiptUpdateCheckCache(updates, "launch"))
        .catch(() => {
          // Silent launch check. Manual Check Updates still reports errors in Installed.
        });
    }, 45000);

    return () => window.clearTimeout(timer);
  }, [bootReady, currentGameProfile.profileId]);

  useEffect(() => {
    if (!bootReady) return;
    if (window.localStorage.getItem(SETUP_WIZARD_DONE_KEY) !== "true") {
      window.setTimeout(() => setSetupWizardOpen(true), 450);
    }
  }, [bootReady]);

  useEffect(() => {
    safeLocalStorageSet("tsuki-active-page", activePage);
  }, [activePage]);

  useEffect(() => {
    const invalidateInstalledCache = () => {
      safeSessionStorageSet(INSTALLED_SESSION_CACHE_INVALIDATED_AT_KEY, String(Date.now()));
    };

    window.addEventListener("tsuki-data-refresh", invalidateInstalledCache);
    return () => window.removeEventListener("tsuki-data-refresh", invalidateInstalledCache);
  }, []);

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

      const progress = typeof detail.progress === "number" && Number.isFinite(detail.progress) ? Math.max(0, Math.min(100, detail.progress)) : null;
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
            ? { ...current, detail: current.detail ? `${current.detail} (waiting for an update)` : "Waiting for a task update.", progress: null }
            : current);
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
    safeLocalStorageSet(THEME_STORAGE_KEY, activeThemeId);
    document.documentElement.dataset.theme = activeThemeId;
  }, [activeThemeId]);


  const openSecretDebugPanel = useCallback(() => {
    setDebugPanelOpen(true);
  }, []);

  const profileRuntimeKey = `${profileRuntime?.profileId ?? currentGameProfile.profileId}:${profileRuntime?.definitionRevision ?? 0}:${currentGameProfile.gameVersion ?? "default"}`;
  const profileRuntimeReady = Boolean(profileRuntime && profileRuntime.profileId === currentGameProfile.profileId && profileRuntime.ready !== false && !profileSwitching && !profileRuntimeError);

  const page = useMemo(() => {
    switch (activePage) {
      case "browse":
        return <BrowsePage key={`browse-${profileRuntimeKey}`} initialMod={homeOpenMod} onInitialModConsumed={() => setHomeOpenMod(null)} currentGameProfile={currentGameProfile} profileRuntime={profileRuntime} profileSwitching={profileSwitching || !profileRuntimeReady} />;
      case "installed":
        return <InstalledPage key={`installed-${profileRuntimeKey}`} currentGameProfile={currentGameProfile} profileRuntime={profileRuntime} profileSwitching={profileSwitching || !profileRuntimeReady} />;
      case "profiles":
        return <ProfilesPage currentGameProfile={currentGameProfile} draftProfiles={gameProfiles.filter((profile) => profile.lifecycleState === "draft")} onEditDraft={openProfileCreator} onDeleteDraft={deleteGameProfileDraft} />;
      case "games":
        return <GameSelectorPage profiles={gameProfiles} currentProfile={currentGameProfile} appCapabilities={appCapabilities} onSelectProfile={selectGameProfile} onVersionChange={(profileId, version) => void changeProfileVersion(profileId, version)} onCreateProfile={() => openProfileCreator(null)} onEditProfile={(profileId) => { void refreshGameProfiles().then(() => openProfileCreator(profileId)); }} onDeleteDraft={deleteGameProfileDraft} onDuplicateProfile={duplicateGameProfileDraft} onOpenSettings={() => openSettingsPage({ scope: "global", origin: "select-game" })} onOpenProfileSettings={(profileId: string) => openSettingsPage({ scope: "profile", profileId, origin: "select-game", initialCategory: "profileOverview" })} />;
      case "profileCreator":
        return <ProfileCreatorPage key={profileCreatorSource ?? "new-profile"} sourceProfile={profileCreatorSource ? findProfileInList(gameProfiles, profileCreatorSource) : null} canEditOfficialProfiles={appCapabilities.canEditOfficialProfiles} onDraftSaved={async () => { await refreshGameProfiles(); }} onOpenProfile={async (profileId, options) => { await openDraftRuntimeProfile(profileId, { previewSetup: options.previewSetup }); }} onBack={() => { void refreshGameProfiles(); setProfileCreatorSource(null); setActivePage("games"); }} />;
      case "repair":
        return <RepairPage profileId={currentGameProfile.profileId} />;
      case "backups":
        return <BackupsPage />;
      case "settings": {
        const settingsProfile = settingsRoute.scope === "profile"
          ? findProfileInListExact(gameProfiles, settingsRoute.profileId) ?? currentGameProfile
          : null;
        const settingsProfileActive = Boolean(settingsProfile && settingsProfile.profileId === currentGameProfile.profileId);
        return <SettingsPage activeThemeId={activeThemeId} onThemeChange={setActiveThemeId} profile={settingsProfile} profileRuntime={settingsProfileActive ? profileRuntime : null} isProfileActive={settingsProfileActive && profileRuntimeReady} openedFrom={settingsRoute.origin} initialCategory={settingsRoute.scope === "profile" ? settingsRoute.initialCategory : undefined} onBack={goBackFromSettings} onBackToGames={() => setActivePage("games")} onOpenProfileCreator={(profileId) => openProfileCreator(profileId)} onActivateProfile={selectGameProfile} />;
      }
      case "home":
      default:
        return <HomePage key={`home-${profileRuntimeKey}`} onOpenPage={goToPage} onOpenModInApp={openSourceModInApp} refreshTick={refreshTick} currentGameProfile={currentGameProfile} profileRuntime={profileRuntime} profileSwitching={profileSwitching || !profileRuntimeReady} />;
    }
  }, [activePage, activeThemeId, refreshTick, homeOpenMod, currentGameProfile, profileRuntime, profileRuntimeKey, profileRuntimeReady, profileSwitching, selectGameProfile, appCapabilities, profileCreatorSource, gameProfiles, settingsRoute, openProfileCreator, deleteGameProfileDraft, duplicateGameProfileDraft, refreshGameProfiles, openDraftRuntimeProfile, openSettingsPage, goBackFromSettings]);

  const specialFlowPages: AppPage[] = ["games", "profileCreator"];
  const settingsSpecialFlow = activePage === "settings" && settingsRoute.origin === "select-game";
  const specialFlow = specialFlowPages.includes(activePage) || settingsSpecialFlow;
  const draftRuntimeOpen = draftRuntimeProfileId === currentGameProfile.profileId && currentGameProfile.lifecycleState === "draft";
  const profileRuntimeBlocked = !specialFlow && !profileRuntimeReady;
  const profileRuntimeStatus = profileRuntimeError ?? (profileSwitching ? "Switching profile runtime..." : "Loading profile runtime...");

  if (!bootReady) {
    return <BootScreen message={bootMessage} />;
  }

  return (
    <div className="app-shell">
      <WindowTitleBar activePage={activePage} appUpdate={appUpdate} updateBusy={appUpdateBusy} onCheckUpdate={() => checkAppUpdate(true)} onInstallUpdate={installAppUpdate} currentGameProfile={currentGameProfile} profileRuntime={profileRuntime} profileSwitching={profileSwitching || !profileRuntimeReady} specialFlow={specialFlow} />
      {specialFlow ? (
        <main className="special-flow-shell">
          <PageCrashGuard pageName={activePage}><Suspense fallback={<div className="page-loading-state" role="status">Loading {activePage === "profileCreator" ? "Profile Creator" : activePage}...</div>}>{page}</Suspense></PageCrashGuard>
        </main>
      ) : (
        <div className="app-body">
          <Sidebar activePage={activePage} currentGameProfile={currentGameProfile} onChangePage={goToPage} taskProgress={taskProgress} onOpenDebug={openSecretDebugPanel} />
          <main className="app-main">
            {!profileRuntimeBlocked && <ManagedLoaderStatus profileId={currentGameProfile.profileId} />}
            {draftRuntimeOpen && <div className="draft-runtime-banner" role="status"><div><strong>Draft Profile</strong><span>Changes made in Profile Creator are not published.</span></div><button type="button" onClick={() => openProfileCreator(currentGameProfile.profileId)}>Return to Profile Creator</button><button type="button" onClick={() => setSetupWizardOpen(true)}>Preview Setup</button></div>}
            <div className="page-scroll">
              {profileRuntimeBlocked ? (
                <section className="profile-runtime-state" role={profileRuntimeError ? "alert" : "status"}>
                  <strong>{profileRuntimeError ? "Profile failed to initialize" : "Loading profile runtime"}</strong>
                  <span>{profileRuntimeStatus}</span>
                  {profileRuntimeError && <button type="button" onClick={() => setActivePage("games")}>Select Game</button>}
                </section>
              ) : (
                <PageCrashGuard pageName={activePage}><Suspense fallback={<div className="page-loading-state" role="status">Loading {activePage}...</div>}>{page}</Suspense></PageCrashGuard>
              )}
            </div>
            {debugPanelOpen && profileRuntime && !specialFlow && (
              <aside className="profile-runtime-debug-panel" aria-label="Active profile runtime diagnostics">
                <strong>Active Runtime</strong>
                <span>Profile: {profileRuntime.profileId}</span>
                <span>Game: {profileRuntime.gameId}</span>
                <span>Installed state: {profileRuntime.installedStatePath}</span>
                <span>Receipts: {profileRuntime.receiptsPath}</span>
                <span>Index: {profileRuntime.sourceIndexPath}</span>
                <span>Browse cache: {profileRuntime.browseCachePath}</span>
                <span>Game root: {profileRuntime.gameRoot ?? "Not set"}</span>
                <span>Executable: {profileRuntime.executable ?? "Not set"}</span>
                <span>Receipts loaded: {profileRuntime.loadedReceiptCount}</span>
                <span>Installed loaded: {profileRuntime.loadedInstalledModCount}</span>
              </aside>
            )}
            {debugPanelOpen && <Suspense fallback={null}><DebugCenter open={debugPanelOpen} activeProfileId={currentGameProfile.profileId} onClose={() => setDebugPanelOpen(false)} onOpenSetupWizard={() => setSetupWizardOpen(true)} /></Suspense>}
          </main>
        </div>
      )}
      <DragDropInstallWizard currentGameProfile={currentGameProfile} gameProfiles={gameProfiles} requireGameChoice={activePage === "games"} onInstalled={() => setActivePage("installed")} />
      <SetupWizard
        open={setupWizardOpen}
        currentGameProfile={currentGameProfile}
        profileRuntime={profileRuntime}
        onClose={() => setSetupWizardOpen(false)}
        onOpenSettings={() => { setSetupWizardOpen(false); openSettingsPage({ scope: "profile", profileId: currentGameProfile.profileId, origin: "manager", initialCategory: "profileSetup" }); }}
        onOpenBrowse={() => { setActivePage("browse"); }}
        onOpenDependency={openDependencyNative}
      />
    </div>
  );
}

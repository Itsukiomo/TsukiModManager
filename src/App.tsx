import "./App.css";
import { invoke } from "@tauri-apps/api/core";
import { Component, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { WindowTitleBar } from "./components/WindowTitleBar/WindowTitleBar";
import type { AppPage } from "./models/navigation";
import type { AppSettings } from "./models/settings";
import type { SourceModSummary, InstalledSourceMatch, SourceUpdateStatus } from "./models/source";
import type { PakModFile, PakScanResult } from "./models/mod";
import tsukiLogo from "./assets/tsuki-logo.png";
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

interface ManagedInstallInfo {
  id: string;
  displayName: string;
  source: string;
  sourceModId?: string | null;
  sourceFileId?: string | null;
  pageUrl?: string | null;
  enabled: boolean;
  fileCount: number;
  pakFileCount: number;
  nonPakFileCount: number;
  disabledFolder: string;
}

interface InstalledStateFile {
  relativePath: string;
  location: string;
  fileName: string;
  fileType: string;
  sizeBytes?: number | null;
  sha256?: string | null;
  live: boolean;
}

interface InstalledStateRecord {
  uid: string;
  id: string;
  name: string;
  source: string;
  version?: string | null;
  author?: string | null;
  filename: string;
  fileId?: string | null;
  fileType: string;
  sha256?: string | null;
  folderId: string;
  location: string;
  receiptId?: string | null;
  sourceModId?: string | null;
  sourceFileId?: string | null;
  pageUrl?: string | null;
  thumbnailUrl?: string | null;
  bannerUrl?: string | null;
  enabled: boolean;
  installedAtUnix?: number | null;
  files: InstalledStateFile[];
}


interface HomeLiveCache {
  savedAt: number;
  nexusMods: SourceModSummary[];
  modworkshopMods: SourceModSummary[];
  installedMods: SourceModSummary[];
  installedSourceKeys: string[];
  installedNames: string[];
  localPakMods: PakModFile[];
}

const HOME_LIVE_CACHE_KEY = "tsuki-home-live-state:v1.07.24";

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


function readHomeLiveCache(): HomeLiveCache | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HOME_LIVE_CACHE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;

    return {
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
      nexusMods: Array.isArray(parsed.nexusMods) ? parsed.nexusMods : [],
      modworkshopMods: Array.isArray(parsed.modworkshopMods) ? parsed.modworkshopMods : [],
      installedMods: Array.isArray(parsed.installedMods) ? parsed.installedMods : [],
      installedSourceKeys: Array.isArray(parsed.installedSourceKeys) ? parsed.installedSourceKeys.filter((value: unknown) => typeof value === "string") : [],
      installedNames: Array.isArray(parsed.installedNames) ? parsed.installedNames.filter((value: unknown) => typeof value === "string") : [],
      localPakMods: Array.isArray(parsed.localPakMods) ? parsed.localPakMods : [],
    };
  } catch {
    return null;
  }
}

function writeHomeLiveCache(cache: HomeLiveCache) {
  try {
    window.localStorage.setItem(HOME_LIVE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Optional dashboard cache.
  }
}

function pakDisplayName(fileName: string) {
  return fileName
    .replace(/\.disabled$/i, "")
    .replace(/\.(pak|ucas|utoc)$/i, "")
    .replace(/[_-]+P$/i, "")
    .replace(/[_-]+/g, " ")
    .trim() || fileName;
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

function compactHomeName(value: string) {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function homeModKey(mod: SourceModSummary) {
  return `${mod.source}-${mod.sourceId}`;
}

function installedKeyFromRecord(record: InstalledStateRecord) {
  const sourceId = record.sourceModId ?? record.id;
  return `${record.source}-${sourceId}`;
}

function installedKeyFromManaged(install: ManagedInstallInfo) {
  return install.sourceModId ? `${install.source}-${install.sourceModId}` : null;
}

function sourceSummaryFromInstalledRecord(record: InstalledStateRecord): SourceModSummary | null {
  const sourceId = record.sourceModId ?? record.id;

  if (!record.source || !sourceId) return null;

  const fileAliases = (record.files ?? [])
    .map((file) => file.fileName)
    .filter((name) => name && name.trim().length > 0);

  return {
    source: record.source as SourceModSummary["source"],
    sourceId,
    name: record.name || record.filename || `${record.source} ${sourceId}`,
    author: record.author,
    version: record.version,
    thumbnailUrl: record.thumbnailUrl,
    bannerUrl: record.bannerUrl,
    pageUrl: record.pageUrl,
    updatedAt: record.installedAtUnix ? String(record.installedAtUnix) : null,
    downloads: null,
    likes: null,
    shortDescription: `Installed by Tsuki · ${fileAliases.length} tracked file${fileAliases.length === 1 ? "" : "s"}.`,
    tags: [...new Set([record.location, record.fileType, record.filename, ...fileAliases.slice(0, 8)].filter(Boolean))],
  };
}


function homeTimeValue(mod: SourceModSummary) {
  const raw = String(mod.updatedAt ?? "").trim();

  if (!raw) return 0;

  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric < 4_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortHomeSourceMods(mods: SourceModSummary[]) {
  return [...mods].sort((a, b) => homeTimeValue(b) - homeTimeValue(a));
}

function homeUpdatedLabel(mod: SourceModSummary) {
  const timestamp = homeTimeValue(mod);

  if (!timestamp) return null;

  const diff = Math.max(0, Date.now() - timestamp);
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const month = 30 * day;

  if (diff < hour) return "Updated under 1h ago";
  if (diff < day) return `Updated ${Math.max(1, Math.floor(diff / hour))}h ago`;
  if (diff < month) return `Updated ${Math.max(1, Math.floor(diff / day))}d ago`;

  return new Date(timestamp).toLocaleDateString();
}

function mergeHomeMods(source: "nexus" | "modworkshop", ...groups: SourceModSummary[][]) {
  const seen = new Set<string>();
  const result: SourceModSummary[] = [];

  for (const group of groups) {
    for (const mod of group) {
      if (!mod || mod.source !== source || !mod.sourceId || !mod.name) continue;

      const key = homeModKey(mod);
      if (seen.has(key)) continue;

      seen.add(key);
      result.push(mod);
    }
  }

  return sortHomeSourceMods(result).slice(0, 8);
}

function SourceMiniCard({
  mod,
  onBrowse,
  installed,
  onOpenMod,
}: {
  mod: SourceModSummary;
  onBrowse: () => void;
  installed: boolean;
  onOpenMod: (mod: SourceModSummary) => void;
}) {
  const tags = (mod.tags ?? []).filter(Boolean).slice(0, 3);
  const sourceLabel = mod.source === "nexus" ? "Nexus Mods" : "ModWorkshop";

  return (
    <article className={`home-showcase-card ${installed ? "installed" : ""}`} role="button" tabIndex={0} onClick={() => onOpenMod(mod)} onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") onOpenMod(mod);
    }}>
      <div className="home-card-thumb">
        {mod.thumbnailUrl ? <img src={mod.thumbnailUrl} alt="" /> : <div className="home-source-fallback">{mod.source === "nexus" ? "NX" : "MW"}</div>}
        <span>{sourceLabel}</span>
        {installed && <strong className="home-installed-badge">Installed</strong>}
      </div>
      <div className="home-card-body">
        <h3>{mod.name}</h3>
        <p className="home-card-author">{mod.author ? `by ${mod.author}` : "Community mod"}{homeUpdatedLabel(mod) ? ` · ${homeUpdatedLabel(mod)}` : ""}</p>
        <p>{mod.shortDescription || "Review the files, install safely, and keep your PAYDAY 3 setup organized."}</p>
        <div className="home-card-tags">
          {tags.length > 0 ? tags.map((tag) => <span key={tag}>{tag}</span>) : <span>No tags cached</span>}
        </div>
      </div>
      <button className={`home-install-button ${installed ? "installed" : ""}`} type="button" onClick={(event) => {
        event.stopPropagation();
        if (installed) onOpenMod(mod);
        else onBrowse();
      }}>
        {installed ? "Installed" : "Install"}
      </button>
    </article>
  );
}

function loadCachedHomeMods(source: "nexus" | "modworkshop") {
  const mods: SourceModSummary[] = [];

  for (const key of Object.keys(window.localStorage)) {
    if (!key.toLowerCase().includes("source-cache")) continue;

    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? "{}");
      const candidates = Array.isArray(parsed.mods) ? parsed.mods : [];

      for (const mod of candidates) {
        if (!mod || mod.source !== source || !mod.sourceId) continue;
        mods.push(mod);
      }
    } catch {
      // Cache format changed or is not a source cache.
    }
  }

  return mergeHomeMods(source, mods);
}

function HomePage({ onOpenPage, onOpenModInApp, refreshTick }: { onOpenPage: (page: AppPage) => void; onOpenModInApp: (mod: SourceModSummary) => void; refreshTick: number }) {
  const cachedHome = useMemo(() => readHomeLiveCache(), []);
  const [nexusMods, setNexusMods] = useState<SourceModSummary[]>(() => cachedHome?.nexusMods?.length ? cachedHome.nexusMods : loadCachedHomeMods("nexus"));
  const [modworkshopMods, setModworkshopMods] = useState<SourceModSummary[]>(() => cachedHome?.modworkshopMods?.length ? cachedHome.modworkshopMods : loadCachedHomeMods("modworkshop"));
  const [installedMods, setInstalledMods] = useState<SourceModSummary[]>(() => cachedHome?.installedMods ?? []);
  const [localPakMods, setLocalPakMods] = useState<PakModFile[]>(() => cachedHome?.localPakMods ?? []);
  const [cachedInstalledSourceKeys, setCachedInstalledSourceKeys] = useState<string[]>(() => cachedHome?.installedSourceKeys ?? []);
  const [cachedInstalledNames, setCachedInstalledNames] = useState<string[]>(() => cachedHome?.installedNames ?? []);
  const [managed, setManaged] = useState<ManagedInstallInfo[]>([]);
  const [installedState, setInstalledState] = useState<InstalledStateRecord[]>([]);
  const [status, setStatus] = useState(cachedHome ? `Home loaded live cache from ${Math.max(1, Math.round((Date.now() - cachedHome.savedAt) / 1000))}s ago. Refreshing quietly...` : "Home is loading live source/state info...");
  const [feedBusy, setFeedBusy] = useState(false);
  const feedBusyRef = useRef(false);
  const lastHomeRefreshRef = useRef(0);

  const installedSourceKeys = useMemo(() => {
    const keys = new Set<string>(cachedInstalledSourceKeys);

    for (const install of managed) {
      const key = installedKeyFromManaged(install);
      if (key) keys.add(key);
    }

    for (const record of installedState) {
      keys.add(installedKeyFromRecord(record));
    }

    return keys;
  }, [cachedInstalledSourceKeys, installedState, managed]);

  const installedNames = useMemo(() => {
    const names = new Set<string>(cachedInstalledNames);

    for (const install of managed) names.add(compactHomeName(install.displayName));
    for (const record of installedState) names.add(compactHomeName(record.name));
    for (const pak of localPakMods) names.add(compactHomeName(pakDisplayName(pak.fileName)));

    return names;
  }, [cachedInstalledNames, installedState, localPakMods, managed]);


  const openHomeMod = (mod: SourceModSummary) => {
    onOpenModInApp(mod);
  };

  const refreshFeeds = async (mode: "auto" | "manual" = "manual") => {
    if (feedBusyRef.current) return;

    const now = Date.now();
    if (mode === "auto" && now - lastHomeRefreshRef.current < 60_000) return;

    feedBusyRef.current = true;
    lastHomeRefreshRef.current = now;
    setFeedBusy(true);
    setStatus(mode === "manual" ? "Refreshing live Nexus, ModWorkshop, installed state, and local files..." : "Updating Home from live source/state info...");

    try {
      const [nexus, modworkshop, installs, state, sourceIndex, pakScan] = await Promise.allSettled([
        invoke<SourceModSummary[]>("fetch_source_mods_page", { source: "nexus", page: 1, sort: "updated" }),
        invoke<SourceModSummary[]>("fetch_modworkshop_browse_live_page", { page: 1, sort: "updated" }),
        invoke<ManagedInstallInfo[]>("list_managed_installs"),
        invoke<InstalledStateRecord[]>("list_installed_state_records"),
        invoke<SourceModSummary[]>("list_source_index", { source: null, limit: 600 }).catch(() => []),
        invoke<PakScanResult>("scan_pak_mods").catch(() => null),
      ]);

      const stateRecords = state.status === "fulfilled" ? state.value : [];
      const installedSummaries = stateRecords
        .map(sourceSummaryFromInstalledRecord)
        .filter((mod): mod is SourceModSummary => Boolean(mod));
      const uniqueInstalled = [...new Map(installedSummaries.map((mod) => [homeModKey(mod), mod])).values()];
      const indexed = sourceIndex.status === "fulfilled" ? sourceIndex.value : [];
      const nextLocalPakMods = pakScan.status === "fulfilled" && pakScan.value ? pakScan.value.pakMods.filter((pak) => pak.enabled).slice(0, 200) : localPakMods;

      const liveNexus = nexus.status === "fulfilled" ? nexus.value : [];
      const liveModworkshop = modworkshop.status === "fulfilled" ? modworkshop.value : [];
      const indexedNexus = indexed.filter((mod) => mod.source === "nexus");
      const indexedModworkshop = indexed.filter((mod) => mod.source === "modworkshop");

      const nextNexus = liveNexus.length > 0
        ? mergeHomeMods("nexus", liveNexus)
        : mergeHomeMods("nexus", indexedNexus, loadCachedHomeMods("nexus"));

      const nextModworkshop = liveModworkshop.length > 0
        ? mergeHomeMods("modworkshop", liveModworkshop)
        : mergeHomeMods("modworkshop", indexedModworkshop, loadCachedHomeMods("modworkshop"));

      const nextManaged = installs.status === "fulfilled" ? installs.value : managed;
      const sourceKeySet = new Set<string>();
      const nameSet = new Set<string>();

      for (const install of nextManaged) {
        const key = installedKeyFromManaged(install);
        if (key) sourceKeySet.add(key);
        nameSet.add(compactHomeName(install.displayName));
      }

      for (const record of stateRecords) {
        sourceKeySet.add(installedKeyFromRecord(record));
        nameSet.add(compactHomeName(record.name));
        nameSet.add(compactHomeName(record.filename));
      }

      for (const pak of nextLocalPakMods) {
        nameSet.add(compactHomeName(pakDisplayName(pak.fileName)));
        nameSet.add(compactHomeName(pak.fileName));
      }

      // v0.99.1: this is NOT hardcoded. Home runs a tiny badge-only proof check
      // against the visible source cards so cached cards can still show Installed correctly.
      // It does not inject installed-state records into Recent Nexus/ModWorkshop anymore.
      const badgeLimit = mode === "manual" ? 40 : 18;
      const visibleBadgeCandidates = [...new Map([...nextNexus, ...nextModworkshop].map((mod) => [homeModKey(mod), mod])).values()].slice(0, badgeLimit);
      const matches = visibleBadgeCandidates.length > 0
        ? await invoke<InstalledSourceMatch[]>("match_installed_source_mods", { sourceMods: visibleBadgeCandidates }).catch(() => [])
        : [];

      for (const match of matches) {
        if (!match.installed) continue;
        sourceKeySet.add(`${match.source}-${match.sourceId}`);

        for (const file of match.matchedFiles ?? []) {
          nameSet.add(compactHomeName(file));
          nameSet.add(compactHomeName(pakDisplayName(file)));
        }
      }

      const installedSourceKeyList = [...sourceKeySet];
      const installedNameList = [...nameSet];

      setInstalledMods(uniqueInstalled);
      setNexusMods(nextNexus);
      setModworkshopMods(nextModworkshop);
      setManaged(nextManaged);
      setInstalledState(stateRecords);
      setLocalPakMods(nextLocalPakMods);
      setCachedInstalledSourceKeys(installedSourceKeyList);
      setCachedInstalledNames(installedNameList);

      writeHomeLiveCache({
        savedAt: Date.now(),
        nexusMods: nextNexus,
        modworkshopMods: nextModworkshop,
        installedMods: uniqueInstalled,
        installedSourceKeys: installedSourceKeyList,
        installedNames: installedNameList,
        localPakMods: nextLocalPakMods,
      });

      setStatus(`Home refreshed. ${installedSourceKeyList.length} source IDs and ${nextLocalPakMods.length} local PAK files are marked as installed. Visible-card badge check ran for ${visibleBadgeCandidates.length} card(s).`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      feedBusyRef.current = false;
      setFeedBusy(false);
    }
  };

  useEffect(() => {
    refreshFeeds("auto");

    const refresh = () => void refreshFeeds("auto");
    const timer = window.setInterval(refresh, 60000);

    window.addEventListener("focus", refresh);
    window.addEventListener("tsuki-data-refresh", refresh);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("tsuki-data-refresh", refresh);
    };
  }, [refreshTick]);

  return (
    <section className="page home-page home-pro">
      <div className="home-pro-hero">
        <div className="home-pro-copy">
          <div className="home-pro-logo-line">
            <img src={tsukiLogo} alt="" />
            <span>PAYDAY 3 mod library</span>
          </div>
          <h1>Welcome back to Tsuki Mod Manager</h1>
          <p>
            Your PAYDAY 3 mod setup lives here: browse, install, repair, back up, and launch without digging through folders.
          </p>
          <div className="home-pro-actions">
            <button className="ghost-button" type="button" onClick={() => onOpenPage("browse")}>Browse mods</button>
            <button className="ghost-button" type="button" onClick={() => onOpenPage("installed")}>Installed</button>
            <button className="ghost-button" type="button" onClick={() => onOpenPage("profiles")}>Profiles</button>
            <button className="ghost-button" type="button" disabled={feedBusy} onClick={() => refreshFeeds("manual")}>
              {feedBusy ? "Refreshing..." : "Refresh feeds"}
            </button>
          </div>
        </div>

        <div className="home-pro-moon">
          <img src={tsukiLogo} alt="" />
        </div>
      </div>

      <div className="home-pro-stats">
        <article>
          <span>Installed Mods</span>
          <strong>{managed.length > 0 ? managed.length : "Ready"}</strong>
          <p>{managed.length > 0 ? "Receipt-tracked" : "Scan your setup"}</p>
        </article>
        <article>
          <span>Profiles</span>
          <strong>Loadouts</strong>
          <p>Save enabled states</p>
        </article>
        <article>
          <span>Repair</span>
          <strong>Tools</strong>
          <p>Receipts, deps, movies</p>
        </article>
        <article>
          <span>Status</span>
          <strong>Ready</strong>
          <p>{status}</p>
        </article>
      </div>

      <HomeModSection
        title="Installed by Tsuki"
        subtitle="Every receipt/state-tracked install Tsuki currently knows about."
        cta="Installed"
        mods={installedMods}
        installedKeys={installedSourceKeys}
        installedNames={installedNames}
        emptyText="No installed-state records yet. Install a mod through Tsuki or open Installed."
        onBrowse={() => onOpenPage("installed")}
        onOpenMod={openHomeMod}
      />

      <LocalPakSection
        mods={localPakMods}
        onBrowse={() => onOpenPage("installed")}
      />

      <HomeModSection
        title="Recent on Nexus Mods"
        subtitle="Fresh community uploads and updates."
        cta="Browse Nexus"
        mods={nexusMods}
        installedKeys={installedSourceKeys}
        installedNames={installedNames}
        emptyText="No Nexus cards loaded yet. Press Refresh feeds or open Browse."
        onBrowse={() => onOpenPage("browse")}
        onOpenMod={openHomeMod}
      />

      <HomeModSection
        title="Recent on ModWorkshop"
        subtitle="Community tools, cosmetics, sound packs, and gameplay tweaks."
        cta="Browse ModWorkshop"
        mods={modworkshopMods}
        installedKeys={installedSourceKeys}
        installedNames={installedNames}
        emptyText="No ModWorkshop cards loaded yet. Press Refresh feeds or open Browse."
        onBrowse={() => onOpenPage("browse")}
        onOpenMod={openHomeMod}
      />
    </section>
  );
}

function HomeModSection({
  title,
  subtitle,
  cta,
  mods,
  installedKeys,
  installedNames,
  emptyText,
  onBrowse,
  onOpenMod,
}: {
  title: string;
  subtitle: string;
  cta: string;
  mods: SourceModSummary[];
  installedKeys: Set<string>;
  installedNames: Set<string>;
  emptyText: string;
  onBrowse: () => void;
  onOpenMod: (mod: SourceModSummary) => void;
}) {
  return (
    <div className="home-pro-section">
      <div className="home-pro-section-head">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <button className="ghost-button compact" type="button" onClick={onBrowse}>{cta}</button>
      </div>
      <div className="home-pro-card-grid">
        {mods.map((mod) => (
          <SourceMiniCard
            key={`${mod.source}-${mod.sourceId}`}
            mod={mod}
            installed={installedKeys.has(homeModKey(mod)) || installedNames.has(compactHomeName(mod.name))}
            onBrowse={onBrowse}
            onOpenMod={onOpenMod}
          />
        ))}
        {mods.length === 0 && <article className="card"><p>{emptyText}</p></article>}
      </div>
    </div>
  );
}


function LocalPakSection({ mods, onBrowse }: { mods: PakModFile[]; onBrowse: () => void }) {
  const shown = mods.slice(0, 16);

  return (
    <div className="home-pro-section">
      <div className="home-pro-section-head">
        <div>
          <h2>Installed local PAK files</h2>
          <p>Every enabled loose PAK-family file Tsuki sees in ~mods. Manual mods live here too.</p>
        </div>
        <button className="ghost-button compact" type="button" onClick={onBrowse}>Open Installed</button>
      </div>
      <div className="home-local-grid">
        {shown.map((pak) => (
          <button className="home-local-chip" type="button" key={`${pak.fullPath}-${pak.fileName}`} onClick={onBrowse}>
            <strong>{pakDisplayName(pak.fileName)}</strong>
            <span>{pak.extension.toUpperCase()} · {(pak.sizeBytes / 1024 / 1024).toFixed(1)} MB</span>
          </button>
        ))}
        {mods.length > shown.length && (
          <button className="home-local-chip more" type="button" onClick={onBrowse}>
            <strong>+{mods.length - shown.length} more</strong>
            <span>Open Installed to view all</span>
          </button>
        )}
        {mods.length === 0 && <article className="card"><p>No enabled loose PAK files detected yet.</p></article>}
      </div>
    </div>
  );
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
  const [managed, setManaged] = useState<ManagedInstallInfo[]>([]);
  const [profiles, setProfiles] = useState<ModProfile[]>([]);
  const [profileName, setProfileName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState("Profiles ready.");

  const refresh = () => {
    Promise.all([
      invoke<ManagedInstallInfo[]>("list_managed_installs"),
      invoke<ModProfile[]>("list_mod_profiles"),
    ])
      .then(([installs, profileList]) => {
        setManaged(installs);
        setProfiles(profileList);
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
  };

  useEffect(() => {
    refresh();
  }, []);

  const toggleManaged = (install: ManagedInstallInfo, enabled: boolean) => {
    setBusyId(install.id);
    invoke<string>("set_managed_install_enabled", { receiptId: install.id, enabled })
      .then((message) => {
        setStatus(message);
        refresh();
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusyId(null));
  };

  const saveProfile = () => {
    setBusyId("save-profile");
    invoke<ModProfile>("save_current_mod_profile", { name: profileName || `Profile ${new Date().toLocaleString()}` })
      .then((profile) => {
        setStatus(`Saved profile: ${profile.name}`);
        setProfileName("");
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

  return (
    <section className="page profiles-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Loadouts</p>
          <h1>Profiles + Tsuki installs</h1>
          <p className="page-description">
            Save the current enabled state, apply it later, and toggle non-PAK installs that Tsuki installed from receipts.
          </p>
        </div>
      </div>

      <article className="card profile-save-card">
        <div>
          <p className="eyebrow">Save current state</p>
          <h2>Create profile</h2>
          <p>{status}</p>
        </div>
        <div className="profile-save-controls">
          <input className="setting-input" value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="Profile name" />
          <button className="ghost-button" type="button" disabled={busyId === "save-profile"} onClick={saveProfile}>
            {busyId === "save-profile" ? "Saving..." : "Save current enabled mods"}
          </button>
        </div>
      </article>

      <div className="profile-grid">
        <article className="card">
          <div className="home-feed-header">
            <div>
              <p className="eyebrow">Profiles</p>
              <h2>Saved loadouts</h2>
            </div>
            <button className="ghost-button compact" type="button" onClick={refresh}>Refresh</button>
          </div>
          <div className="managed-list">
            {profiles.map((profile) => (
              <div className="managed-row" key={profile.id}>
                <div>
                  <strong>{profile.name}</strong>
                  <p>{profile.enabledPakFiles.length} PAK files · {profile.enabledReceiptIds.length} Tsuki installs</p>
                </div>
                <button className="ghost-button compact" disabled={busyId === `profile-${profile.id}`} type="button" onClick={() => applyProfile(profile)}>
                  {busyId === `profile-${profile.id}` ? "Applying..." : "Apply"}
                </button>
              </div>
            ))}
            {profiles.length === 0 && <p>No profiles yet. Save one from your current enabled mods.</p>}
          </div>
        </article>

        <article className="card">
          <div className="home-feed-header">
            <div>
              <p className="eyebrow">Receipt paired</p>
              <h2>Tsuki-installed non-PAK toggles</h2>
            </div>
            <button className="ghost-button compact" type="button" onClick={refresh}>Refresh</button>
          </div>
          <div className="managed-list">
            {managed.map((install) => (
              <div className={`managed-row ${install.enabled ? "" : "disabled"}`} key={install.id}>
                <div>
                  <strong>{install.displayName}</strong>
                  <p>
                    {install.source} #{install.sourceModId ?? "?"} · {install.fileCount} files · {install.nonPakFileCount} non-PAK
                  </p>
                  {!install.enabled && <small>Disabled folder: {install.disabledFolder}</small>}
                </div>
                <button
                  className={`toggle-pill ${install.enabled ? "on" : "off"}`}
                  disabled={busyId === install.id || install.nonPakFileCount === 0}
                  type="button"
                  onClick={() => toggleManaged(install, !install.enabled)}
                  title={install.nonPakFileCount === 0 ? "PAK-only mods use the Installed PAK toggles." : ""}
                >
                  {busyId === install.id ? "..." : install.enabled ? "Enabled" : "Disabled"}
                </button>
              </div>
            ))}
            {managed.length === 0 && <p>No Tsuki install receipts found yet.</p>}
          </div>
        </article>
      </div>
    </section>
  );
}

function BootScreen() {
  return (
    <main className="boot-screen">
      <div className="boot-card">
        <div className="boot-logo-orb">
          <span>月</span>
        </div>
        <div>
          <p className="eyebrow">TSUKI MOD MANAGER</p>
          <h1>Opening Tsuki</h1>
          <p>Loading paths, theme, source cache, and installed state...</p>
        </div>
        <div className="boot-progress">
          <div />
        </div>
      </div>
    </main>
  );
}

export default function App() {
  const [activePage, setActivePage] = useState<AppPage>("home");
  const [refreshTick, setRefreshTick] = useState(0);
  const [bootReady, setBootReady] = useState(false);
  const [homeOpenMod, setHomeOpenMod] = useState<SourceModSummary | null>(null);
  const [taskProgress, setTaskProgress] = useState<TaskProgressState>({ active: false, label: "", detail: "", progress: null });
  const taskProgressTimerRef = useRef<number | null>(null);
  const [activeThemeId, setActiveThemeId] = useState(() => window.localStorage.getItem("tsuki-theme-id") ?? "neon-rift");
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus | null>(null);
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);

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

    try {
      const result = await invoke<AppUpdateStatus>("check_app_update", { manifestUrl: null });
      setAppUpdate(result);

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
    const timer = window.setTimeout(() => {
      void checkAppUpdate(false);
    }, 1600);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setBootReady(true), 1200);
    window.performance.mark?.("tsuki-boot-ready-timer");

    return () => window.clearTimeout(timer);
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
    }, 2500);

    return () => window.clearTimeout(timer);
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

    const onTaskProgress = (event: Event) => {
      const detail = (event as CustomEvent<TaskProgressState>).detail;
      clearProgressTimer();

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
        // Safety net for any task that finishes without sending a final clear event.
        taskProgressTimerRef.current = window.setTimeout(() => {
          setTaskProgress({ active: false, label: "", detail: "", progress: null });
          taskProgressTimerRef.current = null;
        }, 30000);
      }
    };

    window.addEventListener("tsuki-task-progress", onTaskProgress);

    return () => {
      clearProgressTimer();
      window.removeEventListener("tsuki-task-progress", onTaskProgress);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem("tsuki-theme-id", activeThemeId);
    document.documentElement.dataset.theme = activeThemeId;
  }, [activeThemeId]);

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
    return <BootScreen />;
  }

  return (
    <div className="app-shell">
      <WindowTitleBar activePage={activePage} appUpdate={appUpdate} updateBusy={appUpdateBusy} onCheckUpdate={() => checkAppUpdate(true)} onInstallUpdate={installAppUpdate} />
      <div className="app-body">
        <Sidebar activePage={activePage} onChangePage={goToPage} taskProgress={taskProgress} />
        <main className="app-main">
          <div className="page-scroll"><PageCrashGuard pageName={activePage}>{page}</PageCrashGuard></div>
        </main>
      </div>
    </div>
  );
}

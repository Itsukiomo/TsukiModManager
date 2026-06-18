import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import tsukiLogo from "../../assets/tsuki-logo.png";
import type { AppPage } from "../../models/navigation";
import type { PakModFile, PakScanResult } from "../../models/mod";
import type {
  InstalledSourceMatch,
  SourceModDetail,
  SourceModSummary,
} from "../../models/source";

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

interface CachedSourceMods {
  nexus: SourceModSummary[];
  modworkshop: SourceModSummary[];
}

interface HomePageProps {
  onOpenPage: (page: AppPage) => void;
  onOpenModInApp: (mod: SourceModSummary) => void;
  refreshTick: number;
}

const HOME_LIVE_CACHE_KEY = "tsuki-home-live-state:v1.8.3";
const HOME_LEGACY_CACHE_KEYS = ["tsuki-home-live-state:v1.8.2"];
const HOME_CACHE_MAX_AGE_MS = 20 * 60 * 1000;
const HOME_MODWORKSHOP_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const HOME_AUTO_REFRESH_MS = 5 * 60 * 1000;
const HOME_FOCUS_REFRESH_MS = 2 * 60 * 1000;
const HOME_DETAIL_ENRICH_LIMIT = 3;

function readHomeLiveCache(): HomeLiveCache | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HOME_LIVE_CACHE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;

    return {
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
      nexusMods: Array.isArray(parsed.nexusMods) ? parsed.nexusMods : [],
      modworkshopMods: Array.isArray(parsed.modworkshopMods) ? parsed.modworkshopMods : [],
      installedMods: Array.isArray(parsed.installedMods) ? parsed.installedMods : [],
      installedSourceKeys: Array.isArray(parsed.installedSourceKeys)
        ? parsed.installedSourceKeys.filter((value: unknown) => typeof value === "string")
        : [],
      installedNames: Array.isArray(parsed.installedNames)
        ? parsed.installedNames.filter((value: unknown) => typeof value === "string")
        : [],
      localPakMods: Array.isArray(parsed.localPakMods) ? parsed.localPakMods : [],
    };
  } catch {
    return null;
  }
}

function writeHomeLiveCache(cache: HomeLiveCache) {
  try {
    window.localStorage.setItem(HOME_LIVE_CACHE_KEY, JSON.stringify(cache));
    for (const key of HOME_LEGACY_CACHE_KEYS) window.localStorage.removeItem(key);
  } catch {
    // Optional dashboard cache.
  }
}

function cacheIsFresh(cache: HomeLiveCache | null, maxAge = HOME_CACHE_MAX_AGE_MS) {
  return Boolean(cache?.savedAt && Date.now() - cache.savedAt < maxAge);
}

function pakDisplayName(fileName: string) {
  return fileName
    .replace(/\.disabled$/i, "")
    .replace(/\.(pak|ucas|utoc)$/i, "")
    .replace(/[_-]+P$/i, "")
    .replace(/[_-]+/g, " ")
    .trim() || fileName;
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
    shortDescription: `Installed by Tsuki - ${fileAliases.length} tracked file${fileAliases.length === 1 ? "" : "s"}.`,
    tags: [...new Set([record.location, record.fileType, record.filename, ...fileAliases.slice(0, 8)].filter(Boolean))],
  };
}

function relativeHomeDateMs(raw: string) {
  const lower = raw.toLowerCase().trim();
  const now = Date.now();

  if (lower === "just now" || lower.includes("moments ago")) return now;

  const compactMatch = lower.match(/^(\d+)\s*([mhdw])\s*(?:ago)?$/);
  if (compactMatch) {
    const amount = Number(compactMatch[1]);
    const unit = compactMatch[2];
    const multiplier =
      unit === "m" ? 60 * 1000
        : unit === "h" ? 60 * 60 * 1000
          : unit === "d" ? 24 * 60 * 60 * 1000
            : 7 * 24 * 60 * 60 * 1000;
    return now - amount * multiplier;
  }

  const wordMatch = lower.match(/\b(a|an|\d+)\s+(minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks|month|months|year|years)\s+ago\b/);
  if (!wordMatch) return 0;

  const amount = wordMatch[1] === "a" || wordMatch[1] === "an" ? 1 : Number(wordMatch[1]);
  if (!Number.isFinite(amount)) return 0;

  const unit = wordMatch[2];
  const multiplier =
    unit.startsWith("min") ? 60 * 1000
      : unit.startsWith("hour") || unit.startsWith("hr") ? 60 * 60 * 1000
        : unit.startsWith("day") ? 24 * 60 * 60 * 1000
          : unit.startsWith("week") ? 7 * 24 * 60 * 60 * 1000
            : unit.startsWith("month") ? 30 * 24 * 60 * 60 * 1000
              : 365 * 24 * 60 * 60 * 1000;

  return now - amount * multiplier;
}

function homeUpdatedAtMs(mod: SourceModSummary) {
  const raw = String(mod.updatedAt ?? "").trim();
  if (!raw) return 0;

  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric < 4_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;

  return relativeHomeDateMs(raw);
}

function sortHomeSourceMods(mods: SourceModSummary[]) {
  return [...mods].sort((a, b) => homeUpdatedAtMs(b) - homeUpdatedAtMs(a));
}

function homeUpdatedLabel(mod: SourceModSummary) {
  const timestamp = homeUpdatedAtMs(mod);
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

function homeSourceShouldShow(mod: SourceModSummary) {
  const text = [
    mod.name,
    mod.author ?? "",
    mod.shortDescription ?? "",
    mod.pageUrl ?? "",
    ...(mod.tags ?? []),
  ].join(" ").toLowerCase();

  return ![
    "tsuki mod manager",
    "tsukimodmanager",
    "modrex mod manager",
    "moolah mod manager",
    "mod organizer",
    "vortex",
    "mod manager",
    "modmanager",
    "manager setup",
  ].some((marker) => text.includes(marker));
}

function mergeHomeMods(source: "nexus" | "modworkshop", ...groups: SourceModSummary[][]) {
  const seen = new Set<string>();
  const result: SourceModSummary[] = [];

  for (const group of groups) {
    for (const mod of group) {
      if (!mod || mod.source !== source || !mod.sourceId || !mod.name) continue;
      if (!homeSourceShouldShow(mod)) continue;

      const key = homeModKey(mod);
      if (seen.has(key)) continue;

      seen.add(key);
      result.push(mod);
    }
  }

  return sortHomeSourceMods(result).slice(0, 8);
}

function cleanLiveHomeMods(source: "nexus" | "modworkshop", mods: SourceModSummary[]) {
  return mergeHomeMods(source, mods.filter((mod) => {
    if (!mod || mod.source !== source || !mod.sourceId || !mod.name?.trim()) return false;
    if (mod.sourceId === "unknown") return false;
    if (mod.pageUrl && source === "modworkshop" && !mod.pageUrl.includes("modworkshop.net")) return false;
    return true;
  }));
}

function cleanHomeDescription(text?: string | null) {
  return String(text ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isWeakHomeDescription(text?: string | null) {
  const cleaned = cleanHomeDescription(text).toLowerCase();
  return !cleaned
    || cleaned.includes("live modworkshop payday 3 listing card")
    || cleaned.includes("loaded from the payday 3 modworkshop page")
    || cleaned.includes("no description cached")
    || cleaned.includes("no description exposed")
    || cleaned === "source mod page.";
}

function homeCardDescription(mod: SourceModSummary) {
  const description = cleanHomeDescription(mod.shortDescription);
  if (!isWeakHomeDescription(description)) return description;

  if (mod.source === "modworkshop") {
    const tags = (mod.tags ?? []).filter(Boolean).slice(0, 2).join(", ");
    return tags
      ? `ModWorkshop PAYDAY 3 mod tagged ${tags}. Open it for files and full details.`
      : "ModWorkshop PAYDAY 3 mod. Open it for files and full details.";
  }

  return "Open it for files, tags, and full details.";
}

function inferHomeAuthor(mod: SourceModSummary) {
  const direct = cleanHomeDescription(mod.author);
  if (direct) return direct;

  const title = cleanHomeDescription(mod.name);
  const match = title.match(/\s+by\s+([^()\[\]{}|<>]+)$/i);
  return match?.[1]?.trim() || "";
}

function homeDisplayTitle(mod: SourceModSummary) {
  const author = inferHomeAuthor(mod);
  if (!author) return mod.name;

  const escaped = author.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return mod.name.replace(new RegExp(`\\s+by\\s+${escaped}\\s*$`, "i"), "").trim() || mod.name;
}

function mergeHomeDetailIntoSummary(mod: SourceModSummary, detail: SourceModDetail): SourceModSummary {
  const detailDescription = cleanHomeDescription(detail.description || detail.shortDescription || mod.shortDescription);
  const nextTags = [...new Set([...(mod.tags ?? []), ...(detail.tags ?? [])].filter(Boolean))].slice(0, 10);

  return {
    ...mod,
    author: inferHomeAuthor(detail as SourceModSummary) || detail.author || mod.author,
    version: detail.version ?? mod.version,
    thumbnailUrl: detail.thumbnailUrl ?? mod.thumbnailUrl,
    bannerUrl: detail.bannerUrl ?? mod.bannerUrl,
    pageUrl: detail.pageUrl ?? mod.pageUrl,
    updatedAt: detail.updatedAt ?? mod.updatedAt,
    downloads: typeof detail.downloads === "number" ? detail.downloads : mod.downloads,
    likes: typeof detail.likes === "number" ? detail.likes : mod.likes,
    shortDescription: isWeakHomeDescription(detailDescription) ? mod.shortDescription : detailDescription,
    tags: nextTags.length > 0 ? nextTags : mod.tags,
  };
}

function loadCachedHomeModsBySource(): CachedSourceMods {
  const mods: CachedSourceMods = { nexus: [], modworkshop: [] };

  for (const key of Object.keys(window.localStorage)) {
    if (!key.toLowerCase().includes("source-cache")) continue;

    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? "{}");
      const candidates = Array.isArray(parsed.mods) ? parsed.mods : [];

      for (const mod of candidates) {
        if (!mod || !mod.sourceId) continue;
        if (mod.source === "nexus") mods.nexus.push(mod);
        if (mod.source === "modworkshop") mods.modworkshop.push(mod);
      }
    } catch {
      // Cache format changed or is not a source cache.
    }
  }

  return {
    nexus: mergeHomeMods("nexus", mods.nexus),
    // ModWorkshop Home membership must come from the live public listing.
    // Old source-index records can include deleted or unavailable cards.
    modworkshop: [],
  };
}

async function invokeWithTimeout<T>(command: string, args: Record<string, unknown>, timeoutMs: number, message: string) {
  return await Promise.race([
    invoke<T>(command, args),
    new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error(message)), timeoutMs)),
  ]);
}

function SourceMiniCard({
  mod,
  installed,
  onOpenMod,
}: {
  mod: SourceModSummary;
  installed: boolean;
  onOpenMod: (mod: SourceModSummary) => void;
}) {
  const tags = (mod.tags ?? []).filter(Boolean).slice(0, 3);
  const sourceLabel = mod.source === "nexus" ? "Nexus Mods" : "ModWorkshop";
  const author = inferHomeAuthor(mod);
  const title = homeDisplayTitle(mod);
  const description = homeCardDescription(mod);
  const updatedLabel = homeUpdatedLabel(mod) || sourceLabel;

  const open = (event?: ReactMouseEvent<HTMLElement>) => {
    event?.stopPropagation();
    onOpenMod(mod);
  };

  return (
    <article
      className={`home-showcase-card ${installed ? "installed" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpenMod(mod)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onOpenMod(mod);
      }}
    >
      <div className="home-card-thumb">
        {mod.thumbnailUrl ? <img src={mod.thumbnailUrl} alt="" /> : <div className="home-source-fallback">{mod.source === "nexus" ? "NX" : "MW"}</div>}
        <span>{sourceLabel}</span>
        {installed && <strong className="home-installed-badge">Installed</strong>}
      </div>
      <div className="home-card-body">
        <h3>{title}</h3>
        <p className="home-card-author">{author ? `by ${author}` : "Community mod"}</p>
        <p className="home-card-description">{description}</p>
        <div className="home-card-tags">
          {tags.length > 0
            ? tags.map((tag) => <span className={`tag-chip tag-${tag.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} key={tag}>{tag}</span>)
            : <span>No tags cached</span>}
        </div>
        <div className="home-card-footer">
          <span className="home-card-footer-meta">{updatedLabel}</span>
          <button className={`home-install-button ${installed ? "installed" : ""}`} type="button" onClick={open}>
            {installed ? "Installed" : "Install"}
          </button>
        </div>
      </div>
    </article>
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
            onOpenMod={onOpenMod}
          />
        ))}
        {mods.length === 0 && <article className="card"><p>{emptyText}</p></article>}
      </div>
    </div>
  );
}

export function HomePage({ onOpenPage, onOpenModInApp, refreshTick }: HomePageProps) {
  const cachedHome = useMemo(() => readHomeLiveCache(), []);
  const freshHomeCache = cacheIsFresh(cachedHome) ? cachedHome : null;
  const freshModWorkshopHomeCache = cacheIsFresh(cachedHome, HOME_MODWORKSHOP_CACHE_MAX_AGE_MS) ? cachedHome : null;
  const cachedSourceMods = useMemo(() => freshHomeCache ? { nexus: [], modworkshop: [] } : loadCachedHomeModsBySource(), [freshHomeCache]);
  const [nexusMods, setNexusMods] = useState<SourceModSummary[]>(() => freshHomeCache?.nexusMods?.length ? cleanLiveHomeMods("nexus", freshHomeCache.nexusMods) : cachedSourceMods.nexus);
  const [modworkshopMods, setModworkshopMods] = useState<SourceModSummary[]>(() => freshModWorkshopHomeCache?.modworkshopMods?.length ? cleanLiveHomeMods("modworkshop", freshModWorkshopHomeCache.modworkshopMods) : []);
  const [installedMods, setInstalledMods] = useState<SourceModSummary[]>(() => freshHomeCache?.installedMods ?? []);
  const [localPakMods, setLocalPakMods] = useState<PakModFile[]>(() => freshHomeCache?.localPakMods ?? []);
  const [cachedInstalledSourceKeys, setCachedInstalledSourceKeys] = useState<string[]>(() => freshHomeCache?.installedSourceKeys ?? []);
  const [cachedInstalledNames, setCachedInstalledNames] = useState<string[]>(() => freshHomeCache?.installedNames ?? []);
  const [managed, setManaged] = useState<ManagedInstallInfo[]>([]);
  const [installedState, setInstalledState] = useState<InstalledStateRecord[]>([]);
  const [status, setStatus] = useState(freshHomeCache ? "Ready." : "Loading library...");
  const [feedBusy, setFeedBusy] = useState(false);
  const feedBusyRef = useRef(false);
  const lastHomeRefreshRef = useRef(0);
  const lastFocusRefreshRef = useRef(0);
  const dataRefreshTimerRef = useRef<number | null>(null);
  const enrichedDetailKeysRef = useRef(new Set<string>());

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

  const combinedSourceMods = useMemo(() => {
    const map = new Map<string, SourceModSummary>();

    for (const mod of [...nexusMods, ...modworkshopMods]) {
      if (!mod?.sourceId || !mod?.name) continue;
      map.set(homeModKey(mod), mod);
    }

    return sortHomeSourceMods([...map.values()]).slice(0, 12);
  }, [modworkshopMods, nexusMods]);

  useEffect(() => {
    const targets = modworkshopMods
      .filter((mod) => mod.source === "modworkshop" && isWeakHomeDescription(mod.shortDescription))
      .filter((mod) => !enrichedDetailKeysRef.current.has(homeModKey(mod)))
      .slice(0, HOME_DETAIL_ENRICH_LIMIT);

    if (targets.length === 0) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const detailed: SourceModSummary[] = [];

        for (const mod of targets) {
          const key = homeModKey(mod);
          enrichedDetailKeysRef.current.add(key);

          try {
            const detail = await invokeWithTimeout<SourceModDetail>(
              "fetch_modworkshop_mod_detail",
              { modId: mod.sourceId },
              5000,
              "ModWorkshop detail timed out.",
            );

            if (!cancelled && !isWeakHomeDescription(detail.description || detail.shortDescription)) {
              detailed.push(mergeHomeDetailIntoSummary(mod, detail));
            }
          } catch {
            // Detail enrichment is best-effort. Home cards should never freeze because one source page failed.
          }
        }

        if (cancelled || detailed.length === 0) return;

        setModworkshopMods((current) => {
          const replacements = new Map(detailed.map((mod) => [homeModKey(mod), mod]));
          return current.map((mod) => replacements.get(homeModKey(mod)) ?? mod);
        });
      })();
    }, 650);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [modworkshopMods]);

  const refreshFeeds = async (mode: "auto" | "manual" = "manual") => {
    if (feedBusyRef.current) return;

    const now = Date.now();
    if (mode === "auto" && now - lastHomeRefreshRef.current < HOME_AUTO_REFRESH_MS) return;

    feedBusyRef.current = true;
    lastHomeRefreshRef.current = now;
    setFeedBusy(true);
    setStatus(mode === "manual" ? "Refreshing Home..." : "Updating Home...");

    try {
      const autoMode = mode === "auto";
      const shouldScanPakMods = mode === "manual" || (!autoMode && localPakMods.length === 0);
      const [nexus, modworkshop, installs, state, sourceIndex, pakScan] = await Promise.allSettled([
        invoke<SourceModSummary[]>("fetch_source_mods_page", { source: "nexus", page: 1, sort: "updated" }),
        invoke<SourceModSummary[]>("fetch_modworkshop_browse_live_page", { page: 1, sort: "updated" }),
        invoke<ManagedInstallInfo[]>("list_managed_installs"),
        invoke<InstalledStateRecord[]>("list_installed_state_records"),
        autoMode ? Promise.resolve([] as SourceModSummary[]) : invoke<SourceModSummary[]>("list_source_index", { source: null, limit: 300 }).catch(() => []),
        shouldScanPakMods ? invoke<PakScanResult>("scan_pak_mods").catch(() => null) : Promise.resolve(null),
      ]);

      const stateRecords = state.status === "fulfilled" ? state.value : [];
      const installedSummaries = stateRecords
        .map(sourceSummaryFromInstalledRecord)
        .filter((mod): mod is SourceModSummary => Boolean(mod));
      const uniqueInstalled = [...new Map(installedSummaries.map((mod) => [homeModKey(mod), mod])).values()];
      const indexed = sourceIndex.status === "fulfilled" ? sourceIndex.value : [];
      const nextLocalPakMods = pakScan.status === "fulfilled" && pakScan.value
        ? pakScan.value.pakMods.filter((pak) => pak.enabled).slice(0, 160)
        : localPakMods;

      const liveNexus = nexus.status === "fulfilled" ? nexus.value : [];
      const liveModworkshop = modworkshop.status === "fulfilled" ? modworkshop.value : [];
      const indexedNexus = indexed.filter((mod) => mod.source === "nexus");
      const nextNexus = liveNexus.length > 0
        ? cleanLiveHomeMods("nexus", liveNexus)
        : mergeHomeMods("nexus", indexedNexus, cachedSourceMods.nexus);

      const nextModworkshop = liveModworkshop.length > 0
        ? cleanLiveHomeMods("modworkshop", liveModworkshop)
        : [];

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

      const badgeLimit = mode === "manual" ? 24 : 0;
      const visibleBadgeCandidates = [...new Map([...nextNexus, ...nextModworkshop].map((mod) => [homeModKey(mod), mod])).values()].slice(0, badgeLimit);
      const matches = !autoMode && visibleBadgeCandidates.length > 0
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

      setStatus("Ready.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      feedBusyRef.current = false;
      setFeedBusy(false);
    }
  };

  useEffect(() => {
    const startupTimer = window.setTimeout(() => void refreshFeeds("auto"), 6500);

    const refresh = () => void refreshFeeds("auto");
    const debouncedRefresh = () => {
      if (dataRefreshTimerRef.current !== null) window.clearTimeout(dataRefreshTimerRef.current);
      dataRefreshTimerRef.current = window.setTimeout(() => {
        dataRefreshTimerRef.current = null;
        void refreshFeeds("auto");
      }, 650);
    };
    const focusRefresh = () => {
      const now = Date.now();
      if (now - lastFocusRefreshRef.current < HOME_FOCUS_REFRESH_MS) return;
      lastFocusRefreshRef.current = now;
      void refreshFeeds("auto");
    };
    const timer = window.setInterval(refresh, HOME_AUTO_REFRESH_MS);

    window.addEventListener("focus", focusRefresh);
    window.addEventListener("tsuki-data-refresh", debouncedRefresh);

    return () => {
      window.clearTimeout(startupTimer);
      if (dataRefreshTimerRef.current !== null) window.clearTimeout(dataRefreshTimerRef.current);
      window.clearInterval(timer);
      window.removeEventListener("focus", focusRefresh);
      window.removeEventListener("tsuki-data-refresh", debouncedRefresh);
    };
    // refreshTick intentionally forces a fresh Home check when the current page is reselected.
  }, [refreshTick]);

  const openHomeMod = (mod: SourceModSummary) => {
    onOpenModInApp(mod);
  };

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
            Browse, install, back up, and launch PAYDAY 3 mods without digging through folders.
          </p>
          <div className="home-pro-actions">
            <button className="ghost-button" type="button" onClick={() => onOpenPage("browse")}>Browse</button>
            <button className="ghost-button" type="button" onClick={() => onOpenPage("installed")}>Installed Mods</button>
            <button className="ghost-button" type="button" onClick={() => onOpenPage("backups")}>Backups</button>
            <button className="ghost-button" type="button" disabled={feedBusy} onClick={() => refreshFeeds("manual")}>
              {feedBusy ? "Refreshing..." : "Refresh Home"}
            </button>
          </div>
          <p className="home-pro-status-line">{status}</p>
        </div>

        <div className="home-pro-moon">
          <img src={tsukiLogo} alt="" />
        </div>
      </div>

      <div className="home-pro-stats simple-stats">
        <article>
          <span>Tsuki Installs</span>
          <strong>{installedMods.length}</strong>
          <p>Installed through Tsuki</p>
        </article>
        <article>
          <span>Local Installed Mods</span>
          <strong>{localPakMods.length}</strong>
          <p>Enabled files detected in ~mods</p>
        </article>
      </div>

      <HomeModSection
        title="Browse"
        subtitle="Nexus and ModWorkshop combined, sorted by newest updates first."
        cta="Browse"
        mods={combinedSourceMods}
        installedKeys={installedSourceKeys}
        installedNames={installedNames}
        emptyText="No source cards loaded yet. Refresh Home or open Browse."
        onBrowse={() => onOpenPage("browse")}
        onOpenMod={openHomeMod}
      />

      <HomeModSection
        title="Installed by Tsuki"
        subtitle="Only mods installed through Tsuki receipts/state are shown here."
        cta="Open Installed"
        mods={installedMods}
        installedKeys={installedSourceKeys}
        installedNames={installedNames}
        emptyText="No Tsuki-installed mods yet. Install a mod through Browse and it will appear here."
        onBrowse={() => onOpenPage("installed")}
        onOpenMod={openHomeMod}
      />
    </section>
  );
}

import { invoke } from "@tauri-apps/api/core";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ModCard } from "../../components/ModCard";
import type { AppPage } from "../../models/navigation";
import type { GameProfile } from "../../models/gameProfiles";
import { profileHasConfiguredSources, type ActiveProfileRuntime } from "../../models/profileRuntime";
import { profileSourcesFromConfig } from "../../models/profileSources";
import type { PakModFile, PakScanResult } from "../../models/mod";
import type {
  InstalledSourceMatch,
  SourceModSummary,
} from "../../models/source";
import { readThumbnailFailures, thumbnailRecentlyFailed, writeThumbnailFailures } from "../../utils/thumbnailFailures";
import { applyKnownSourceAuthor, displaySourceAuthor, displaySourceTitle, rememberSourceAuthorMetadata } from "../../utils/sourceAuthorCache";
import { homeTrendingSlots } from "../../utils/homeTrendingSlots";

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
  matchKind?: string | null;
  matchConfidence?: number | null;
  matchReason?: string | null;
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
  currentGameProfile: GameProfile;
  profileRuntime?: ActiveProfileRuntime | null;
  profileSwitching?: boolean;
}

const HOME_LIVE_CACHE_KEY = "tsuki-home-live-state:v2.0.0";
const HOME_LEGACY_CACHE_KEYS = ["tsuki-home-live-state:v1.8.3", "tsuki-home-live-state:v1.8.2"];
const HOME_CACHE_MAX_AGE_MS = 20 * 60 * 1000;
const HOME_MODWORKSHOP_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const HOME_AUTO_REFRESH_MS = 5 * 60 * 1000;
const HOME_FOCUS_REFRESH_MS = 2 * 60 * 1000;
const HOME_SECTION_LIMIT = 20;

type HomeQuickFilter = "new" | "updated" | "trending" | "popular" | "surprise";
type HomeTimeFilter = "today" | "week" | "month" | "all";

const HOME_QUICK_FILTERS: Array<{ id: HomeQuickFilter; label: string }> = [
  { id: "new", label: "New" },
  { id: "updated", label: "Updated" },
  { id: "trending", label: "Trending" },
  { id: "popular", label: "Popular" },
  { id: "surprise", label: "Surprise" },
];

const HOME_TIME_FILTERS: Array<{ id: HomeTimeFilter; label: string }> = [
  { id: "today", label: "Today" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "all", label: "All Time" },
];

function homeLiveCacheKey(profileId: string) {
  return `${HOME_LIVE_CACHE_KEY}:${profileId}`;
}

function readHomeLiveCache(profileId: string): HomeLiveCache | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(homeLiveCacheKey(profileId)) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;

    return {
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
      nexusMods: Array.isArray(parsed.nexusMods) ? lightweightHomeMods(parsed.nexusMods) : [],
      modworkshopMods: Array.isArray(parsed.modworkshopMods) ? lightweightHomeMods(parsed.modworkshopMods) : [],
      installedMods: Array.isArray(parsed.installedMods) ? lightweightHomeMods(parsed.installedMods) : [],
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

function writeHomeLiveCache(profileId: string, cache: HomeLiveCache) {
  try {
    window.localStorage.setItem(homeLiveCacheKey(profileId), JSON.stringify({
      ...cache,
      nexusMods: lightweightHomeMods(cache.nexusMods),
      modworkshopMods: lightweightHomeMods(cache.modworkshopMods),
      installedMods: lightweightHomeMods(cache.installedMods),
    }));
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

function rememberHomeSourceAuthor(mod: SourceModSummary) {
  rememberSourceAuthorMetadata(mod);
}

function withKnownHomeAuthor(mod: SourceModSummary): SourceModSummary {
  return applyKnownSourceAuthor(mod);
}

function lightweightHomeMod(mod: SourceModSummary): SourceModSummary {
  const enriched = withKnownHomeAuthor(mod);
  rememberHomeSourceAuthor(enriched);
  return {
    source: enriched.source,
    sourceId: enriched.sourceId,
    uid: enriched.uid,
    gameId: enriched.gameId,
    nexus: enriched.nexus,
    name: enriched.name,
    author: enriched.author ?? null,
    authorUsername: enriched.authorUsername ?? null,
    authorUserId: enriched.authorUserId ?? null,
    authorProfileUrl: enriched.authorProfileUrl ?? null,
    authorAvatarUrl: enriched.authorAvatarUrl ?? null,
    version: enriched.version ?? null,
    thumbnailUrl: enriched.thumbnailUrl ?? null,
    bannerUrl: enriched.bannerUrl ?? null,
    pageUrl: enriched.pageUrl ?? null,
    updatedAt: enriched.updatedAt ?? null,
    downloads: enriched.downloads ?? null,
    likes: enriched.likes ?? null,
    views: enriched.views ?? null,
    shortDescription: null,
    tags: Array.isArray(enriched.tags) ? enriched.tags.slice(0, 8) : [],
  };
}

function lightweightHomeMods(mods: SourceModSummary[]) {
  return mods.map(lightweightHomeMod);
}

function installedRecordIsTrustedSource(record: InstalledStateRecord) {
  const source = String(record.source ?? "").toLowerCase();
  if (source !== "nexus" && source !== "modworkshop") return false;

  const sourceId = record.sourceModId ?? record.id;
  if (!sourceId || sourceId === "unknown") return false;

  const kind = String(record.matchKind ?? (record.receiptId ? "receipt" : "")).toLowerCase();
  return Boolean(record.receiptId) && (kind === "receipt" || kind === "receipt-hash");
}

function installedKeyFromRecord(record: InstalledStateRecord) {
  if (!installedRecordIsTrustedSource(record)) return null;
  const sourceId = record.sourceModId ?? record.id;
  return `${record.source}-${sourceId}`;
}

function installedKeyFromManaged(install: ManagedInstallInfo) {
  return install.sourceModId ? `${install.source}-${install.sourceModId}` : null;
}

function sourceSummaryFromInstalledRecord(record: InstalledStateRecord): SourceModSummary | null {
  if (!installedRecordIsTrustedSource(record)) return null;

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
    views: null,
    shortDescription: null,
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

function homePopularityScore(mod: SourceModSummary) {
  return (mod.downloads ?? 0) + (mod.likes ?? 0) * 65 + (mod.views ?? 0) * 0.08;
}

function homeStableHash(mod: SourceModSummary) {
  const value = `${mod.source}-${mod.sourceId}-${mod.name}`;
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function homeModInTimeWindow(mod: SourceModSummary, filter: HomeTimeFilter) {
  if (filter === "all") return true;
  const updatedAt = homeUpdatedAtMs(mod);
  if (!updatedAt) return false;

  const age = Date.now() - updatedAt;
  const day = 24 * 60 * 60 * 1000;
  if (filter === "today") return age <= day;
  if (filter === "week") return age <= 7 * day;
  return age <= 30 * day;
}

function sortHomeModsByFilter(mods: SourceModSummary[], filter: HomeQuickFilter) {
  const sorted = [...mods];

  if (filter === "popular") {
    return sorted.sort((a, b) => homePopularityScore(b) - homePopularityScore(a) || homeUpdatedAtMs(b) - homeUpdatedAtMs(a));
  }

  if (filter === "trending") {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    return sorted.sort((a, b) => {
      const recencyA = homeUpdatedAtMs(a) ? Math.max(0, 30 - (now - homeUpdatedAtMs(a)) / day) * 120 : 0;
      const recencyB = homeUpdatedAtMs(b) ? Math.max(0, 30 - (now - homeUpdatedAtMs(b)) / day) * 120 : 0;
      return (homePopularityScore(b) + recencyB) - (homePopularityScore(a) + recencyA);
    });
  }

  if (filter === "surprise") {
    return sorted.sort((a, b) => homeStableHash(a) - homeStableHash(b));
  }

  return sortHomeSourceMods(sorted);
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

function normalizedHomeTagKey(tag: string) {
  return tag.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function homeCardTags(mod: SourceModSummary) {
  const base = mod.tags ?? [];
  const seen = new Set<string>();
  const hidden = new Set(["nexus", "nexus mods", "modworkshop", "mod workshop", "payday3", "payday 3"]);
  const result: string[] = [];

  for (const tag of base) {
    const clean = String(tag ?? "").trim();
    if (!clean) continue;
    const key = normalizedHomeTagKey(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    if (hidden.has(key)) continue;
    result.push(clean);
    if (result.length >= 8) break;
  }

  return result;
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
      result.push(lightweightHomeMod(mod));
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

function inferHomeAuthor(mod: SourceModSummary) {
  return displaySourceAuthor(mod) ?? "";
}

function homeDisplayTitle(mod: SourceModSummary) {
  return displaySourceTitle(mod);
}

function loadCachedHomeModsBySource(profileId: string): CachedSourceMods {
  const mods: CachedSourceMods = { nexus: [], modworkshop: [] };
  const allowLegacyPayday3Cache = profileId === "builtin.payday3";

  for (const key of Object.keys(window.localStorage)) {
    if (!key.toLowerCase().includes("source-cache")) continue;
    if (!allowLegacyPayday3Cache && !key.includes(profileId)) continue;

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

const SourceMiniCard = memo(function SourceMiniCard({
  mod,
  installed,
  canUseThumbnail,
  onThumbnailFailed,
  onOpenMod,
  className = "",
}: {
  mod: SourceModSummary;
  installed: boolean;
  canUseThumbnail: (url: string | null | undefined) => boolean;
  onThumbnailFailed: (url: string | null | undefined) => void;
  onOpenMod: (mod: SourceModSummary) => void;
  className?: string;
}) {
  const sourceLabel = mod.source === "nexus" ? "Nexus Mods" : "ModWorkshop";
  const author = inferHomeAuthor(mod);
  const title = homeDisplayTitle(mod);
  const updatedLabel = homeUpdatedLabel(mod);
  const tags = homeCardTags(mod);

  return (
    <ModCard
      className={`home-showcase-card ${className}`.trim()}
      title={title}
      source={mod.source}
      sourceLabel={sourceLabel}
      author={author}
      version={mod.version}
      thumbnailUrl={mod.thumbnailUrl}
      bannerUrl={mod.bannerUrl}
      tags={tags}
      likes={mod.likes}
      downloads={mod.downloads}
      views={mod.views}
      updatedLabel={updatedLabel}
      installed={installed}
      canUseThumbnail={canUseThumbnail}
      onThumbnailFailed={onThumbnailFailed}
      onOpen={() => onOpenMod(mod)}
      primaryAction={{
        label: installed ? "Open" : "Install",
        variant: installed ? "installed" : "default",
        onClick: () => onOpenMod(mod),
      }}
      moreActions={(
        <>
          <button type="button" onClick={() => onOpenMod(mod)}>Open details</button>
          {mod.pageUrl && <button type="button" onClick={() => void invoke("open_external_url", { url: mod.pageUrl })}>Website</button>}
        </>
      )}
    />
  );
});

const FeaturedHomeCard = memo(function FeaturedHomeCard({
  mod,
  installed,
  canUseThumbnail,
  onThumbnailFailed,
  onOpenMod,
}: {
  mod: SourceModSummary;
  installed: boolean;
  canUseThumbnail: (url: string | null | undefined) => boolean;
  onThumbnailFailed: (url: string | null | undefined) => void;
  onOpenMod: (mod: SourceModSummary) => void;
}) {
  return (
    <SourceMiniCard
      mod={mod}
      installed={installed}
      canUseThumbnail={canUseThumbnail}
      onThumbnailFailed={onThumbnailFailed}
      onOpenMod={onOpenMod}
      className="home-feature-hero-card"
    />
  );
});
function HomeModGrid({
  mods,
  installedKeys,
  emptyText,
  canUseThumbnail,
  onThumbnailFailed,
  onOpenMod,
  cardClassName = "",
}: {
  mods: SourceModSummary[];
  installedKeys: Set<string>;
  emptyText: string;
  canUseThumbnail: (url: string | null | undefined) => boolean;
  onThumbnailFailed: (url: string | null | undefined) => void;
  onOpenMod: (mod: SourceModSummary) => void;
  cardClassName?: string;
}) {
  return (
    <div className="home-pro-card-grid home-storefront-grid">
      {mods.slice(0, HOME_SECTION_LIMIT).map((mod) => (
        <SourceMiniCard
          key={`${mod.source}-${mod.sourceId}`}
          mod={mod}
          installed={installedKeys.has(homeModKey(mod))}
          canUseThumbnail={canUseThumbnail}
          onThumbnailFailed={onThumbnailFailed}
          onOpenMod={onOpenMod}
          className={cardClassName}
        />
      ))}
      {mods.length === 0 && <article className="card home-empty-card"><p>{emptyText}</p></article>}
    </div>
  );
}
export function HomePage({ onOpenPage, onOpenModInApp, refreshTick, currentGameProfile, profileRuntime, profileSwitching = false }: HomePageProps) {
  const profileId = currentGameProfile.profileId;
  const runtimeSourceConfig = profileRuntime?.sourceConfig ?? currentGameProfile.sourceConfig ?? {};
  const configuredSources = useMemo(
    () => profileSourcesFromConfig(runtimeSourceConfig, currentGameProfile.displayName),
    [currentGameProfile.displayName, runtimeSourceConfig],
  );
  const homeNexusSource = configuredSources.find((source) => source.provider === "nexus" && source.browseMode === "api") ?? null;
  const homeModWorkshopSource = configuredSources.find((source) => source.provider === "modworkshop" && source.browseMode === "api") ?? null;
  const hasConfiguredSources = profileHasConfiguredSources(currentGameProfile) || configuredSources.length > 0;
  const homeCacheScope = `${profileId}:${homeModWorkshopSource?.gameVersion ?? "default"}`;
  const cachedHome = useMemo(() => readHomeLiveCache(homeCacheScope), [homeCacheScope]);
  const freshHomeCache = cacheIsFresh(cachedHome) ? cachedHome : null;
  const freshModWorkshopHomeCache = cacheIsFresh(cachedHome, HOME_MODWORKSHOP_CACHE_MAX_AGE_MS) ? cachedHome : null;
  const cachedSourceMods = useMemo(() => freshHomeCache || !hasConfiguredSources ? { nexus: [], modworkshop: [] } : loadCachedHomeModsBySource(profileId), [freshHomeCache, hasConfiguredSources, profileId]);
  const [nexusMods, setNexusMods] = useState<SourceModSummary[]>(() => freshHomeCache?.nexusMods?.length ? cleanLiveHomeMods("nexus", freshHomeCache.nexusMods) : cachedSourceMods.nexus);
  const [modworkshopMods, setModworkshopMods] = useState<SourceModSummary[]>(() => freshModWorkshopHomeCache?.modworkshopMods?.length ? cleanLiveHomeMods("modworkshop", freshModWorkshopHomeCache.modworkshopMods) : []);
  const [, setInstalledMods] = useState<SourceModSummary[]>(() => freshHomeCache?.installedMods ?? []);
  const [localPakMods, setLocalPakMods] = useState<PakModFile[]>(() => freshHomeCache?.localPakMods ?? []);
  const [cachedInstalledSourceKeys, setCachedInstalledSourceKeys] = useState<string[]>(() => freshHomeCache?.installedSourceKeys ?? []);
  const [managed, setManaged] = useState<ManagedInstallInfo[]>([]);
  const [installedState, setInstalledState] = useState<InstalledStateRecord[]>([]);
  const [status, setStatus] = useState(freshHomeCache ? "Ready." : "Loading library...");
  const [feedBusy, setFeedBusy] = useState(false);
  const [failedImages, setFailedImages] = useState<Record<string, number>>(() => readThumbnailFailures());
  const feedBusyRef = useRef(false);
  const lastHomeRefreshRef = useRef(0);
  const lastFocusRefreshRef = useRef(0);
  const dataRefreshTimerRef = useRef<number | null>(null);
  const homePreloadTimingRecordedRef = useRef(false);

  function markThumbnailFailed(url: string | null | undefined) {
    if (!url) return;

    const next = { ...readThumbnailFailures(), [url]: Date.now() };
    writeThumbnailFailures(next);
    setFailedImages(next);
  }

  function canUseThumbnail(url: string | null | undefined) {
    return Boolean(url && !thumbnailRecentlyFailed(url, failedImages));
  }

  const installedSourceKeys = useMemo(() => {
    const keys = new Set<string>(cachedInstalledSourceKeys);

    for (const install of managed) {
      const key = installedKeyFromManaged(install);
      if (key) keys.add(key);
    }

    for (const record of installedState) {
      const key = installedKeyFromRecord(record);
      if (key) keys.add(key);
    }

    return keys;
  }, [cachedInstalledSourceKeys, installedState, managed]);

  const combinedSourceMods = useMemo(() => {
    const map = new Map<string, SourceModSummary>();

    for (const mod of [...nexusMods, ...modworkshopMods]) {
      if (!mod?.sourceId || !mod?.name) continue;
      map.set(homeModKey(mod), mod);
    }

    return sortHomeSourceMods([...map.values()]).slice(0, HOME_SECTION_LIMIT);
  }, [modworkshopMods, nexusMods]);

  const [homeQuickFilter, setHomeQuickFilter] = useState<HomeQuickFilter>("updated");
  const [homeTimeFilter, setHomeTimeFilter] = useState<HomeTimeFilter>("week");

  const trendingMods = useMemo(() => {
    return sortHomeModsByFilter(combinedSourceMods, "trending").slice(0, 12);
  }, [combinedSourceMods]);

  const [trendingOffset, setTrendingOffset] = useState(0);
  const { featured: rotatingTrendingMods, secondary: secondaryTrendingMods } = useMemo(
    () => homeTrendingSlots(trendingMods), [trendingMods],
  );

  useEffect(() => {
    if (rotatingTrendingMods.length <= 2) {
      setTrendingOffset(0);
      return;
    }

    const timer = window.setInterval(() => {
      setTrendingOffset((current) => (current + 2) % rotatingTrendingMods.length);
    }, 7000);

    return () => window.clearInterval(timer);
  }, [rotatingTrendingMods.length]);

  const featuredTrendingMods = useMemo(() => {
    if (rotatingTrendingMods.length <= 2) return rotatingTrendingMods;
    return [0, 1]
      .map((offset) => rotatingTrendingMods[(trendingOffset + offset) % rotatingTrendingMods.length])
      .filter((mod): mod is SourceModSummary => Boolean(mod));
  }, [rotatingTrendingMods, trendingOffset]);

  const storefrontMods = useMemo(() => {
    const windowed = combinedSourceMods.filter((mod) => homeModInTimeWindow(mod, homeTimeFilter));
    const base = windowed.length > 0 || homeTimeFilter === "all" ? windowed : combinedSourceMods;
    return sortHomeModsByFilter(base, homeQuickFilter).slice(0, HOME_SECTION_LIMIT);
  }, [combinedSourceMods, homeQuickFilter, homeTimeFilter]);

  const refreshFeeds = async (mode: "auto" | "manual" = "manual") => {
    if (feedBusyRef.current) return;

    const now = Date.now();
    if (mode === "auto" && now - lastHomeRefreshRef.current < HOME_AUTO_REFRESH_MS) return;

    const timingStart = performance.now();
    let timingStatus = "ok";
    let timingDetail = "";

    feedBusyRef.current = true;
    lastHomeRefreshRef.current = now;
    setFeedBusy(true);
    setStatus(mode === "manual" ? "Refreshing Home..." : "Updating Home...");

    try {
      if (profileSwitching) {
        setStatus("Switching profile...");
        return;
      }
      const autoMode = mode === "auto";
      const shouldScanPakMods = mode === "manual" || (!autoMode && localPakMods.length === 0);
      const profileArgs = { profileId };
      const [nexus, modworkshop, installs, state, sourceIndex, pakScan] = await Promise.allSettled([
        homeNexusSource ? invoke<SourceModSummary[]>("fetch_source_mods_page", { source: "nexus", page: 1, sort: "updated", profileId, sourceId: homeNexusSource.id }) : Promise.resolve([] as SourceModSummary[]),
        homeModWorkshopSource ? invoke<SourceModSummary[]>("fetch_source_mods_page", { source: "modworkshop", page: 1, sort: "updated", profileId, sourceId: homeModWorkshopSource.id }) : Promise.resolve([] as SourceModSummary[]),
        invoke<ManagedInstallInfo[]>("list_managed_installs", profileArgs),
        invoke<InstalledStateRecord[]>("list_installed_state_records", profileArgs),
        autoMode ? Promise.resolve([] as SourceModSummary[]) : invoke<SourceModSummary[]>("list_source_index", { source: null, limit: 300, profileId }).catch(() => []),
        shouldScanPakMods ? invoke<PakScanResult>("scan_pak_mods", profileArgs).catch(() => null) : Promise.resolve(null),
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
      timingStatus = nexus.status === "fulfilled" && modworkshop.status === "fulfilled" ? "ok" : "partial";
      timingDetail = [
        `mode=${mode}`,
        `nexus=${liveNexus.length}`,
        `modworkshop=${liveModworkshop.length}`,
        `installedState=${stateRecords.length}`,
        nexus.status === "rejected" ? `nexusError=${String(nexus.reason)}` : null,
        modworkshop.status === "rejected" ? `modworkshopError=${String(modworkshop.reason)}` : null,
      ].filter(Boolean).join("; ");

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
        const key = installedKeyFromRecord(record);
        if (key) sourceKeySet.add(key);
        nameSet.add(compactHomeName(record.name));
        nameSet.add(compactHomeName(record.filename));
      }

      for (const pak of nextLocalPakMods) {
        nameSet.add(compactHomeName(pakDisplayName(pak.fileName)));
        nameSet.add(compactHomeName(pak.fileName));
      }

      const badgeLimit = mode === "manual" ? HOME_SECTION_LIMIT : 0;
      const visibleBadgeCandidates = [...new Map([...nextNexus, ...nextModworkshop].map((mod) => [homeModKey(mod), mod])).values()].slice(0, badgeLimit);
      const matches = !autoMode && visibleBadgeCandidates.length > 0
        ? await invoke<InstalledSourceMatch[]>("match_installed_source_mods", { sourceMods: visibleBadgeCandidates, profileId }).catch(() => [])
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

      writeHomeLiveCache(homeCacheScope, {
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
      timingStatus = "failed";
      timingDetail = error instanceof Error ? error.message : String(error);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (!homePreloadTimingRecordedRef.current) {
        homePreloadTimingRecordedRef.current = true;
        void invoke("record_startup_diagnostic", {
          label: "Home browse preload",
          durationMs: Math.round(performance.now() - timingStart),
          status: timingStatus,
          detail: timingDetail || `mode=${mode}`,
        }).catch(() => undefined);
      }
      feedBusyRef.current = false;
      setFeedBusy(false);
    }
  };

  useEffect(() => {
    feedBusyRef.current = false;
    lastHomeRefreshRef.current = 0;
    lastFocusRefreshRef.current = 0;
    setNexusMods(freshHomeCache?.nexusMods?.length ? cleanLiveHomeMods("nexus", freshHomeCache.nexusMods) : cachedSourceMods.nexus);
    setModworkshopMods(freshModWorkshopHomeCache?.modworkshopMods?.length ? cleanLiveHomeMods("modworkshop", freshModWorkshopHomeCache.modworkshopMods) : []);
    setInstalledMods(freshHomeCache?.installedMods ?? []);
    setLocalPakMods(freshHomeCache?.localPakMods ?? []);
    setCachedInstalledSourceKeys(freshHomeCache?.installedSourceKeys ?? []);
    setManaged([]);
    setInstalledState([]);
    setStatus(profileSwitching ? "Switching profile..." : hasConfiguredSources ? "Loading library..." : "No browse sources configured for this profile.");
  }, [cachedSourceMods.nexus, freshHomeCache, freshModWorkshopHomeCache, hasConfiguredSources, profileId, profileSwitching]);

  useEffect(() => {
    if (profileSwitching) return;
    const startupTimer = window.setTimeout(() => void refreshFeeds("auto"), 1200);

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
  }, [refreshTick, profileId, hasConfiguredSources, homeNexusSource?.id, homeModWorkshopSource?.id, profileSwitching]);

  const openHomeMod = (mod: SourceModSummary) => {
    onOpenModInApp(mod);
  };

  return (
    <section className="page home-page home-pro home-library-page home-storefront-page">
      <section className="home-storefront-section home-trending-section">
        <div className="home-storefront-head">
          <div>
            <h1>Trending Mods</h1>
            <p>{status}</p>
          </div>
          <div className="home-library-actions">
            <button className="ghost-button compact" type="button" onClick={() => onOpenPage("browse")}>Browse</button>
            <button className="ghost-button compact" type="button" disabled={feedBusy} onClick={() => refreshFeeds("manual")}>
              {feedBusy ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>

        <div className="home-trending-carousel">
          <div className="home-feature-panels">
            {featuredTrendingMods.map((mod) => (
              <FeaturedHomeCard
                key={`feature-${mod.source}-${mod.sourceId}`}
                mod={mod}
                installed={installedSourceKeys.has(homeModKey(mod))}
                canUseThumbnail={canUseThumbnail}
                onThumbnailFailed={markThumbnailFailed}
                onOpenMod={openHomeMod}
              />
            ))}
          </div>

          {rotatingTrendingMods.length > 2 && (
            <div className="home-feature-controls" aria-label="Trending carousel controls">
              <button type="button" onClick={() => setTrendingOffset((current) => (current - 2 + rotatingTrendingMods.length) % rotatingTrendingMods.length)} aria-label="Previous trending mods">&lt;</button>
              <div className="home-feature-dots" aria-hidden="true">
                {Array.from({ length: Math.ceil(rotatingTrendingMods.length / 2) }).map((_, index) => (
                  <span className={Math.floor((trendingOffset % rotatingTrendingMods.length) / 2) === index ? "active" : ""} key={index} />
                ))}
              </div>
              <button type="button" onClick={() => setTrendingOffset((current) => (current + 2) % rotatingTrendingMods.length)} aria-label="Next trending mods">&gt;</button>
            </div>
          )}

          {secondaryTrendingMods.length > 0 && (
            <div className="home-trending-grid home-trending-mini-grid">
              {secondaryTrendingMods.map((mod) => (
                <SourceMiniCard
                  key={`trend-${mod.source}-${mod.sourceId}`}
                  mod={mod}
                  installed={installedSourceKeys.has(homeModKey(mod))}
                  canUseThumbnail={canUseThumbnail}
                  onThumbnailFailed={markThumbnailFailed}
                  onOpenMod={openHomeMod}
                  className="home-compact-feature-card"
                />
              ))}
            </div>
          )}

          {trendingMods.length === 0 && <article className="card home-empty-card"><p>{hasConfiguredSources ? "No source cards loaded yet. Refresh Home or open Browse." : "No browse sources configured for this profile."}</p></article>}
        </div>
      </section>

      <section className="home-storefront-section home-mods-section">
        <div className="home-mods-heading">
          <h2>Mods</h2>
        </div>
        <div className="home-mods-toolbar">
          <div className="home-filter-tabs" aria-label="Home mod filters">
            {HOME_QUICK_FILTERS.map((filter) => (
              <button
                key={filter.id}
                className={homeQuickFilter === filter.id ? "active" : ""}
                type="button"
                onClick={() => setHomeQuickFilter(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>

          <div className="home-time-tabs" aria-label="Home time filters">
            {HOME_TIME_FILTERS.map((filter) => (
              <button
                key={filter.id}
                className={homeTimeFilter === filter.id ? "active" : ""}
                type="button"
                onClick={() => setHomeTimeFilter(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        <HomeModGrid
          mods={storefrontMods}
          installedKeys={installedSourceKeys}
          emptyText="No mods matched this filter yet. Try All Time or Refresh."
          canUseThumbnail={canUseThumbnail}
          onThumbnailFailed={markThumbnailFailed}
          onOpenMod={openHomeMod}
        />
      </section>
    </section>
  );
}

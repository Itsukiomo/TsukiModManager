import "./BrowsePage.css";

interface EmbeddedBrowserStatus {
  open: boolean;
  url?: string | null;
}
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { AppSettings } from "../../models/settings";
import type { GameProfile, GameProfileSourceDefinition } from "../../models/gameProfiles";
import { profileHasConfiguredSources, type ActiveProfileRuntime } from "../../models/profileRuntime";
import { modWorkshopCardMatchesSource, profileBrowseSessionIdentity, profileSourceCacheIdentity, profileSourcesFromConfig } from "../../models/profileSources";
import type { ProfileSettings, ProfileSourceId } from "../../models/profileSettings";
import { normalizeProfileSettings } from "../../models/profileSettings";
import { ModCard } from "../../components/ModCard";
import { UnifiedModPage } from "../../components/UnifiedModPage";
import type { UnifiedAction, UnifiedDependencyItem, UnifiedFileGroup, UnifiedInfoItem, UnifiedTimelineItem } from "../../components/UnifiedModPage";
import { DependencyActions, DependencyName } from "../../components/DependencyActions";
import { buildDependencyGraph, dependencySourceLabel, dependencyToSourceSummary, enrichDependency, type DependencyDefinition, type DependencySourceKind } from "../../models/dependency";
import { buildNexusBrowseKey, normalizeNexusId } from "../../sources/nexus/ids";
import { readThumbnailFailures, thumbnailRecentlyFailed, writeThumbnailFailures } from "../../utils/thumbnailFailures";
import { applyKnownSourceAuthor, displaySourceAuthor, displaySourceTitle, rememberSourceAuthorMetadata } from "../../utils/sourceAuthorCache";
import {
  readModWorkshopCategoryCacheEntry,
  writeModWorkshopCategoryCache,
} from "../../utils/modWorkshopCategoryCache";
import type {
  ModSourceKind,
  SourceModDetail,
  SourceModSummary,
  SourceModFile,
  StagedDownloadResult,
  InstallApplyResult,
  InstalledSourceMatch,
  SourceCategory,
} from "../../models/source";

type BrowseTab = ModSourceKind | "custom";
type BrowsePageNumbers = Record<BrowseTab, number>;
type BrowsePageBooleans = Record<BrowseTab, boolean>;
type SortMode = "published_at" | "bumped_at" | "best_match" | "downloads" | "likes" | "views" | "score" | "name";
type ViewMode = "list" | "detail";

const BROWSE_PAGE_SIZE = 20;
const SOURCE_CACHE_VERSION = "v2.0.1-gallery-browse-cache";
const SOURCE_CACHE_TTL_MS = 1000 * 60 * 5;
const MODWORKSHOP_GAME_ID = "payday-3";
const DEFAULT_SORT: SortMode = "bumped_at";
type CategoryStatus = "idle" | "loading" | "loaded" | "cached" | "cache-refresh-failed" | "unavailable" | "failed";

const modWorkshopSortOptions: Array<{ id: SortMode; label: string }> = [
  { id: "published_at", label: "Newest" },
  { id: "bumped_at", label: "Recently Updated" },
  { id: "best_match", label: "Best Match" },
  { id: "downloads", label: "Most Downloaded" },
  { id: "likes", label: "Most Liked" },
  { id: "views", label: "Most Viewed" },
  { id: "score", label: "Highest Rated" },
  { id: "name", label: "Name" },
];

const nexusSortOptions: Array<{ id: SortMode; label: string }> = [
  { id: "bumped_at", label: "Recently Updated" },
  { id: "published_at", label: "Newest" },
  { id: "downloads", label: "Most Downloaded" },
  { id: "likes", label: "Most Liked" },
];

function modMatchesQuery(mod: SourceModSummary, query: string) {
  const cleanQuery = query.trim().toLowerCase();
  if (!cleanQuery) return true;

  const haystack = [
    mod.name,
    mod.author ?? "",
    mod.pageUrl ?? "",
    mod.version ?? "",
    ...(mod.tags ?? []),
  ].join(" ").toLowerCase();

  if (haystack.includes(cleanQuery)) return true;

  const compactQuery = cleanQuery.replace(/[^a-z0-9]+/g, "");
  const compactHaystack = haystack.replace(/[^a-z0-9]+/g, "");
  if (compactQuery && compactHaystack.includes(compactQuery)) return true;

  const tokens = cleanQuery.split(/\s+/).filter((token) => token.length >= 2);
  return tokens.length > 0 && tokens.every((token) => {
    const cleanToken = token.replace(/[^a-z0-9]+/g, "");
    return haystack.includes(token) || Boolean(cleanToken && compactHaystack.includes(cleanToken));
  });
}

interface CachedSourceMods {
  version: string;
  savedAt: number;
  page: number;
  hasMore: boolean;
  mods: SourceModSummary[];
}

interface PendingDelete {
  title: string;
  fileNames: string[];
  busyId: string;
}

interface BrowseSessionSnapshot {
  scope: string;
  profileId: string;
  activeSourceId: string;
  activeTab: BrowseTab;
  sortMode: SortMode;
  categoryId: string;
  categoryLabel: string;
  view: ViewMode;
  mods: SourceModSummary[];
  pages: BrowsePageNumbers;
  hasMore: BrowsePageBooleans;
  status: string;
  searchQuery: string;
  sourceSearchQuery: string;
  activeModWorkshopSearch: string;
  activeNexusSearch: string;
  selectedMod: SourceModDetail | null;
  sourceMatches: Record<string, InstalledSourceMatch>;
  browseCardsLive: boolean;
  cacheNote: string;
}

let browseSessionSnapshot: BrowseSessionSnapshot | null = null;

function browsePageNumbers(value?: Partial<BrowsePageNumbers> | null): BrowsePageNumbers {
  return { modworkshop: 0, nexus: 0, github: 0, custom: 0, ...(value ?? {}) };
}

function browsePageBooleans(value?: Partial<BrowsePageBooleans> | null): BrowsePageBooleans {
  return { modworkshop: true, nexus: true, github: false, custom: false, ...(value ?? {}) };
}

function sourceLabel(source: BrowseTab) {
  if (source === "modworkshop") return "ModWorkshop";
  if (source === "nexus") return "Nexus";
  if (source === "github") return "GitHub";
  return "Custom Browser";
}

function displayAuthor(mod: SourceModSummary | SourceModDetail) {
  return displaySourceAuthor(mod);
}

function displayModTitle(mod: SourceModSummary | SourceModDetail) {
  return displaySourceTitle(mod);
}

function rememberSourceAuthor(mod: SourceModSummary | SourceModDetail) {
  rememberSourceAuthorMetadata(mod);
}

function withKnownAuthor<T extends SourceModSummary>(mod: T): T {
  return applyKnownSourceAuthor(mod);
}

function reportTaskProgress(label: string, progress: number | null = null, detail = "") {
  window.dispatchEvent(new CustomEvent("tsuki-task-progress", {
    detail: { active: true, label, detail, progress },
  }));
}

function clearTaskProgress() {
  window.dispatchEvent(new CustomEvent("tsuki-task-progress", {
    detail: { active: false, label: "", detail: "", progress: null },
  }));
}

function recordCachePolicyDiagnostic(details: {
  browseDataSource?: string;
  detailDataSource?: string;
  fileListDataSource?: string;
  cacheFallbackReason?: string;
}) {
  void invoke<string>("record_runtime_process_diagnostic", {
    label: "Cache Policy",
    status: "info",
    reason: details.cacheFallbackReason ?? "Cache policy state updated.",
    details: [
      `Last Browse Data Source: ${details.browseDataSource ?? "unchanged"}`,
      `Last Detail Data Source: ${details.detailDataSource ?? "unchanged"}`,
      `Last File List Data Source: ${details.fileListDataSource ?? "unchanged"}`,
      `Cache Fallback Reason: ${details.cacheFallbackReason ?? "none"}`,
    ],
  }).catch(() => {
    // Debug diagnostics are optional and must never affect browsing.
  });
}

function recordModWorkshopCategoryDiagnostic(details: {
  profileId: string;
  profileName: string;
  gameId: string;
  status: "success" | "warning" | "failed";
  reason: string;
  cacheAvailable: boolean;
  cacheUsed: boolean;
}) {
  void invoke<string>("record_runtime_process_diagnostic", {
    label: "ModWorkshop Categories",
    status: details.status,
    reason: details.reason,
    details: [
      `Profile ID: ${details.profileId}`,
      `Profile name: ${details.profileName}`,
      `ModWorkshop game ID: ${details.gameId}`,
      `Cache available: ${details.cacheAvailable ? "yes" : "no"}`,
      `Cache used: ${details.cacheUsed ? "yes" : "no"}`,
      `Request route: https://api.modworkshop.net/games/${details.gameId}/categories`,
    ],
  }).catch(() => {
    // Diagnostics must never affect Browse.
  });
}

function invokeWithTimeout<T>(command: string, args: Record<string, unknown>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return Promise.race([
    invoke<T>(command, args),
    new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)),
  ]);
}

function sourceAccent(source: BrowseTab) {
  if (source === "modworkshop") return "MW";
  if (source === "nexus") return "NX";
  if (source === "github") return "GH";
  return "WEB";
}

function normalizeBrowserUrl(value?: string | null) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  try {
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(withProtocol).toString();
  } catch {
    return "";
  }
}

function parseBrowserUrl(value?: string | null) {
  const normalized = normalizeBrowserUrl(value);
  if (!normalized) return null;
  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

function browserHostMatches(url: URL, suffix: string) {
  const host = url.hostname.toLowerCase();
  const clean = suffix.toLowerCase();
  return host === clean || host.endsWith(`.${clean}`);
}

function parseNexusDomainFromUrl(value?: string | null) {
  const url = parseBrowserUrl(value);
  if (!url || !browserHostMatches(url, "nexusmods.com")) return "";
  const parts = url.pathname.split("/").filter(Boolean);
  const domainIndex = parts[0]?.toLowerCase() === "games" ? 1 : 0;
  return parts[domainIndex]?.toLowerCase() ?? "";
}

function parseModWorkshopSlugFromUrl(value?: string | null) {
  const url = parseBrowserUrl(value);
  if (!url || !browserHostMatches(url, "modworkshop.net")) return "";
  const parts = url.pathname.split("/").filter(Boolean);
  const gameRouteIndex = parts.findIndex((part) => ["g", "game", "games"].includes(part.toLowerCase()));
  const candidate = gameRouteIndex >= 0 ? parts[gameRouteIndex + 1] : "";
  return candidate && !/^\d+$/.test(candidate) ? decodeURIComponent(candidate).toLowerCase() : "";
}

function firstConfiguredUrl(...values: Array<string | null | undefined>) {
  return values.map(normalizeBrowserUrl).find(Boolean) ?? "";
}

function normalizeAllowedDomain(value: string) {
  const trimmed = value.trim().replace(/^\*\./, "").replace(/^https?:\/\//i, "").split("/")[0]?.toLowerCase() ?? "";
  return trimmed.replace(/:\d+$/, "");
}

function browserUrlAllowed(url: string, allowedDomains: string[]) {
  if (!allowedDomains.length) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowedDomains
      .map(normalizeAllowedDomain)
      .filter(Boolean)
      .some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function normalizeSortMode(value: unknown, source: BrowseTab = "modworkshop"): SortMode {
  const text = String(value ?? "").trim();
  const legacy: Record<string, SortMode> = {
    recent: "bumped_at",
    updated: "bumped_at",
    added: "published_at",
    popular: "downloads",
    liked: "likes",
  };
  const normalized = (legacy[text] ?? text) as SortMode;
  const supported = sortOptionsForSource(source);
  if (supported.length === 0) return DEFAULT_SORT;
  return supported.some((option) => option.id === normalized) ? normalized : DEFAULT_SORT;
}

function sortOptionsForSource(source: BrowseTab) {
  if (source === "modworkshop") return modWorkshopSortOptions;
  if (source === "nexus") return nexusSortOptions;
  return [];
}

function cacheKey(profileId: string, source: BrowseTab, sourceGameKey: string, sort: SortMode, page = 1, query = "", categoryId = "") {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedCategory = categoryId.trim().toLowerCase();

  if (source === "nexus") {
    return `tsuki-source-cache:${SOURCE_CACHE_VERSION}:${profileId}:${buildNexusBrowseKey({
      gameDomainName: sourceGameKey || profileId,
      sort,
      offset: (Math.max(1, page) - 1) * BROWSE_PAGE_SIZE,
      count: BROWSE_PAGE_SIZE,
    })}:q=${encodeURIComponent(normalizedQuery)}:category=${encodeURIComponent(normalizedCategory)}`;
  }

  return [
    "tsuki-source-cache",
    SOURCE_CACHE_VERSION,
    profileId,
    source,
    sourceGameKey || MODWORKSHOP_GAME_ID,
    `page=${Math.max(1, page)}`,
    `query=${encodeURIComponent(normalizedQuery)}`,
    `sort=${sort}`,
    `category=${encodeURIComponent(normalizedCategory)}`,
  ].join(":");
}

function modTimeValue(mod: SourceModSummary) {
  const raw = String(mod.updatedAt ?? "").trim();

  if (!raw) return 0;

  // ModWorkshop public pages often do not expose exact machine-readable dates.
  // The backend assigns numeric live-rank timestamps so Browse can preserve
  // newest/latest-updated page order. Date.parse() treats those as invalid,
  // so parse numeric values first.
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      // Normal Unix seconds are small enough to convert to milliseconds.
      // Large synthetic ranking values should stay large and sortable.
      return numeric < 4_000_000_000 ? numeric * 1000 : numeric;
    }
  }

  const value = Date.parse(raw);
  return Number.isFinite(value) ? value : 0;
}

function sourceIdNumber(mod: SourceModSummary) {
  const parsed = Number.parseInt(mod.sourceId, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}


function sourceUpdatedTimestamp(mod: SourceModSummary) {
  return modTimeValue(mod);
}

function compactRelativeTime(timestampMs: number) {
  if (!timestampMs) return null;

  const diff = Math.max(0, Date.now() - timestampMs);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < week) return `${Math.floor(diff / day)}d ago`;
  if (diff < month) return `${Math.floor(diff / week)}w ago`;
  if (diff < year) return `${Math.floor(diff / month)}mo ago`;
  return `${Math.floor(diff / year)}y ago`;
}

function sourceUpdatedLabel(mod: SourceModSummary) {
  const timestamp = sourceUpdatedTimestamp(mod);
  const relative = compactRelativeTime(timestamp);

  if (relative) return `Updated ${relative}`;

  return mod.updatedAt ? `Updated ${String(mod.updatedAt)}` : null;
}

function normalizedTagKey(tag: string) {
  return tag.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sourceCardTags(mod: SourceModSummary) {
  const base = mod.tags ?? [];
  const seen = new Set<string>();
  const hidden = new Set(["nexus", "nexus mods", "modworkshop", "mod workshop", "payday3", "payday 3"]);
  const result: string[] = [];

  for (const tag of base) {
    const clean = String(tag ?? "").trim();
    if (!clean) continue;

    const key = normalizedTagKey(clean);
    if (seen.has(key)) continue;
    seen.add(key);

    if (hidden.has(key)) continue;
    result.push(clean);
    if (result.length >= 8) break;
  }

  return result;
}

function lightweightBrowseMod(mod: SourceModSummary): SourceModSummary {
  const enriched = withKnownAuthor(mod);
  return {
    source: enriched.source,
    sourceId: enriched.sourceId,
    uid: enriched.uid,
    gameId: enriched.gameId,
    nexus: enriched.nexus,
    name: displayModTitle(enriched),
    author: displayAuthor(enriched) ?? enriched.author ?? null,
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

function lightweightBrowseMods(mods: SourceModSummary[]) {
  return mods.map(lightweightBrowseMod);
}

function sortBrowseMods(mods: SourceModSummary[], sort: SortMode) {
  const copy = [...mods];

  copy.sort((a, b) => {
    const timeDelta = modTimeValue(b) - modTimeValue(a);
    const idDelta = sourceIdNumber(b) - sourceIdNumber(a);

    if (sort === "downloads" || sort === "score") return (b.downloads ?? 0) - (a.downloads ?? 0) || timeDelta || idDelta;
    if (sort === "views") return (b.views ?? 0) - (a.views ?? 0) || timeDelta || idDelta;
    if (sort === "likes") return (b.likes ?? 0) - (a.likes ?? 0) || timeDelta || idDelta;
    if (sort === "published_at") return idDelta || timeDelta;
    if (sort === "bumped_at" || sort === "best_match") return timeDelta;
    if (sort === "name") return a.name.localeCompare(b.name) || timeDelta;
    return timeDelta || a.name.localeCompare(b.name);
  });

  return copy;
}


function orderBrowseModsForSource(mods: SourceModSummary[], source: BrowseTab, sort: SortMode) {
  const clean = cleanMods(mods).filter((mod) => mod.source === source);

  if (source === "modworkshop" && (sort === "published_at" || sort === "bumped_at" || sort === "best_match")) {
    return clean;
  }

  return sortBrowseMods(clean, sort);
}

function readCache(profileId: string, source: BrowseTab, sourceGameKey: string, sort: SortMode, page = 1, query = "", categoryId = ""): CachedSourceMods | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(profileId, source, sourceGameKey, sort, page, query, categoryId));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as CachedSourceMods;
    if (parsed.version !== SOURCE_CACHE_VERSION || !Array.isArray(parsed.mods)) return null;

    const age = Date.now() - parsed.savedAt;
    if (age > SOURCE_CACHE_TTL_MS) return null;

    return {
      ...parsed,
      mods: lightweightBrowseMods(orderBrowseModsForSource(parsed.mods, source, sort)),
    };
  } catch {
    return null;
  }
}

function writeCache(profileId: string, source: BrowseTab, sourceGameKey: string, sort: SortMode, mods: SourceModSummary[], page: number, hasMore: boolean, query = "", categoryId = "") {
  try {
    const sorted = source === "modworkshop" && (sort === "published_at" || sort === "bumped_at" || sort === "best_match")
      ? cleanMods(mods).filter((mod) => mod.source === source).slice(0, BROWSE_PAGE_SIZE)
      : orderBrowseModsForSource(mods, source, sort).slice(0, BROWSE_PAGE_SIZE);
    window.localStorage.setItem(
      cacheKey(profileId, source, sourceGameKey, sort, page, query, categoryId),
      JSON.stringify({ version: SOURCE_CACHE_VERSION, savedAt: Date.now(), page, hasMore, mods: lightweightBrowseMods(sorted) }),
    );
  } catch {
    // Cache is optional.
  }
}


function clearModWorkshopBrowseCaches() {
  try {
    const toRemove: string[] = [];

    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key) continue;
      const lower = key.toLowerCase();

      if (
        lower.includes("source-cache") && lower.includes("modworkshop")
        || lower.includes("workshop-browser-rebuild-cache")
      ) {
        toRemove.push(key);
      }
    }

    for (const key of toRemove) window.localStorage.removeItem(key);
  } catch {
    // Optional cache cleanup.
  }
}


const DETAIL_CACHE_VERSION = "v2.0.0-fast-detail-cache";

function detailCacheKey(source: BrowseTab, id: string) {
  return `tsuki-source-detail:${DETAIL_CACHE_VERSION}:${source}:${id}`;
}


function capText(value: string | null | undefined, max = 14_000) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max).trim()}

[Tsuki trimmed this long source payload so the page stays responsive.]` : text;
}

function safeDetail(
  detail: SourceModDetail,
  dataSource: SourceModDetail["dataSource"] = detail.dataSource ?? "live",
  cacheFallbackReason: string | null = detail.cacheFallbackReason ?? null,
): SourceModDetail {
  const author = displayAuthor(detail);
  const liveFiles = dataSource === "live";
  return {
    ...detail,
    dataSource,
    detailDataSource: dataSource,
    fileListDataSource: liveFiles ? "live" : "unavailable",
    cacheFallbackReason,
    author: author ?? detail.author,
    name: displayModTitle(detail) || detail.name,
    shortDescription: capText(cleanDescription(detail.shortDescription || ""), 520),
    tags: Array.isArray(detail.tags) ? detail.tags : [],
    files: liveFiles && Array.isArray(detail.files)
      ? (detail.source === "modworkshop" ? filterModWorkshopFileChoices(detail.files) : detail.files.filter(isInstallableSourceFile))
      : [],
    images: Array.isArray(detail.images) ? detail.images.slice(0, 8) : [],
    comments: Array.isArray(detail.comments) ? detail.comments.slice(0, 12).map((comment) => capText(cleanDescription(comment), 900)) : [],
    logs: Array.isArray(detail.logs) ? detail.logs.slice(0, 12).map((entry) => capText(cleanDescription(entry), 900)) : [],
    stats: Array.isArray(detail.stats) ? detail.stats.slice(0, 10) : [],
    changelog: capText(cleanDescription(detail.changelog || ""), 5000),
    description: capText(cleanDescription(detail.description || detail.shortDescription || ""), 7600),
  };
}

function readDetailCache(mod: SourceModSummary): SourceModDetail | null {
  try {
    const raw = window.localStorage.getItem(detailCacheKey(mod.source, mod.sourceId));
    if (!raw) return null;
    return safeDetail(JSON.parse(raw) as SourceModDetail, "cache", "detail cache placeholder; live detail/file request pending");
  } catch {
    return null;
  }
}

function writeDetailCache(detail: SourceModDetail) {
  try {
    const metadataOnly: SourceModDetail = {
      ...detail,
      files: [],
      dataSource: "cache",
      detailDataSource: "cache",
      fileListDataSource: "unavailable",
      cacheFallbackReason: "metadata-only detail cache; live file data required for downloads",
    };
    window.localStorage.setItem(detailCacheKey(detail.source, detail.sourceId), JSON.stringify(metadataOnly));
  } catch {
    // Cache is optional.
  }
}

function sourceFileTypeLabel(file: SourceModFile) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pak")) return "PAK";
  if (name.endsWith(".ucas")) return "UCAS";
  if (name.endsWith(".utoc")) return "UTOC";
  if (name.endsWith(".zip")) return "ZIP archive";
  if (name.endsWith(".7z")) return "7Z archive";
  if (name.endsWith(".rar")) return "RAR archive";
  if (name.endsWith(".dll")) return "Win64 DLL";
  if (name.endsWith(".lua")) return "Lua script";
  if (name.endsWith(".ini")) return "INI config";
  return "Mod file";
}

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function cleanDescription(text: string) {
  return decodeHtmlEntities(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[\/?(?:heading|b|i|u|size|color|font|center|quote|list|\*|url|img)[^\]]*\]/gi, " ")
    .replace(/\[code\]/gi, "`")
    .replace(/\[\/code\]/gi, "`")
    .replace(/=["']?\/?_nuxt\/[\s\S]*?PAYDAY\s*3/gi, "PAYDAY 3")
    .replace(/(?:^|\s)[a-f0-9]{4,}\s+Description\s+Images\s+Downloads\s+(?:Changelog\s+)?Dependencies\s*&\s*Instructions/gi, " ")
    .replace(/Description\s+Images\s+Downloads\s+(Changelog\s+)?Dependencies\s*&\s*Instructions/gi, " ")
    .replace(/Images\s+Downloads\s+(Changelog\s+)?Dependencies\s*&\s*Instructions/gi, " ")
    .replace(/Upload\s+Mod\s+Mods\s+Games\s+News\s+Discord\s+Forum/gi, " ")
    .replace(/Rules\s+More\s+Wiki\s+Translations\s+Search\s+CTRL\s+K\s+Login\s+Register\s+Games/gi, " ")
    .replace(/Install with Mod Organizer 2.*$/gim, "")
    .replace(/Don't have Mod Organizer 2\??/gim, "")
    .replace(/^\s*[a-f0-9]{4,}\s+/gim, "")
    .replace(/\b(?:Preview\s+)?Video\s+Download\s*\(?[^\n)]*\)?/gi, " ")
    .replace(/\bDownloads?\s+\d+\b/gi, " ")
    .replace(/\bViews?\s+\d+\b/gi, " ")
    .replace(/\bPublish Date\s+/gi, "Published ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function descriptionParagraphs(text: string) {
  const cleaned = cleanDescription(text);
  if (!cleaned) return ["No description loaded."];
  return cleaned.split(/\n{2,}/).map((line) => line.trim()).filter(Boolean).slice(0, 24);
}

function sourceShouldShowInTsukiBrowser(mod: SourceModSummary) {
  const text = [
    mod.name,
    mod.author ?? "",
    mod.shortDescription ?? "",
    mod.pageUrl ?? "",
    ...(mod.tags ?? []),
  ].join(" ").toLowerCase();

  const managerMarkers = [
    "tsuki mod manager",
    "tsukimodmanager",
    "modrex mod manager",
    "moolah mod manager",
    "vortex",
    "mod organizer",
    "mod manager",
    "modmanager",
    "manager setup",
  ];

  return !managerMarkers.some((marker) => text.includes(marker));
}

function cleanMods(mods: SourceModSummary[]) {
  const unique = new Map<string, SourceModSummary>();

  for (const mod of Array.isArray(mods) ? mods : []) {
    if (!mod?.source || !mod?.sourceId || !String(mod?.name ?? "").trim()) continue;
    if (mod.source !== "nexus" && mod.source !== "modworkshop") continue;

    const name = String(mod.name).trim();
    const lowered = name.toLowerCase();
    if (lowered === "unknown mod" || lowered === "untitled" || lowered.startsWith("nexus mod unknown")) continue;
    if (!sourceShouldShowInTsukiBrowser({ ...mod, name })) continue;

    const sourceId = mod.source === "nexus" ? normalizeNexusId(mod.sourceId) ?? String(mod.sourceId) : String(mod.sourceId);
    const gameId = mod.source === "nexus" ? normalizeNexusId(mod.gameId ?? mod.nexus?.gameId) : mod.gameId;
    const uid = mod.source === "nexus" ? normalizeNexusId(mod.uid ?? mod.nexus?.uid) : null;
    const author = displayAuthor({ ...mod, name }) ?? mod.author;
    if (author) rememberSourceAuthor({ ...mod, sourceId, name, author });

    unique.set(`${mod.source}-${sourceId}`, {
      ...mod,
      sourceId,
      uid,
      gameId,
      nexus: mod.source === "nexus" ? {
        gameId,
        modId: sourceId,
        uid,
      } : mod.nexus,
      name: displayModTitle({ ...mod, name }),
      author,
      shortDescription: null,
      tags: Array.isArray(mod.tags) ? mod.tags : [],
    });
  }

  return [...unique.values()];
}

function fallbackDetail(mod: SourceModSummary): SourceModDetail {
  return {
    ...mod,
    dataSource: "fallback",
    detailDataSource: "fallback",
    fileListDataSource: "unavailable",
    cacheFallbackReason: "basic placeholder while live detail loads",
    tags: Array.isArray(mod.tags) ? mod.tags : [],
    description: cleanDescription(mod.shortDescription || "No detailed description was loaded."),
    changelog: null,
    files: [],
    images: [],
    comments: [],
    bugs: [],
    logs: [],
    stats: [],
  };
}

function hasLiveFileData(detail: SourceModDetail | null | undefined) {
  return detail?.dataSource === "live" && detail?.detailDataSource === "live" && detail?.fileListDataSource === "live";
}

function liveFileDataUnavailableMessage() {
  return "Live file data unavailable. Please try again.";
}

function newestFiles(files: SourceModFile[]) {
  return [...files].sort(compareSourceFilesNewest);
}

function isImageAssetFile(file: SourceModFile) {
  const text = `${file.name} ${file.downloadUrl ?? ""}`.toLowerCase().split("?")[0];

  return [".webp", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".avif", ".ico", ".bmp"].some((extension) => text.endsWith(extension))
    || text.includes("/images/")
    || text.includes("/image/")
    || text.includes("/media/")
    || text.includes("/thumbnail")
    || file.name.toLowerCase().startsWith("thumbnail_");
}

function isGenericModWorkshopPlaceholder(file: SourceModFile) {
  const lower = file.name.trim().toLowerCase();
  return lower === "download" || lower === "latest" || lower === "latest modworkshop file" || /^modworkshop file \d+$/.test(lower);
}

function fileHasRouteHint(file: SourceModFile) {
  const text = `${file.name} ${file.downloadUrl ?? ""}`.toLowerCase();
  return [
    ".zip", ".rar", ".7z", ".pak", ".ucas", ".utoc", ".dll", ".lua", ".ini",
    ".json", ".toml", ".bk2", ".bik", ".mp4", ".webm", ".usm", ".wmv", ".m4v",
    ".mov", ".wem", ".bnk", "mods/", "/mods/", "content/movies",
  ].some((token) => text.includes(token));
}

function filterModWorkshopFileChoices(files: SourceModFile[]) {
  const installable = files.filter(isInstallableSourceFile);
  const hasNamedRouteFile = installable.some((file) => !isGenericModWorkshopPlaceholder(file) && fileHasRouteHint(file));

  if (!hasNamedRouteFile) {
    return newestFiles(installable).filter((file) => !isGenericModWorkshopPlaceholder(file)
      || Boolean(file.downloadUrl && /\/download(?:\?|$)|storage\.modworkshop\.net/i.test(file.downloadUrl)));
  }

  return newestFiles(installable).filter((file) => !isGenericModWorkshopPlaceholder(file) || fileHasRouteHint(file));
}


function isInstallableSourceFile(file: SourceModFile) {
  if (isImageAssetFile(file)) return false;

  const text = `${file.name} ${file.downloadUrl ?? ""}`.toLowerCase();

  if (
    [
      ".zip", ".rar", ".7z", ".pak", ".ucas", ".utoc", ".dll", ".lua", ".ini",
      ".json", ".bk2", ".bik", ".mp4", ".webm", ".wem", ".bnk",
      "/download", "/files/", "/mods/files/", "api.modworkshop.net",
    ].some((token) => text.includes(token))
  ) {
    return true;
  }

  // Nexus file rows often do not include a direct URL or extension.
  // The backend can still download them by source/mod id/file id, so keep them visible.
  return Boolean(file.id && file.id !== "unknown" && !file.id.startsWith("image-"));
}

function installableFiles(files: SourceModFile[], source?: BrowseTab) {
  if (source === "modworkshop") return filterModWorkshopFileChoices(files);
  return newestFiles(files).filter(isInstallableSourceFile);
}
void clearModWorkshopBrowseCaches;

type SourceFileBucket = "main" | "optional" | "old";

function sourceFileDateValue(file: SourceModFile) {
  const raw = String(file.uploadedAt ?? "").trim();
  if (!raw) return 0;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric < 4_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fileVersionScore(file: SourceModFile) {
  const raw = `${file.version ?? ""} ${file.name}`.toLowerCase();
  const numbers = raw.match(/\d+(?:\.\d+)?/g)?.slice(0, 4).map(Number) ?? [];
  return numbers.reduce((score, value, index) => score + value / Math.pow(1000, index), 0);
}

function compareSourceFilesNewest(a: SourceModFile, b: SourceModFile) {
  return sourceFileDateValue(b) - sourceFileDateValue(a)
    || fileVersionScore(b) - fileVersionScore(a)
    || String(b.id).localeCompare(String(a.id));
}

function normalizedFileSeries(file: SourceModFile) {
  return file.name
    .toLowerCase()
    .replace(/\.(zip|rar|7z|pak|ucas|utoc|dll|lua|ini)$/i, "")
    // Strip both spaced versions ("version 1.2") and attached versions ("ExpansionVer1.0.2").
    .replace(/(?:^|[^a-z0-9])(ver|version|v)\s*\d+(?:\.\d+){0,4}/gi, " ")
    .replace(/(ver|version|v)\s*\d+(?:\.\d+){0,4}/gi, " ")
    .replace(/\b\d+(?:\.\d+){0,4}\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sourceFileKind(file: SourceModFile, newestMain?: SourceModFile | null, source?: ModSourceKind): SourceFileBucket {
  const category = file.fileType?.toLowerCase();
  if (category && ["old_version", "archived", "deleted"].includes(category)) return "old";
  if (category && ["optional", "miscellaneous", "update"].includes(category)) return "optional";
  const text = `${file.name} ${file.version ?? ""} ${file.downloadUrl ?? ""}`.toLowerCase();
  if (/\b(old|legacy|previous|archive|archived|deprecated|outdated|unsupported)\b/.test(text)) return "old";
  if (!newestMain || file.id === newestMain.id) return "main";
  if (source === "modworkshop") return "optional";

  const thisSeries = normalizedFileSeries(file);
  const mainSeries = normalizedFileSeries(newestMain);
  const sameSeries = Boolean(thisSeries && mainSeries && (thisSeries === mainSeries || thisSeries.includes(mainSeries) || mainSeries.includes(thisSeries)));
  const olderDate = sourceFileDateValue(file) > 0 && sourceFileDateValue(newestMain) > 0 && sourceFileDateValue(file) < sourceFileDateValue(newestMain);
  const olderVersion = fileVersionScore(file) > 0 && fileVersionScore(newestMain) > 0 && fileVersionScore(file) < fileVersionScore(newestMain);

  if (sameSeries && file.id !== newestMain.id) return "old";
  if (olderDate || olderVersion) return "old";
  if (/\b(optional|addon|add-on|patch|compat|plugin|extra|lite|translation|variant|bonus|separate|requirement|required)\b/.test(text)) return "optional";
  return "optional";
}

function groupedSourceFiles(files: SourceModFile[], source?: ModSourceKind) {
  const installable = source === "modworkshop"
    ? filterModWorkshopFileChoices(files)
    : newestFiles(files).filter(isInstallableSourceFile).sort(compareSourceFilesNewest);
  const newestMain = source === "modworkshop"
    ? installable[0] ?? null
    : installable.find((file) => file.fileType?.toLowerCase() === "main")
      ?? installable.find((file) => !["optional", "miscellaneous", "old_version", "archived", "deleted"].includes(file.fileType?.toLowerCase() ?? "") && !/\b(optional|addon|add-on|patch|compat|plugin|extra|lite|translation|variant|old|legacy|previous|archive|deprecated)\b/i.test(`${file.name} ${file.version ?? ""}`)) ?? installable[0] ?? null;
  const groups: Record<SourceFileBucket, SourceModFile[]> = { main: [], optional: [], old: [] };

  for (const file of installable) {
    const bucket = sourceFileKind(file, newestMain, source);
    groups[bucket].push(file);
  }

  if (groups.main.length === 0 && installable.length > 0) {
    const first = installable[0];
    groups.main.push(first);
    groups.optional = groups.optional.filter((file) => file.id !== first.id);
    groups.old = groups.old.filter((file) => file.id !== first.id);
  }

  return groups;
}

function defaultSelectedFileIds(files: SourceModFile[], source?: ModSourceKind) {
  const groups = groupedSourceFiles(files, source);
  return groups.main.slice(0, 1).map((file) => file.id);
}

function formatSourceDate(raw?: string | null) {
  const value = String(raw ?? "").trim();
  if (!value) return "Unknown date";
  const numeric = /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  const timestamp = Number.isFinite(numeric) ? (numeric < 4_000_000_000 ? numeric * 1000 : numeric) : Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return value.replace(/T.+$/, "");
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(new Date(timestamp));
}

function cleanVersionLabel(file: SourceModFile) {
  const version = String(file.version ?? "").trim();
  if (!version || version === "0") return "Version unknown";
  return version.toLowerCase().startsWith("v") ? version : `v${version}`;
}

function sourceFileMetaLine(file: SourceModFile) {
  return [
    file.fileType ? file.fileType.toUpperCase() : null,
    sourceFileTypeLabel(file),
    cleanVersionLabel(file),
    file.sizeLabel ?? "Unknown size",
    typeof file.downloadCount === "number" ? `${file.downloadCount.toLocaleString()} downloads` : null,
    `Uploaded ${formatSourceDate(file.uploadedAt)}`,
  ].filter(Boolean).join(" - ");
}

function matchedFileNamesForSourceFile(file: SourceModFile, match?: InstalledSourceMatch | null) {
  if (!match?.installed) return [];
  const needle = file.name.toLowerCase().replace(/\s+/g, "");
  const fileId = file.id.toLowerCase();
  const sourceFileName = String(match.sourceFileName ?? "").toLowerCase().replace(/\s+/g, "");
  const sourceFileId = String(match.sourceFileId ?? "").toLowerCase();
  return (match.matchedFiles ?? []).filter((value) => {
    const clean = value.toLowerCase().replace(/\s+/g, "");
    return clean.includes(needle)
      || clean.includes(fileId)
      || (sourceFileId === fileId && sourceFileName.includes(needle));
  });
}


function fileKey(mod: SourceModDetail, file: SourceModFile) {
  return `${mod.source}-${mod.sourceId}-${file.id}`;
}

function MiniProgress({ active }: { active: boolean }) {
  if (!active) return null;

  return (
    <div className="safe-progress">
      <div />
      <span>Downloading + inspecting...</span>
    </div>
  );
}

function ResultNotice({ result, profileId }: { result: StagedDownloadResult; profileId: string }) {
  const failed = result.archiveKind === "download-failed";
  const [handoffStatus, setHandoffStatus] = useState<string | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [manager, setManager] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setManager(null);
    if (!failed && !result.canInstallLater) {
      void invoke<string | null>("get_external_manager_target", { profileId, stagedFilePath: result.stagedFilePath })
        .then(value => { if (current) setManager(value); }).catch(() => {});
    }
    return () => { current = false; };
  }, [profileId, result.stagedFilePath, result.canInstallLater, failed]);
  const handoff = async () => {
    setHandoffBusy(true);
    try { setHandoffStatus(await invoke<string>("prepare_external_manager_handoff", { profileId, stagedFilePath: result.stagedFilePath })); }
    catch (error) { setHandoffStatus(String(error)); }
    finally { setHandoffBusy(false); }
  };
  return (
    <div className={`safe-result ${failed ? "failed" : ""}`}>
      <strong>{failed ? "Failed" : "Staged"}</strong>
      <span>{result.fileName}</span>
      <small>{failed ? result.warnings.join(" ") : `${result.archiveKind} - ${result.sizeBytes.toLocaleString()} bytes`}</small>
      {!failed && !result.canInstallLater && <small>{result.warnings.join(" ") || "Automatic installation is unavailable for this package. Review its required loader and authored installation instructions."}</small>}
      {!failed && !result.canInstallLater && manager && <button type="button" className="primary-button" disabled={handoffBusy} onClick={() => void handoff()}>{handoffBusy ? "Preparing..." : `Prepare for ${manager}`}</button>}
      {handoffStatus && <small role="status">{handoffStatus}</small>}
    </div>
  );
}
interface BrowsePageProps {
  initialMod?: SourceModSummary | null;
  onInitialModConsumed?: () => void;
  currentGameProfile: GameProfile;
  profileRuntime?: ActiveProfileRuntime | null;
  profileSwitching?: boolean;
}

export function BrowsePage({ initialMod = null, onInitialModConsumed, currentGameProfile, profileRuntime, profileSwitching = false }: BrowsePageProps) {
  const profileId = currentGameProfile.profileId;
  const [profileSourceSettings, setProfileSourceSettings] = useState<ProfileSettings | null>(null);
  const runtimeSourceConfig = profileRuntime?.sourceConfig ?? currentGameProfile.sourceConfig ?? {};
  const gameName = profileRuntime?.gameName || currentGameProfile.displayName || "Current game";
  const gameInstalled = currentGameProfile.installation?.installed === true;
  const sourceInstallsReady = currentGameProfile.sourceInstallSupport === "ready";
  const downloadsEnabled = gameInstalled && sourceInstallsReady;
  const downloadsBlockedMessage = !gameInstalled
    ? `${gameName} is not installed. Browsing is available, but downloads and installs are disabled.`
    : `Downloads for ${gameName} stay disabled until its profile install rules finish validation.`;
  const sessionScope = profileBrowseSessionIdentity(profileId, currentGameProfile.gameVersion, runtimeSourceConfig);
  const restoredSession = browseSessionSnapshot?.scope === sessionScope ? browseSessionSnapshot : null;
  const explicitSourceSettings = profileSourceSettings?.enabledSources ?? [];
  const sourceAllowed = (source: ProfileSourceId) => explicitSourceSettings.length === 0 || explicitSourceSettings.includes(source);
  const configuredSources = useMemo(
    () => profileSourcesFromConfig(runtimeSourceConfig, gameName).filter((source) => sourceAllowed(source.provider === "custom" ? "custom" : source.provider)),
    [explicitSourceSettings.join("|"), gameName, runtimeSourceConfig],
  );
  const initialSource = configuredSources.find((source) => source.id === restoredSession?.activeSourceId) ?? configuredSources[0] ?? null;
  const [activeSourceId, setActiveSourceId] = useState(() => initialSource?.id ?? "");
  const activeSource = configuredSources.find((source) => source.id === activeSourceId) ?? configuredSources[0] ?? null;
  const sourceTabFor = (source?: GameProfileSourceDefinition | null): BrowseTab => source?.browseMode === "api"
    ? source.provider === "custom" ? "custom" : source.provider
    : "custom";
  const configuredNexusDomain = activeSource?.provider === "nexus"
    ? activeSource.providerSlug || parseNexusDomainFromUrl(activeSource.gamePageUrl) || parseNexusDomainFromUrl(activeSource.listingUrl) || parseNexusDomainFromUrl(activeSource.startUrl)
    : runtimeSourceConfig.nexusDomain || parseNexusDomainFromUrl(runtimeSourceConfig.nexusGamePageUrl) || parseNexusDomainFromUrl(runtimeSourceConfig.nexusCategoryUrl) || parseNexusDomainFromUrl(runtimeSourceConfig.nexusEmbeddedStartUrl);
  const configuredModWorkshopSlug = activeSource?.provider === "modworkshop"
    ? activeSource.providerSlug || parseModWorkshopSlugFromUrl(activeSource.gamePageUrl) || parseModWorkshopSlugFromUrl(activeSource.listingUrl) || parseModWorkshopSlugFromUrl(activeSource.startUrl)
    : runtimeSourceConfig.modworkshopSlug || parseModWorkshopSlugFromUrl(runtimeSourceConfig.modworkshopGamePageUrl) || parseModWorkshopSlugFromUrl(runtimeSourceConfig.modworkshopCategoryUrl) || parseModWorkshopSlugFromUrl(runtimeSourceConfig.modworkshopEmbeddedStartUrl);
  const hasModWorkshopSource = configuredSources.some((source) => source.provider === "modworkshop" && source.browseMode === "api");
  const hasNexusSource = configuredSources.some((source) => source.provider === "nexus" && source.browseMode === "api");
  const customBrowserStartUrl = normalizeBrowserUrl(activeSource?.startUrl || activeSource?.listingUrl || activeSource?.gamePageUrl || runtimeSourceConfig.customBrowserStartUrl || "");
  const customBrowserAllowedDomains = activeSource?.allowedDomains?.length ? activeSource.allowedDomains : runtimeSourceConfig.customBrowserAllowedDomains ?? [];
  const customBrowserName = activeSource?.displayName || "Custom Browser";
  const customBrowserDomainList = customBrowserAllowedDomains.map(normalizeAllowedDomain).filter(Boolean);
  const hasCustomBrowserSource = configuredSources.some((source) => source.browseMode !== "api");
  const hasConfiguredSources = profileHasConfiguredSources(currentGameProfile) || hasModWorkshopSource || hasNexusSource || hasCustomBrowserSource;
  const modWorkshopGameKey = configuredModWorkshopSlug || activeSource?.providerGameId || runtimeSourceConfig.modworkshopGameId || currentGameProfile.gameKey || profileId;
  const modWorkshopCategoryKey = `${activeSourceId || "legacy"}:${modWorkshopGameKey}`;
  const nexusGameDomain = configuredNexusDomain || null;
  const nexusGameKey = configuredNexusDomain || activeSource?.providerGameId || runtimeSourceConfig.nexusGameId || currentGameProfile.gameKey || profileId;
  const exactSourceCacheKey = activeSource ? profileSourceCacheIdentity(profileId, activeSource) : profileId;
  const sourceGameKeyFor = (source: BrowseTab) => source === "nexus" ? `${exactSourceCacheKey}:${nexusGameKey}` : source === "modworkshop" ? `${exactSourceCacheKey}:${modWorkshopGameKey}` : exactSourceCacheKey;
  const sourceStartUrlFor = (source: BrowseTab) => {
    if (activeSource && sourceTabFor(activeSource) === source) {
      return firstConfiguredUrl(activeSource.startUrl, activeSource.listingUrl, activeSource.gamePageUrl);
    }
    if (source === "nexus") {
      return firstConfiguredUrl(
        runtimeSourceConfig.nexusEmbeddedStartUrl,
        runtimeSourceConfig.nexusCategoryUrl,
        runtimeSourceConfig.nexusGamePageUrl,
        configuredNexusDomain ? `https://www.nexusmods.com/${configuredNexusDomain}/mods` : "",
      );
    }
    if (source === "modworkshop") {
      return firstConfiguredUrl(
        runtimeSourceConfig.modworkshopEmbeddedStartUrl,
        runtimeSourceConfig.modworkshopCategoryUrl,
        runtimeSourceConfig.modworkshopGamePageUrl,
        configuredModWorkshopSlug ? `https://modworkshop.net/g/${configuredModWorkshopSlug}/mods` : "",
      );
    }
    return customBrowserStartUrl;
  };
  const restoredSessionHasCards = Boolean(restoredSession?.mods.length);
  const restoredSessionRef = useRef(restoredSessionHasCards);
  const [activeTab, setActiveTab] = useState<BrowseTab>(() => initialSource ? sourceTabFor(initialSource) : restoredSession?.activeTab ?? "modworkshop");
  const [sortMode, setSortMode] = useState<SortMode>(() => normalizeSortMode(restoredSession?.sortMode ?? DEFAULT_SORT, restoredSession?.activeTab ?? "modworkshop"));
  const [categoryId, setCategoryId] = useState(() => restoredSession?.categoryId ?? "");
  const [categoryLabel, setCategoryLabel] = useState(() => restoredSession?.categoryLabel ?? "");
  const [view, setView] = useState<ViewMode>(() => restoredSession?.view ?? "list");
  const [mods, setMods] = useState<SourceModSummary[]>(() => restoredSession?.mods ?? []);
  const [pages, setPages] = useState<BrowsePageNumbers>(() => browsePageNumbers(restoredSession?.pages));
  const [hasMore, setHasMore] = useState<BrowsePageBooleans>(() => browsePageBooleans(restoredSession?.hasMore));
  const [loadingSource, setLoadingSource] = useState<BrowseTab | null>(null);
  const [status, setStatus] = useState(() => restoredSession?.status ?? "Safe Browse is ready.");
  const [searchQuery, setSearchQuery] = useState(() => restoredSession?.searchQuery ?? "");
  const [sourceSearchQuery, setSourceSearchQuery] = useState(() => restoredSession?.sourceSearchQuery ?? "");
  const [activeModWorkshopSearch, setActiveModWorkshopSearch] = useState(() => restoredSession?.activeModWorkshopSearch ?? "");
  const [, setModWorkshopSearchPage] = useState(0);
  const [activeNexusSearch, setActiveNexusSearch] = useState(() => restoredSession?.activeNexusSearch ?? "");
  const [sourceSearching, setSourceSearching] = useState(false);
  const [selectedMod, setSelectedMod] = useState<SourceModDetail | null>(() => restoredSession?.selectedMod ?? null);
  const [detailLoadingKey, setDetailLoadingKey] = useState<string | null>(null);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [installPickerMod, setInstallPickerMod] = useState<SourceModDetail | null>(null);
  const [installPickerReplacementFiles, setInstallPickerReplacementFiles] = useState<string[]>([]);
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [results, setResults] = useState<StagedDownloadResult[]>([]);
  const [sourceMatches, setSourceMatches] = useState<Record<string, InstalledSourceMatch>>(() => restoredSession?.sourceMatches ?? {});
  const [failedImages, setFailedImages] = useState<Record<string, number>>(() => readThumbnailFailures());
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [cacheNote, setCacheNote] = useState(() => restoredSession?.cacheNote ?? "");
  const [browseCardsLive, setBrowseCardsLive] = useState(() => restoredSession?.browseCardsLive ?? false);
  const [nexusApiKeyMissing, setNexusApiKeyMissing] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [customBrowserInput, setCustomBrowserInput] = useState(customBrowserStartUrl);
  const [customBrowserUrl, setCustomBrowserUrl] = useState(customBrowserStartUrl);
  const [customBrowserFrameKey, setCustomBrowserFrameKey] = useState(0);
  const [customBrowserLoading, setCustomBrowserLoading] = useState(Boolean(customBrowserStartUrl));
  const [managedBrowserOpen, setManagedBrowserOpen] = useState(false);
  const [managedBrowserOpening, setManagedBrowserOpening] = useState(false);
  const managedBrowserViewportRef = useRef<HTMLDivElement | null>(null);
  const initialCategoryCacheRef = useRef(readModWorkshopCategoryCacheEntry(profileId, modWorkshopCategoryKey));
  const [modWorkshopCategories, setModWorkshopCategories] = useState<SourceCategory[]>(() => initialCategoryCacheRef.current?.categories ?? []);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [categoryStatus, setCategoryStatus] = useState<CategoryStatus>(() => initialCategoryCacheRef.current ? (initialCategoryCacheRef.current.stale ? "cached" : "loaded") : "idle");
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [categoryRetryTick, setCategoryRetryTick] = useState(0);
  const browseRequestSeqRef = useRef(0);
  const categoryRequestKeyRef = useRef("");
  const modWorkshopSearchCacheRef = useRef<Map<string, SourceModSummary[]>>(new Map());
  const nexusSearchCacheRef = useRef<Map<string, SourceModSummary[]>>(new Map());
  const sourceMatchRefreshTimerRef = useRef<number | null>(null);
  const activeSortOptions = useMemo(() => sortOptionsForSource(activeTab), [activeTab]);
  const activeProfileRef = useRef(profileId);

  useEffect(() => {
    let cancelled = false;
    const loadProfileSourceSettings = () => {
      invoke<ProfileSettings>("get_profile_settings", { profileId })
        .then((value) => { if (!cancelled) setProfileSourceSettings(normalizeProfileSettings(value, profileId)); })
        .catch(() => { if (!cancelled) setProfileSourceSettings(null); });
    };
    loadProfileSourceSettings();
    const onProfileSettingsChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ profileId?: string; settings?: ProfileSettings }>).detail;
      if (detail?.profileId === profileId) setProfileSourceSettings(normalizeProfileSettings(detail.settings, profileId));
    };
    window.addEventListener("tsuki-profile-settings-changed", onProfileSettingsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("tsuki-profile-settings-changed", onProfileSettingsChanged);
    };
  }, [profileId]);

  useEffect(() => {
    if (activeSource && activeSource.id === activeSourceId) return;
    const next = configuredSources[0];
    setActiveSourceId(next?.id ?? "");
    if (next) setActiveTab(sourceTabFor(next));
  }, [activeSource, activeSourceId, configuredSources]);

  useEffect(() => {
    if (activeTab === "modworkshop" && !hasModWorkshopSource) {
      setActiveTab(hasNexusSource ? "nexus" : hasCustomBrowserSource ? "custom" : "modworkshop");
    }
    if (activeTab === "nexus" && !hasNexusSource) {
      setActiveTab(hasModWorkshopSource ? "modworkshop" : hasCustomBrowserSource ? "custom" : "nexus");
    }
    if (activeTab === "custom" && !hasCustomBrowserSource) {
      setActiveTab(hasModWorkshopSource ? "modworkshop" : hasNexusSource ? "nexus" : "modworkshop");
    }
  }, [activeTab, hasCustomBrowserSource, hasModWorkshopSource, hasNexusSource]);

  useEffect(() => {
    setCustomBrowserInput(customBrowserStartUrl);
    setCustomBrowserUrl(customBrowserStartUrl);
    setCustomBrowserFrameKey((value) => value + 1);
    setCustomBrowserLoading(Boolean(customBrowserStartUrl));
  }, [activeSourceId, customBrowserStartUrl, profileId]);

  useEffect(() => {
    if (!activeSource || activeSource.browseMode === "api" || activeSource.browseMode === "iframe") {
      setManagedBrowserOpen(false);
      return;
    }

    let cancelled = false;
    const label = `${profileId}-${activeSource.id}`;
    const syncWindowState = () => {
      invoke<EmbeddedBrowserStatus>("get_embedded_browser_status", { label })
        .then((browser) => {
          if (!cancelled) setManagedBrowserOpen(browser.open);
        })
        .catch(() => {
          if (!cancelled) setManagedBrowserOpen(false);
        });
    };

    syncWindowState();
    const timer = window.setInterval(syncWindowState, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      void invoke<string>("control_embedded_browser_window", { label, action: "close" }).catch(() => undefined);
    };
  }, [activeSource?.browseMode, activeSource?.id, profileId]);

  useEffect(() => {
    if (!managedBrowserOpen || !activeSource || activeSource.browseMode === "iframe") return;
    const element = managedBrowserViewportRef.current;
    if (!element) return;
    const label = `${profileId}-${activeSource.id}`;
    let frame = 0;

    const updateBounds = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        const bounds = currentManagedBrowserBounds();
        const visible = Boolean(bounds);
        void invoke("set_embedded_browser_bounds", {
          label,
          x: bounds?.x ?? rect.left,
          y: bounds?.y ?? rect.top,
          width: bounds?.width ?? Math.max(320, rect.width),
          height: bounds?.height ?? Math.max(240, rect.height),
          visible,
        }).catch(() => undefined);
      });
    };

    const observer = new ResizeObserver(updateBounds);
    observer.observe(element);
    window.addEventListener("resize", updateBounds);
    document.addEventListener("scroll", updateBounds, true);
    updateBounds();
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
      document.removeEventListener("scroll", updateBounds, true);
    };
  }, [activeSource?.browseMode, activeSource?.id, managedBrowserOpen, profileId]);

  useEffect(() => {
    if (activeProfileRef.current === profileId) {
      if (profileSwitching) setStatus("Switching profile...");
      return;
    }

    activeProfileRef.current = profileId;
    browseRequestSeqRef.current += 1;
    modWorkshopSearchCacheRef.current.clear();
    nexusSearchCacheRef.current.clear();
    const nextSource = configuredSources[0] ?? null;
    setActiveSourceId(nextSource?.id ?? "");
    setActiveTab(nextSource ? sourceTabFor(nextSource) : hasModWorkshopSource ? "modworkshop" : hasNexusSource ? "nexus" : hasCustomBrowserSource ? "custom" : "modworkshop");
    setSortMode(DEFAULT_SORT);
    setCategoryId("");
    setCategoryLabel("");
    setView("list");
    setMods([]);
    setPages(browsePageNumbers());
    setHasMore(browsePageBooleans({ modworkshop: hasModWorkshopSource, nexus: hasNexusSource, custom: false }));
    setLoadingSource(null);
    setSearchQuery("");
    setSourceSearchQuery("");
    setActiveModWorkshopSearch("");
    setActiveNexusSearch("");
    setSelectedMod(null);
    setSourceMatches({});
    setCacheNote("");
    setBrowseCardsLive(false);
    const cachedCategories = readModWorkshopCategoryCacheEntry(profileId, modWorkshopCategoryKey);
    setModWorkshopCategories(cachedCategories?.categories ?? []);
    setCategoryStatus(cachedCategories ? (cachedCategories.stale ? "cached" : "loaded") : "idle");
    setCategoryError(null);
    setStatus(profileSwitching ? "Switching profile..." : hasConfiguredSources ? "Safe Browse is ready." : "No browse sources configured for this profile.");
  }, [configuredSources, hasConfiguredSources, hasCustomBrowserSource, hasModWorkshopSource, hasNexusSource, modWorkshopCategoryKey, profileId, profileSwitching]);

  const sourceMods = useMemo(() => {
    const base = orderBrowseModsForSource(mods, activeTab, sortMode).filter((mod) => {
      if (mod.source !== "modworkshop") return true;
      return modWorkshopCardMatchesSource(mod.gameId, mod.tags ?? [], activeSource, modWorkshopGameKey);
    });
    const activeSearch = activeTab === "modworkshop" ? activeModWorkshopSearch : activeNexusSearch;
    const filtered = searchQuery && !activeSearch ? base.filter((mod) => modMatchesQuery(mod, searchQuery)) : base;
    return filtered.slice(0, BROWSE_PAGE_SIZE);
  }, [activeModWorkshopSearch, activeNexusSearch, activeTab, activeSource, mods, modWorkshopGameKey, searchQuery, sortMode]);

  const sourceModsSignature = useMemo(
    () => sourceMods.map((mod) => `${mod.source}:${mod.sourceId}`).join("|"),
    [sourceMods],
  );

  useEffect(() => {
    browseSessionSnapshot = {
      scope: sessionScope,
      profileId,
      activeSourceId,
      activeTab,
      sortMode,
      categoryId,
      categoryLabel,
      view,
      mods,
      pages,
      hasMore,
      status,
      searchQuery,
      sourceSearchQuery,
      activeModWorkshopSearch,
      activeNexusSearch,
      selectedMod,
      sourceMatches,
      browseCardsLive,
      cacheNote,
    };
  }, [
    sessionScope,
    activeModWorkshopSearch,
    activeNexusSearch,
    activeSourceId,
    activeTab,
    browseCardsLive,
    cacheNote,
    categoryId,
    categoryLabel,
    hasMore,
    mods,
    pages,
    searchQuery,
    selectedMod,
    sortMode,
    sourceMatches,
    sourceModsSignature,
    sourceSearchQuery,
    status,
    view,
  ]);

  useEffect(() => {
    if (activeSortOptions.length === 0) return;
    if (activeSortOptions.some((option) => option.id === sortMode)) return;
    setSortMode(normalizeSortMode(sortMode, activeTab));
  }, [activeSortOptions, activeTab, sortMode]);


  useEffect(() => {
    let cancelled = false;

    const refreshNexusKeyStatus = () => {
      invoke<AppSettings>("get_app_settings")
        .then((settings) => {
          if (cancelled) return;
          setNexusApiKeyMissing(!settings.nexusApiKey?.trim());
          setDeveloperMode(settings.developerMode ?? false);
        })
        .catch(() => {
          if (!cancelled) setNexusApiKeyMissing(true);
        });
    };

    refreshNexusKeyStatus();
    window.addEventListener("focus", refreshNexusKeyStatus);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshNexusKeyStatus);
    };
  }, []);

  useEffect(() => {
    if (activeTab !== "modworkshop") return;
    if (!hasModWorkshopSource || profileSwitching) return;
    const cachedCategories = readModWorkshopCategoryCacheEntry(profileId, modWorkshopCategoryKey);
    const hasCache = Boolean(cachedCategories?.categories.length);

    if (hasCache) {
      setModWorkshopCategories(cachedCategories!.categories);
    }

    if (hasCache && !cachedCategories!.stale && categoryRetryTick === 0) {
      setCategoryStatus("loaded");
      setCategoryError(null);
      return;
    }

    const requestKey = `${profileId}:${activeSourceId}:${modWorkshopGameKey}:${categoryRetryTick}:${cachedCategories?.savedAt ?? 0}`;
    if (categoryRequestKeyRef.current === requestKey) return;
    categoryRequestKeyRef.current = requestKey;

    let cancelled = false;
    setCategoriesLoading(true);
    setCategoryStatus(hasCache ? "cached" : "loading");
    setCategoryError(null);

    invokeWithTimeout<SourceCategory[]>(
      "fetch_modworkshop_categories",
      { gameId: modWorkshopGameKey, profileId, profileName: gameName },
      8000,
      "ModWorkshop categories timed out.",
    )
      .then((categories) => {
        if (cancelled) return;
        const clean = categories
          .filter((category) => category.id && category.label)
          .sort((a, b) => a.label.localeCompare(b.label));
        setModWorkshopCategories(clean);
        if (clean.length > 0) writeModWorkshopCategoryCache(profileId, modWorkshopCategoryKey, clean);
        if (clean.length === 0) {
          setCategoryStatus(hasCache ? "cache-refresh-failed" : "unavailable");
          const reason = `ModWorkshop returned zero usable categories for ${gameName} (${modWorkshopGameKey}). Cache available: ${hasCache ? "yes" : "no"}.`;
          setCategoryError(reason);
          recordModWorkshopCategoryDiagnostic({
            profileId,
            profileName: gameName,
            gameId: modWorkshopGameKey,
            status: "warning",
            reason,
            cacheAvailable: hasCache,
            cacheUsed: hasCache,
          });
          if (!hasCache) setStatus(`ModWorkshop categories are unavailable for ${gameName} (${modWorkshopGameKey}).`);
        } else {
          setCategoryStatus("loaded");
          setCategoryError(null);
          recordModWorkshopCategoryDiagnostic({
            profileId,
            profileName: gameName,
            gameId: modWorkshopGameKey,
            status: "success",
            reason: `Loaded ${clean.length} ModWorkshop categories.`,
            cacheAvailable: hasCache,
            cacheUsed: false,
          });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setCategoryStatus(hasCache ? "cache-refresh-failed" : "failed");
          const reason = `${message} Cache available: ${hasCache ? "yes" : "no"}. Cache used: ${hasCache ? "yes" : "no"}.`;
          const serviceUnavailable = /(?:HTTP\s*)?50[234]\b|bad gateway|service unavailable|gateway timeout/i.test(message);
          setCategoryError(serviceUnavailable
            ? `ModWorkshop is temporarily unavailable (${message.match(/HTTP\s*50[234]|50[234]\s+Bad Gateway/i)?.[0] ?? "server error"}). ${hasCache ? "Tsuki kept the exact cached category list." : "Category filtering will return when the service recovers."}`
            : reason);
          recordModWorkshopCategoryDiagnostic({
            profileId,
            profileName: gameName,
            gameId: modWorkshopGameKey,
            status: "failed",
            reason,
            cacheAvailable: hasCache,
            cacheUsed: hasCache,
          });
          setStatus(hasCache ? `${message} Using cached ModWorkshop categories for ${gameName}.` : message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCategoriesLoading(false);
        }
      });

    return () => {
      cancelled = true;
      if (categoryRequestKeyRef.current === requestKey) categoryRequestKeyRef.current = "";
    };
    // Do not depend on categoriesLoading here. Setting it true would clean up
    // this effect and mark the in-flight request as cancelled before it can
    // populate the dropdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, categoryRetryTick, gameName, hasModWorkshopSource, modWorkshopCategoryKey, modWorkshopGameKey, profileId, profileSwitching]);

  function markThumbnailFailed(url: string | null | undefined) {
    if (!url) return;

    const next = { ...readThumbnailFailures(), [url]: Date.now() };
    writeThumbnailFailures(next);
    setFailedImages(next);
  }

  function canUseThumbnail(url: string | null | undefined) {
    return Boolean(url && !thumbnailRecentlyFailed(url, failedImages));
  }


  async function refreshSourceMatches(modsToCheck = sourceMods) {
    const clean = cleanMods(modsToCheck);

    if (clean.length === 0) {
      if (modsToCheck === sourceMods) setSourceMatches({});
      return;
    }

    try {
      const result = await invoke<InstalledSourceMatch[]>("match_installed_source_mods", {
        sourceMods: clean,
        profileId,
      });

      const next: Record<string, InstalledSourceMatch> = {};
      for (const match of result) next[`${match.source}-${match.sourceId}`] = match;
      setSourceMatches((current) => clean.length >= sourceMods.length ? next : { ...current, ...next });
    } catch {
      // Installed badges are optional in Browse. Never crash the page for this.
    }
  }

  async function uninstallMatchedSource(match: InstalledSourceMatch) {
    if (!match.installed || match.matchedFiles.length === 0) {
      setStatus("No installed files were matched for uninstall.");
      return;
    }

    setInstallingKey(`${match.source}-${match.sourceId}-uninstall`);

    try {
      const result = match.matchKind === "receipt"
        ? await invoke<string>("uninstall_source_install", { source: match.source, sourceId: match.sourceId, profileId })
        : await invoke<string>("uninstall_pak_mod_files", { fileNames: match.matchedFiles, profileId });

      setStatus(result);
      window.dispatchEvent(new Event("tsuki-data-refresh"));
      await refreshSourceMatches(selectedMod ? [selectedMod] : sourceMods);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallingKey(null);
      clearTaskProgress();
    }
  }

  async function uninstallSourceFileNames(fileNames: string[]) {
    if (fileNames.length === 0) return;
    setInstallingKey(`file-uninstall-${fileNames.join("|")}`);
    try {
      const result = await invoke<string>("uninstall_pak_mod_files", { fileNames, profileId });
      setStatus(result);
      window.dispatchEvent(new Event("tsuki-data-refresh"));
      await refreshSourceMatches(selectedMod ? [selectedMod] : sourceMods);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallingKey(null);
    }
  }

  async function setSourceFileNamesEnabled(fileNames: string[], enabled: boolean) {
    if (fileNames.length === 0) return;
    setInstallingKey(`file-toggle-${fileNames.join("|")}`);
    try {
      const result = await invoke<string>("set_pak_mod_files_enabled", { fileNames, enabled, profileId });
      setStatus(result);
      window.dispatchEvent(new Event("tsuki-data-refresh"));
      await refreshSourceMatches(selectedMod ? [selectedMod] : sourceMods);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallingKey(null);
    }
  }

  async function openSourceFileNamesLocation(match: InstalledSourceMatch, fileNames: string[]) {
    if (fileNames.length === 0) return;
    setInstallingKey(`file-location-${fileNames.join("|")}`);
    try {
      const result = await invoke<string>("open_installed_mod_file_location", {
        source: match.source,
        sourceId: match.sourceId,
        matchedFiles: fileNames,
        matchKind: match.matchKind,
        profileId,
      });
      setStatus(result);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallingKey(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;

    const target = pendingDelete;
    setPendingDelete(null);
    setInstallingKey(target.busyId);

    try {
      const [source, sourceId] = target.busyId.replace("-uninstall", "").split("-");
      const result = source && sourceId && target.fileNames.some((fileName) => fileName.includes(":\\"))
        ? await invoke<string>("uninstall_source_install", { source, sourceId, profileId })
        : await invoke<string>("uninstall_pak_mod_files", { fileNames: target.fileNames, profileId });

      setStatus(result);
      window.dispatchEvent(new Event("tsuki-data-refresh"));
      const refreshTarget = source && sourceId
        ? sourceMods.find((mod) => mod.source === source && mod.sourceId === sourceId)
        : null;
      await refreshSourceMatches(refreshTarget ? [refreshTarget] : sourceMods);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallingKey(null);
    }
  }

  async function openWebsite(pageUrl?: string | null) {
    if (!pageUrl) {
      setStatus("No website URL was loaded for this mod yet.");
      return;
    }

    try {
      const result = await invoke<string>("open_external_url", { url: pageUrl });
      setStatus(result);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  function openCustomBrowserUrl(rawValue?: string | null) {
    const normalized = normalizeBrowserUrl(rawValue);
    if (!normalized) {
      setStatus("Enter a valid website URL for Custom Browser.");
      return;
    }
    if (!browserUrlAllowed(normalized, customBrowserAllowedDomains)) {
      setStatus(`Blocked by this profile's allowed domains: ${customBrowserAllowedDomains.join(", ")}`);
      return;
    }
    setCustomBrowserInput(normalized);
    setCustomBrowserUrl(normalized);
    setCustomBrowserFrameKey((value) => value + 1);
    setCustomBrowserLoading(true);
    setStatus(`Loading ${normalized}`);
  }

  function reloadCustomBrowser() {
    if (!customBrowserUrl) {
      setStatus("No Custom Browser URL is configured.");
      return;
    }
    setCustomBrowserFrameKey((value) => value + 1);
    setCustomBrowserLoading(true);
    setStatus(`Reloading ${customBrowserUrl}`);
  }

  async function openCustomBrowserExternal() {
    await openWebsite(customBrowserUrl || customBrowserInput || customBrowserStartUrl);
  }

  function currentManagedBrowserBounds() {
    const rect = managedBrowserViewportRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = Math.max(0, rect.left);
    const y = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    const width = right - x;
    const height = bottom - y;
    if (width < 320 || height < 240) return null;
    return {
      x,
      y,
      width,
      height,
    };
  }

  async function prepareManagedBrowserBounds() {
    const element = managedBrowserViewportRef.current;
    if (!element || window.innerWidth < 480 || window.innerHeight < 360) {
      throw new Error("Restore or enlarge the Tsuki window before opening the embedded browser.");
    }
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    const bounds = currentManagedBrowserBounds();
    if (!bounds) {
      throw new Error("The embedded browser area is not visible. Scroll to Managed Browsing and try again.");
    }
    return bounds;
  }

  async function openCustomBrowserEmbeddedWindow() {
    const normalized = normalizeBrowserUrl(customBrowserUrl || customBrowserInput || customBrowserStartUrl);
    if (!normalized) {
      setStatus("No Custom Browser URL is configured.");
      return;
    }
    if (!browserUrlAllowed(normalized, customBrowserAllowedDomains)) {
      setStatus(`Blocked by this profile's allowed domains: ${customBrowserAllowedDomains.join(", ")}`);
      return;
    }

    setManagedBrowserOpening(true);
    try {
      const bounds = await prepareManagedBrowserBounds();
      const result = await invoke<string>("open_embedded_browser_window", {
        label: `${profileId}-${activeSource?.id ?? "custom"}`,
        url: normalized,
        title: customBrowserName,
        ...bounds,
      });
      setManagedBrowserOpen(true);
      setStatus(result);
    } catch (error) {
      setManagedBrowserOpen(false);
      setStatus(`Embedded browser failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setManagedBrowserOpening(false);
    }
  }

  async function openActiveSourceEmbeddedWindow() {
    if (activeSource?.browseMode === "external") {
      await openActiveSourceExternal();
      return;
    }
    if (activeTab === "custom") {
      await openCustomBrowserEmbeddedWindow();
      return;
    }

    const normalized = normalizeBrowserUrl(sourceStartUrlFor(activeTab));
    if (!normalized) {
      setStatus(`No ${sourceLabel(activeTab)} start URL is configured for this profile.`);
      return;
    }

    setManagedBrowserOpening(true);
    try {
      const bounds = await prepareManagedBrowserBounds();
      const result = await invoke<string>("open_embedded_browser_window", {
        label: `${profileId}-${activeSource?.id ?? activeTab}`,
        url: normalized,
        title: `${gameName} ${activeSource?.displayName ?? sourceLabel(activeTab)}`,
        ...bounds,
      });
      setManagedBrowserOpen(true);
      setStatus(result);
    } catch (error) {
      setManagedBrowserOpen(false);
      setStatus(`Embedded browser failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setManagedBrowserOpening(false);
    }
  }

  async function openActiveSourceExternal() {
    if (activeTab === "custom") {
      await openCustomBrowserExternal();
      return;
    }
    await openWebsite(sourceStartUrlFor(activeTab));
  }

  async function controlActiveBrowser(action: "back" | "forward" | "refresh" | "close") {
    if (!activeSource) return;
    try {
      const result = await invoke<string>("control_embedded_browser_window", {
        label: `${profileId}-${activeSource.id}`,
        action,
      });
      if (action === "close") setManagedBrowserOpen(false);
      setStatus(result);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadSourceIndexFallback(source: BrowseTab, reset: boolean, reason: string, requestedSort: SortMode = sortMode) {
    void reset;
    void requestedSort;
    recordCachePolicyDiagnostic({
      browseDataSource: "live-unavailable",
      detailDataSource: "unchanged",
      fileListDataSource: "unchanged",
      cacheFallbackReason: reason,
    });
    setHasMore((current) => ({ ...current, [source]: source === "nexus" }));
      setCacheNote(`${activeSource?.displayName ?? sourceLabel(source)} live request failed. No exact source/profile/game cache entry was used.`);
      setStatus(reason);
    setBrowseCardsLive(false);
    reportTaskProgress(`Load ${sourceLabel(source)}`, 100, "Live unavailable; cache fallback blocked by policy.");
  }



  async function loadModWorkshopLivePage(
    reset = false,
    requestedSort: SortMode = sortMode,
    targetPage?: number,
    options: { query?: string; categoryId?: string; categoryLabel?: string } = {},
  ) {
    if (profileSwitching) { setStatus("Switching profile..."); return; }
    if (!hasConfiguredSources) { setMods([]); setHasMore((current) => ({ ...current, modworkshop: false })); setStatus("No browse sources configured for this profile."); return; }
    if (loadingSource && loadingSource !== "modworkshop") return;
    if (!reset && !hasMore.modworkshop && !targetPage) return;

    const requestId = ++browseRequestSeqRef.current;
    const previousPage = Math.max(1, pages.modworkshop || 1);
    const nextPage = Math.max(1, targetPage ?? (reset ? 1 : pages.modworkshop + 1));
    const browseQuery = options.query ?? activeModWorkshopSearch;
    const browseCategoryId = options.categoryId ?? categoryId;
    const browseCategoryLabel = options.categoryLabel ?? categoryLabel;
    const replacePage = true;

    let watchdog: number | null = null;

    if (reset) {
      if (!browseQuery.trim()) setActiveModWorkshopSearch("");
      setModWorkshopSearchPage(0);
      if (!browseQuery.trim()) setSearchQuery("");
      setHasMore((current) => ({ ...current, modworkshop: true }));
      setCacheNote("ModWorkshop page mode: keeping current cards visible while loading page 1.");
      setBrowseCardsLive(false);
    }

    setPages((current) => ({ ...current, modworkshop: nextPage }));
    setLoadingSource("modworkshop");
    setStatus(`Loading ModWorkshop ${gameName} page ${nextPage}${browseCategoryLabel ? ` in ${browseCategoryLabel}` : ""}...`);
    reportTaskProgress("Load ModWorkshop", reset ? 8 : 38, `API page ${nextPage}`);

    watchdog = window.setTimeout(() => {
      if (requestId !== browseRequestSeqRef.current) return;

      setLoadingSource(null);
      clearTaskProgress();
      setStatus(`ModWorkshop page ${nextPage} took too long and was unlocked. Press Refresh or try the page again.`);
      setCacheNote(`Unlocked stuck ModWorkshop page ${nextPage} load after timeout.`);
    }, 36_000);

    try {
      const loaded = await invokeWithTimeout<SourceModSummary[]>(
        "fetch_modworkshop_browse_live_page",
        {
          page: nextPage,
          sort: requestedSort,
          query: browseQuery.trim() || null,
          categoryId: browseCategoryId.trim() || null,
          gameId: modWorkshopGameKey,
          profileId,
        },
        30_000,
        "ModWorkshop live API page timed out.",
      );

      if (requestId !== browseRequestSeqRef.current) return;

      const cleaned = cleanMods(loaded).filter((mod) => mod.source === "modworkshop").slice(0, BROWSE_PAGE_SIZE);

      if (cleaned.length === 0) {
        if (reset || nextPage <= 1) {
          setMods((current) => current.filter((mod) => mod.source !== "modworkshop"));
          setHasMore((current) => ({ ...current, modworkshop: false }));
          setBrowseCardsLive(true);
          setCacheNote("");
          setStatus(`No ModWorkshop mods match the selected ${gameName} version and filters.`);
          return;
        }

      setHasMore((current) => ({ ...current, modworkshop: false }));
        setCacheNote(`ModWorkshop live page ${nextPage} returned no cards. Source-index fallback was not used for live pagination.`);
        setStatus(`ModWorkshop page ${nextPage} returned no live ${gameName} cards. Stopped at the end of the live listing.`);
        setBrowseCardsLive(false);
        return;
      }

      setMods((current) => {
        const base = replacePage ? current.filter((mod) => mod.source !== "modworkshop") : current;
        writeCache(profileId, "modworkshop", sourceGameKeyFor("modworkshop"), requestedSort, cleaned, nextPage, cleaned.length >= BROWSE_PAGE_SIZE, browseQuery, browseCategoryId);
        return [...base, ...cleaned];
      });

      setHasMore((current) => ({ ...current, modworkshop: true }));
      setBrowseCardsLive(true);
      setCacheNote(`ModWorkshop page mode: loaded ${cleaned.length} cards from live source.`);
      setStatus(`Loaded ModWorkshop page ${nextPage}: ${cleaned.length} ${gameName} mod cards.`);
      recordCachePolicyDiagnostic({
        browseDataSource: "live",
        detailDataSource: "unchanged",
        fileListDataSource: "unchanged",
        cacheFallbackReason: "none",
      });
      reportTaskProgress("Load ModWorkshop", 100, `Page ${nextPage}: ${cleaned.length} cards.`);
    } catch (error) {
      if (requestId !== browseRequestSeqRef.current) return;
      const message = error instanceof Error ? error.message : String(error);

      if (reset || nextPage <= 1) {
        await loadSourceIndexFallback("modworkshop", reset, message, requestedSort);
        return;
      }

      setPages((current) => ({ ...current, modworkshop: previousPage }));
      setHasMore((current) => ({ ...current, modworkshop: true }));
      setBrowseCardsLive(false);
      setCacheNote(`ModWorkshop live page ${nextPage} failed. Kept current live cards and skipped source-index fallback for page mode.`);
      setStatus(`ModWorkshop page ${nextPage} failed: ${message}`);
    } finally {
      if (watchdog !== null) window.clearTimeout(watchdog);
      if (requestId === browseRequestSeqRef.current) setLoadingSource(null);
      clearTaskProgress();
    }
  }

  async function loadPage(source: BrowseTab = activeTab, reset = false, requestedSort: SortMode = sortMode, targetPage?: number) {
    if (profileSwitching) { setStatus("Switching profile..."); return; }
    if (!hasConfiguredSources) { setMods([]); setHasMore(browsePageBooleans({ modworkshop: false, nexus: false, custom: false })); setStatus("No browse sources configured for this profile."); return; }
    if (source === "modworkshop") {
      await loadModWorkshopLivePage(reset, requestedSort, targetPage);
      return;
    }
    if (source === "custom" || source === "github") {
      setHasMore((current) => ({ ...current, [source]: false }));
      setStatus(source === "custom" ? "Custom Browser is ready." : "GitHub browse cards are not enabled for this profile yet.");
      return;
    }

    // After the early ModWorkshop return, this generic loader is Nexus-only.
    // Keeping old source === "modworkshop" checks here made TypeScript narrow
    // source to "nexus" and reject those dead branches during release build.
    if (source === "nexus" && nexusApiKeyMissing) {
      setStatus("Nexus browsing needs an API key. Add one in Settings > API Keys.");
      setHasMore((current) => ({ ...current, nexus: false }));
      return;
    }

    if (loadingSource && loadingSource !== source) return;
    if (!reset && !hasMore[source] && !targetPage) return;

    if (activeNexusSearch.trim() && !reset) {
      setHasMore((current) => ({ ...current, nexus: false }));
      setStatus("Nexus search results are loaded as one ranked set. Clear search or press Refresh for normal browsing.");
      return;
    }

    if (reset) {
      setActiveNexusSearch("");
    }

    const requestId = ++browseRequestSeqRef.current;
    const nextPage = Math.max(1, targetPage ?? (reset ? 1 : pages[source] + 1));
    setLoadingSource(source);
    if (reset) {
      // Keep current cards visible until live/fallback cards are ready.
      setCacheNote("");
      setBrowseCardsLive(false);
    }
    reportTaskProgress(`Load ${sourceLabel(source)}`, reset ? 8 : 34, `Page ${nextPage}`);
    setStatus(`Loading live Nexus page ${nextPage} through GraphQL first...`);

    try {
      const result = await invokeWithTimeout<{ mods: SourceModSummary[]; page: number; hasMore: boolean; totalCount: number | null }>(
        "fetch_nexus_browse_page",
        { page: nextPage, sort: requestedSort, profileId, sourceId: activeSourceId },
        20000,
        `${sourceLabel(source)} live request timed out.`,
      );

      if (requestId !== browseRequestSeqRef.current) return;

      const cleaned = sortBrowseMods(cleanMods(result.mods).filter((mod) => mod.source === source), requestedSort);
      const visiblePage = cleaned.slice(0, BROWSE_PAGE_SIZE);

      setMods((current) => {
        const base = current.filter((mod) => mod.source !== source);
        const merged = cleanMods([...base, ...visiblePage]);
        writeCache(profileId, source, sourceGameKeyFor(source), requestedSort, visiblePage, nextPage, result.hasMore);
        return merged;
      });

      setPages((current) => ({ ...current, [source]: nextPage }));
      setHasMore((current) => ({ ...current, [source]: result.hasMore }));
      setBrowseCardsLive(true);
      setCacheNote("");
      setStatus(visiblePage.length ? `Loaded ${visiblePage.length} live ${sourceLabel(source)} mods on page ${nextPage}.` : `No visible Nexus mods on page ${nextPage}.${result.hasMore ? " More pages are available." : " End of results."}`);
      recordCachePolicyDiagnostic({
        browseDataSource: "live",
        detailDataSource: "unchanged",
        fileListDataSource: "unchanged",
        cacheFallbackReason: "none",
      });
      reportTaskProgress(`Load ${sourceLabel(source)}`, 100, `Loaded ${visiblePage.length} live cards.`);
    } catch (error) {
      if (requestId !== browseRequestSeqRef.current) return;
      const message = error instanceof Error ? error.message : String(error);

      await loadSourceIndexFallback(source, reset, message, requestedSort);
    } finally {
      if (requestId === browseRequestSeqRef.current) {
        setLoadingSource(null);
        window.setTimeout(clearTaskProgress, 850);
      }
    }
  }

  function scrollBrowseToTop() {
    document.querySelector(".page-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
  }

  function switchBrowseSource(nextSource: BrowseTab, sourceId?: string) {
    browseRequestSeqRef.current += 1;
    setLoadingSource(null);
    clearTaskProgress();
    const selected = sourceId ? configuredSources.find((source) => source.id === sourceId) ?? null : null;
    if (activeSource?.browseMode === "webview_window" && activeSource.id !== sourceId) {
      void invoke<string>("control_embedded_browser_window", {
        label: `${profileId}-${activeSource.id}`,
        action: "close",
      }).catch(() => undefined);
    }
    if (selected) setActiveSourceId(selected.id);
    const selectedTab = selected ? sourceTabFor(selected) : nextSource;
    const nextSort = normalizeSortMode(sortMode, selectedTab);
    setActiveTab(selectedTab);
    setSortMode(nextSort);
    setSourceSearchQuery(selectedTab === "custom" ? normalizeBrowserUrl(selected?.startUrl || selected?.listingUrl || selected?.gamePageUrl || "") : "");
    setSearchQuery("");
    setActiveModWorkshopSearch("");
    setActiveNexusSearch("");
    setPages((current) => ({ ...current, [selectedTab]: 0 }));
    setHasMore((current) => ({ ...current, [selectedTab]: selectedTab !== "custom" }));

    if (selectedTab === "nexus") {
      setCategoryId("");
      setCategoryLabel("");
    }
    if (selectedTab === "custom") {
      const nextUrl = normalizeBrowserUrl(selected?.startUrl || selected?.listingUrl || selected?.gamePageUrl || "");
      setStatus(nextUrl ? `${selected?.displayName ?? "Browser"} is ready.` : "No browser start URL is configured for this source.");
    }
  }

  function goToBrowsePage(targetPage: number) {
    const page = Math.max(1, targetPage);

    if (activeTab === "custom") {
      reloadCustomBrowser();
      return;
    }

    if (activeTab === "modworkshop") {
      if (activeModWorkshopSearch.trim()) {
        void searchModWorkshopPage(activeModWorkshopSearch, page, false);
      } else {
        void loadModWorkshopLivePage(false, sortMode, page);
      }
      return;
    }

    if (activeNexusSearch.trim()) {
      void searchNexusPage(page);
      return;
    }

    void loadPage(activeTab, false, sortMode, page);
  }

  function handleSortChange(nextSort: SortMode) {
    if (activeTab === "custom") return;
    setSortMode(nextSort);
    setCacheNote(`Reloading ${sourceLabel(activeTab)} page 1 by ${nextSort}.`);
    setPages((current) => ({ ...current, [activeTab]: 0 }));
    setHasMore((current) => ({ ...current, [activeTab]: true }));
    browseRequestSeqRef.current += 1;

    if (activeTab === "modworkshop") {
      setModWorkshopSearchPage(0);
      if (activeModWorkshopSearch.trim()) {
        void searchModWorkshopPage(activeModWorkshopSearch, 1, true, nextSort);
      } else {
        void loadModWorkshopLivePage(true, nextSort, 1);
      }
      return;
    }

    if (activeNexusSearch.trim()) {
      void searchNexusPage(1, nextSort);
    } else {
      void loadPage(activeTab, true, nextSort, 1);
    }
  }

  function handleCategoryChange(nextCategoryId: string) {
    const selected = modWorkshopCategories.find((category) => category.id === nextCategoryId);
    const nextLabel = selected?.label ?? "";
    setCategoryId(nextCategoryId);
    setCategoryLabel(nextLabel);
    setPages((current) => ({ ...current, modworkshop: 0 }));
    setHasMore((current) => ({ ...current, modworkshop: true }));
    browseRequestSeqRef.current += 1;

    if (activeModWorkshopSearch.trim()) {
      void searchModWorkshopPage(activeModWorkshopSearch, 1, true, sortMode, nextCategoryId, nextLabel);
    } else {
      void loadModWorkshopLivePage(true, sortMode, 1, { categoryId: nextCategoryId, categoryLabel: nextLabel });
    }
  }

  async function testModWorkshopLive() {
    setLoadingSource("modworkshop");
    setStatus("Testing ModWorkshop public live/API routes...");
    setCacheNote("Running ModWorkshop live diagnostic...");
    try {
      const result = await invoke<string>("diagnose_modworkshop_browse_live", { profileId });
      setStatus(result);
      setCacheNote(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`ModWorkshop live diagnostic failed: ${message}`);
      setCacheNote(message);
    } finally {
      setLoadingSource(null);
    }
  }

  void testModWorkshopLive;

  function retryModWorkshopCategories() {
    setCategoryStatus(modWorkshopCategories.length > 0 ? "cached" : "loading");
    setCategoryError(null);
    setCategoryRetryTick((value) => value + 1);
  }

  function refresh() {
    try {
      // Keep the visible/cache cards as a safety net while live requests reload.
      // Clearing the cache first made both sources go blank when a route returned zero.
    } catch {
      // optional cache
    }
    if (activeTab === "modworkshop") {
      setCategoriesLoading(false);
      setCategoryRetryTick((value) => value + 1);
    }

    if (activeTab === "nexus") {
      setActiveNexusSearch("");
    }
    if (activeTab === "custom") {
      reloadCustomBrowser();
      return;
    }
    setPages((current) => ({ ...current, [activeTab]: 0 }));
    setHasMore((current) => ({ ...current, [activeTab]: true }));
    // Do not wipe visible cards before the replacement data arrives.
    setCacheNote(activeTab === "modworkshop" ? "Reloading ModWorkshop cards while keeping the current library visible..." : "Reloading cards while keeping the current library visible...");
    if (activeTab === "modworkshop") {
      reportTaskProgress("Refresh ModWorkshop", 5, "Loading ModWorkshop API page without blanking the current view...");
      const activeQuery = activeModWorkshopSearch.trim();
      if (activeQuery) {
        void searchModWorkshopPage(activeQuery, 1, true, sortMode, categoryId, categoryLabel);
      } else {
        void loadModWorkshopLivePage(true, sortMode, 1, { categoryId, categoryLabel });
      }
      return;
    }

    browseRequestSeqRef.current += 1;
    reportTaskProgress(`Refresh ${sourceLabel(activeTab)}`, 5, "Loading live/fallback cards without blanking the current view...");
    void loadPage(activeTab, true, sortMode, 1);
  }

  async function applyFastModWorkshopSearchResults(query: string, page: number, reset: boolean) {
    void reset;
      const cacheKey = `${profileId}::${activeSourceId}::${modWorkshopGameKey}::${query.toLowerCase()}::${page}::${sortMode}::${categoryId}`;
    const cached = modWorkshopSearchCacheRef.current.get(cacheKey);
    const localMatches = cached ?? orderBrowseModsForSource(mods, "modworkshop", sortMode)
      .filter((mod) => modMatchesQuery(mod, query));
    const cleaned = sortBrowseMods(cleanMods(localMatches).filter((mod) => mod.source === "modworkshop"), sortMode).slice(0, BROWSE_PAGE_SIZE);

    if (cleaned.length === 0) return false;

    setMods((current) => {
      const existing = current.filter((mod) => mod.source !== "modworkshop");
      const merged = sortBrowseMods(cleanMods([...existing, ...cleaned]), sortMode);
      writeCache(profileId, "modworkshop", sourceGameKeyFor("modworkshop"), sortMode, merged.filter((mod) => mod.source === "modworkshop"), page, false, query, categoryId);
      return merged;
    });

    setActiveModWorkshopSearch(query);
    setModWorkshopSearchPage(page);
    setPages((current) => ({ ...current, modworkshop: page }));
    setHasMore((current) => ({ ...current, modworkshop: false }));
    setStatus(`Found ${cleaned.length} cached/current ModWorkshop result(s) for "${query}".`);
    setCacheNote("ModWorkshop search rendered already-loaded cards first while live results load only when needed.");
    return true;
  }

  async function clearActiveSourceSearch() {
    setSourceSearchQuery("");
    setSearchQuery("");
    setActiveModWorkshopSearch("");
    setActiveNexusSearch("");
    setPages((current) => ({ ...current, [activeTab]: 0 }));
    setHasMore((current) => ({ ...current, [activeTab]: true }));
    setCacheNote(`Cleared search and filters for ${sourceLabel(activeTab)}.`);

    if (activeTab === "custom") {
      setHasMore((current) => ({ ...current, custom: false }));
      openCustomBrowserUrl(customBrowserStartUrl);
      return;
    }

    if (activeTab === "modworkshop") {
      setCategoryId("");
      setCategoryLabel("");
      setStatus("Cleared ModWorkshop search. Loading live public listing page 1.");
      void loadModWorkshopLivePage(true, sortMode, 1, { categoryId: "", categoryLabel: "", query: "" });
      return;
    }

    setStatus("Cleared Nexus search. Reloading normal Nexus browse cards.");
    await loadPage("nexus", true, sortMode, 1);
  }


  async function searchModWorkshopPage(
    query: string,
    page: number,
    reset: boolean,
    requestedSort: SortMode = sortMode,
    requestedCategoryId: string = categoryId,
    requestedCategoryLabel: string = categoryLabel,
  ) {
    const cleanQuery = query.trim();
    if (cleanQuery.length < 2) {
      await clearActiveSourceSearch();
      return;
    }

    const searchSort = requestedSort === DEFAULT_SORT ? "best_match" : requestedSort;
    setActiveTab("modworkshop");
    setSortMode(searchSort);
    setSearchQuery(cleanQuery);
    setSourceSearching(true);
    setLoadingSource("modworkshop");
    setStatus(`Searching ModWorkshop for "${cleanQuery}"...`);

    try {
      await applyFastModWorkshopSearchResults(cleanQuery, page, reset);

      setStatus(`Searching ModWorkshop live API for "${cleanQuery}"...`);
      const cacheKey = `${profileId}::${activeSourceId}::${cleanQuery.toLowerCase()}::${page}::${searchSort}::${requestedCategoryId}`;
      const cached = modWorkshopSearchCacheRef.current.get(cacheKey);
      const results = cached ?? await invokeWithTimeout<SourceModSummary[]>(
        "fetch_modworkshop_browse_live_page",
        {
          page,
          sort: searchSort,
          query: cleanQuery,
          categoryId: requestedCategoryId.trim() || null,
          gameId: modWorkshopGameKey,
          profileId,
        },
        16_000,
        "ModWorkshop search timed out.",
      ).catch(() => invokeWithTimeout<SourceModSummary[]>(
        "search_modworkshop_mods_for_query",
        { query: cleanQuery, page, profileId, gameId: modWorkshopGameKey, categoryId: requestedCategoryId.trim() || null },
        16_000,
        "ModWorkshop search fallback timed out.",
      ));
      if (!cached && results.length > 0) {
        modWorkshopSearchCacheRef.current.set(cacheKey, results);
      }
      let cleaned = cleanMods(results).filter((mod) => mod.source === "modworkshop");

      if (cleaned.length === 0) {
        const fallbackHits: SourceModSummary[] = [];
        for (let browsePage = 1; browsePage <= 2 && fallbackHits.length < BROWSE_PAGE_SIZE; browsePage += 1) {
          const pageMods = await invoke<SourceModSummary[]>("fetch_modworkshop_browse_live_page", {
            page: browsePage,
            sort: searchSort,
            query: cleanQuery,
            categoryId: requestedCategoryId.trim() || null,
            gameId: modWorkshopGameKey,
            profileId,
          }).catch(() => []);
          for (const mod of pageMods) {
            if (modMatchesQuery(mod, cleanQuery) && !fallbackHits.some((existing) => existing.sourceId === mod.sourceId)) {
              fallbackHits.push(mod);
            }
          }
        }

        cleaned = cleanMods(fallbackHits).filter((mod) => mod.source === "modworkshop").slice(0, BROWSE_PAGE_SIZE);
      }

      cleaned = cleaned.slice(0, BROWSE_PAGE_SIZE);

      setMods((current) => {
        // Do not blank the library on zero-result live searches.
        const existing = current.filter((mod) => mod.source !== "modworkshop");
        const merged = cleanMods([...existing, ...cleaned]);
        writeCache(profileId, "modworkshop", sourceGameKeyFor("modworkshop"), searchSort, cleaned, page, cleaned.length > 0, cleanQuery, requestedCategoryId);
        return merged;
      });

      setActiveModWorkshopSearch(cleanQuery);
      setCategoryId(requestedCategoryId);
      setCategoryLabel(requestedCategoryLabel);
      setModWorkshopSearchPage(page);
      setPages((current) => ({ ...current, modworkshop: page }));
      setHasMore((current) => ({ ...current, modworkshop: cleaned.length >= BROWSE_PAGE_SIZE }));
      setStatus(
        cleaned.length > 0
          ? `${reset ? "Found" : "Loaded"} ${cleaned.length} ModWorkshop live result(s) for "${cleanQuery}" page ${page}.`
          : `No ModWorkshop live results for "${cleanQuery}".`
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSourceSearching(false);
      setLoadingSource(null);
    }
  }

  async function searchModWorkshop() {
    const query = sourceSearchQuery.trim();
    await searchModWorkshopPage(query, 1, true);
  }

  async function searchNexusPage(page = 1, requestedSort: SortMode = sortMode) {
    const query = (page <= 1 ? sourceSearchQuery : activeNexusSearch || sourceSearchQuery).trim();

    if (nexusApiKeyMissing) {
      setStatus("Nexus search needs an API key. Add one in Settings > API Keys.");
      return;
    }

    if (query.length < 2) {
      setSearchQuery("");
      setActiveNexusSearch("");
      setStatus("Cleared Nexus search. Loading normal Nexus browse page.");
      await loadPage("nexus", true, requestedSort, 1);
      return;
    }

    setActiveTab("nexus");
    setSortMode(requestedSort);
    setSearchQuery(query);
    setSourceSearching(true);
    setLoadingSource("nexus");
    reportTaskProgress("Nexus search", 15, query);
    setStatus(`Searching Nexus for "${query}" page ${page}...`);

    try {
      const cacheKey = `${profileId}::${activeSourceId}::${nexusGameKey}::${activeSource?.providerGameId ?? ""}::${query.toLowerCase()}::${requestedSort}`;
      const cached = nexusSearchCacheRef.current.get(cacheKey);
      const results: SourceModSummary[] = cached ?? (await invokeWithTimeout<SourceModSummary[]>(
        "search_nexus_mods_for_query",
        { query, profileId, sourceId: activeSourceId },
        10000,
        "Nexus search timed out.",
      ).catch(() => invoke<SourceModSummary[]>("list_source_index", { source: "nexus", limit: 1200, profileId })
        .then((mods) => mods.filter((mod) => modMatchesQuery(mod, query)))));
      const cleaned = cached ?? sortBrowseMods(cleanMods(results).filter((mod) => mod.source === "nexus"), requestedSort);
      if (!cached) nexusSearchCacheRef.current.set(cacheKey, cleaned);
      const safePage = Math.max(1, page);
      const start = (safePage - 1) * BROWSE_PAGE_SIZE;
      const visiblePage = cleaned.slice(start, start + BROWSE_PAGE_SIZE);
      reportTaskProgress("Nexus search", 78, `Showing ${visiblePage.length} of ${cleaned.length} result(s).`);

      setMods((current) => {
        const existing = current.filter((mod) => mod.source !== "nexus");
        const merged = cleanMods([...existing, ...visiblePage]);
        writeCache(profileId, "nexus", sourceGameKeyFor("nexus"), requestedSort, visiblePage, safePage, start + BROWSE_PAGE_SIZE < cleaned.length, query);
        return merged;
      });

      setActiveNexusSearch(query);
      setPages((current) => ({ ...current, nexus: safePage }));
      setHasMore((current) => ({ ...current, nexus: start + BROWSE_PAGE_SIZE < cleaned.length }));
      setStatus(
        visiblePage.length > 0
          ? `Found ${cleaned.length} Nexus result(s) for "${query}". Showing page ${safePage}.`
          : `No Nexus search results for "${query}" on page ${safePage}. Try fewer words, then Rebuild Nexus if it is still missing.`
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSourceSearching(false);
      setLoadingSource(null);
      clearTaskProgress();
    }
  }

  async function searchNexus() {
    await searchNexusPage(1);
  }

  function searchActiveSource() {
    if (activeTab === "custom") {
      openCustomBrowserUrl(sourceSearchQuery || customBrowserInput);
      return;
    }
    if (activeTab === "nexus") void searchNexus();
    else void searchModWorkshop();
  }

  async function fetchDetailForMod(mod: SourceModSummary) {
    const detail =
      mod.source === "nexus"
        ? await invokeWithTimeout<SourceModDetail>("fetch_nexus_mod_detail", { modId: mod.sourceId, profileId, gameDomain: mod.gameId ?? nexusGameDomain }, 45000, "Nexus file lookup timed out. Retry to refresh the file list.")
        : await invokeWithTimeout<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: mod.sourceId, profileId }, 35000, "ModWorkshop file lookup timed out. Retry to refresh the file list.");

    const safe = safeDetail(detail, "live");
    rememberSourceAuthor(safe);
    writeDetailCache(safe);
    return safe;
  }

  async function openMod(mod: SourceModSummary) {
    const loadingKey = `${mod.source}-${mod.sourceId}`;

    setSelectedMod(fallbackDetail(mod));
    setView("detail");
    reportTaskProgress("Open mod page", 15, mod.name);
    setDetailLoadingKey(loadingKey);
    setStatus(`Opening ${mod.name}. Loading cached and live source data...`);
    recordCachePolicyDiagnostic({
      browseDataSource: "unchanged",
      detailDataSource: "fallback-placeholder",
      fileListDataSource: "unavailable",
      cacheFallbackReason: "basic placeholder while cached/live detail loads",
    });

    window.setTimeout(() => {
      const cached = readDetailCache(mod);
      if (!cached) return;

      setSelectedMod((current) => {
        if (!current || `${current.source}-${current.sourceId}` !== loadingKey || current.dataSource === "live") return current;
        return cached;
      });
      recordCachePolicyDiagnostic({
        browseDataSource: "unchanged",
        detailDataSource: "cache-placeholder",
        fileListDataSource: "unavailable",
        cacheFallbackReason: "temporary cached detail metadata while live detail loads",
      });
    }, 0);

    try {
      reportTaskProgress("Open mod page", 55, "Loading source details...");
      void refreshSourceMatches([mod]);
      const detail =
        mod.source === "nexus"
          ? await invokeWithTimeout<SourceModDetail>("fetch_nexus_mod_detail", { modId: mod.sourceId, profileId, gameDomain: mod.gameId ?? nexusGameDomain }, 45000, "Nexus detail timed out. Retry to refresh files.")
          : await invokeWithTimeout<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: mod.sourceId, profileId }, 35000, "ModWorkshop detail timed out. Retry to refresh files.");

      const safe = safeDetail(detail, "live");
      rememberSourceAuthor(safe);
      writeDetailCache(safe);
      setSelectedMod(safe);
      recordCachePolicyDiagnostic({
        browseDataSource: "unchanged",
        detailDataSource: "live",
        fileListDataSource: "live",
        cacheFallbackReason: "none",
      });
      setMods((current) => current.map((item) => `${item.source}-${item.sourceId}` === `${safe.source}-${safe.sourceId}` ? {
        ...item,
        name: displayModTitle(safe) || item.name,
        author: displayAuthor(safe) ?? item.author,
        authorUsername: safe.authorUsername ?? item.authorUsername ?? null,
        authorUserId: safe.authorUserId ?? item.authorUserId ?? null,
        authorProfileUrl: safe.authorProfileUrl ?? item.authorProfileUrl ?? null,
        authorAvatarUrl: safe.authorAvatarUrl ?? item.authorAvatarUrl ?? null,
        shortDescription: null,
        tags: Array.from(new Set([...(item.tags ?? []), ...(safe.tags ?? [])].filter(Boolean))).slice(0, 12),
        thumbnailUrl: safe.thumbnailUrl ?? item.thumbnailUrl,
        bannerUrl: safe.bannerUrl ?? item.bannerUrl,
        updatedAt: item.updatedAt ?? safe.updatedAt,
        downloads: item.downloads ?? safe.downloads,
        likes: item.likes ?? safe.likes,
      } : item));
      reportTaskProgress("Open mod page", 100, safe.name);
      setStatus(`Opened ${safe.name}. ${safe.source === "nexus" ? "Files loaded through Nexus REST fallback." : ""}`.trim());
    } catch (error) {
      recordCachePolicyDiagnostic({
        browseDataSource: "unchanged",
        detailDataSource: "live-unavailable",
        fileListDataSource: "unavailable",
        cacheFallbackReason: error instanceof Error ? error.message : String(error),
      });
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailLoadingKey(null);
      window.setTimeout(clearTaskProgress, 450);
    }
  }

  async function refreshSelectedDetail() {
    const current = selectedMod;
    if (!current) return;

    const loadingKey = `${current.source}-${current.sourceId}`;
    setDetailLoadingKey(loadingKey);
    setStatus(`Refreshing details for ${current.name}...`);

    try {
      const detail =
        current.source === "nexus"
          ? await invoke<SourceModDetail>("fetch_nexus_mod_detail", { modId: current.sourceId, profileId, gameDomain: current.gameId ?? nexusGameDomain })
          : await invoke<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: current.sourceId, profileId });

      const safe = safeDetail(detail, "live");
      rememberSourceAuthor(safe);
      writeDetailCache(safe);
      setSelectedMod(safe);
      recordCachePolicyDiagnostic({
        browseDataSource: "unchanged",
        detailDataSource: "live",
        fileListDataSource: "live",
        cacheFallbackReason: "none",
      });
      setMods((current) => current.map((item) => `${item.source}-${item.sourceId}` === `${safe.source}-${safe.sourceId}` ? {
        ...item,
        name: displayModTitle(safe) || item.name,
        author: displayAuthor(safe) ?? item.author,
        authorUsername: safe.authorUsername ?? item.authorUsername ?? null,
        authorUserId: safe.authorUserId ?? item.authorUserId ?? null,
        authorProfileUrl: safe.authorProfileUrl ?? item.authorProfileUrl ?? null,
        authorAvatarUrl: safe.authorAvatarUrl ?? item.authorAvatarUrl ?? null,
        shortDescription: null,
        tags: Array.from(new Set([...(item.tags ?? []), ...(safe.tags ?? [])].filter(Boolean))).slice(0, 12),
        thumbnailUrl: safe.thumbnailUrl ?? item.thumbnailUrl,
        bannerUrl: safe.bannerUrl ?? item.bannerUrl,
        updatedAt: item.updatedAt ?? safe.updatedAt,
        downloads: item.downloads ?? safe.downloads,
        likes: item.likes ?? safe.likes,
      } : item));
      setInstallPickerMod((picker) => picker && picker.source === safe.source && picker.sourceId === safe.sourceId ? safe : picker);
      setStatus(`Refreshed details and file list for ${safe.name}. ${safe.source === "nexus" ? "Files loaded through Nexus REST fallback." : ""}`.trim());
    } catch (error) {
      recordCachePolicyDiagnostic({
        browseDataSource: "unchanged",
        detailDataSource: "live-unavailable",
        fileListDataSource: "unavailable",
        cacheFallbackReason: error instanceof Error ? error.message : String(error),
      });
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailLoadingKey(null);
      window.setTimeout(clearTaskProgress, 450);
    }
  }


  async function stageFile(mod: SourceModDetail, file: SourceModFile, replaceFileNames: string[] = []) {
    if (!downloadsEnabled) {
      setStatus(downloadsBlockedMessage);
      return;
    }
    if (!hasLiveFileData(mod)) {
      setStatus(liveFileDataUnavailableMessage());
      return;
    }

    if (mod.source === "modworkshop" && isGenericModWorkshopPlaceholder(file) && !fileHasRouteHint(file)) {
      setStatus(`Blocked ${file.name}. It is a generic ModWorkshop placeholder, not a safe named mod file.`);
      return;
    }

    const key = fileKey(mod, file);
    setInstallingKey(key);
    reportTaskProgress("Download mod", 12, `${mod.name} / ${file.name}`);

    try {
      const result = await invoke<StagedDownloadResult>("stage_source_file_download", {
        source: mod.source,
        modId: mod.sourceId,
        fileId: file.id,
        fileName: file.name,
        downloadUrl: file.downloadUrl ?? null,
        modName: mod.name,
        description: mod.description,
        gameDomain: mod.source === "nexus" ? nexusGameDomain : null,
        profileId,
      });

      setResults((current) => [result, ...current].slice(0, 10));
      reportTaskProgress("Download mod", 52, `Downloaded ${file.name}`);

      if (!result.canInstallLater) {
        setStatus(`Downloaded ${file.name}, but install is blocked for review.`);
        reportTaskProgress("Download complete", 100, "Package needs manual or external-manager installation.");
        return;
      }

      setStatus(`Installing ${file.name} into ${currentGameProfile.displayName} paths...`);
      reportTaskProgress("Install mod", 76, `Installing ${file.name}`);

      const applied = await invoke<InstallApplyResult>("install_staged_file_to_game", {
        stagedFilePath: result.stagedFilePath,
        modName: mod.name,
        source: mod.source,
        modId: mod.sourceId,
        fileId: file.id,
        version: file.version ?? mod.version ?? null,
        sourceFileName: file.name,
        sourceFileCategory: sourceFileKind(file, groupedSourceFiles(mod.files, mod.source).main[0] ?? null, mod.source),
        sourceFileUploadedAt: file.uploadedAt ?? null,
        sourceFileVersion: file.version ?? mod.version ?? null,
        author: mod.author ?? null,
        thumbnailUrl: mod.thumbnailUrl ?? null,
        bannerUrl: mod.bannerUrl ?? null,
        pageUrl: mod.pageUrl ?? null,
        description: mod.description,
        replaceFileNames,
        profileId,
      });

      setStatus(`Installed ${applied.installedFiles.length} file(s) for ${mod.name}${applied.replacedFiles.length ? ` and replaced ${applied.replacedFiles.length} old file(s)` : ""}.`);
      reportTaskProgress("Install mod", 100, `Installed ${applied.installedFiles.length} file(s).`);
      window.dispatchEvent(new Event("tsuki-data-refresh"));
      await refreshSourceMatches([mod]);
    } catch (error) {
      reportTaskProgress("Install failed", 100, error instanceof Error ? error.message : String(error));
      setResults((current) => [
        {
          modName: mod.name,
          fileName: file.name,
          stagedFilePath: "",
          stagedFolderPath: "",
          sizeBytes: 0,
          archiveKind: "download-failed",
          entries: [],
          warnings: [error instanceof Error ? error.message : String(error)],
          canInstallLater: false,
        },
        ...current,
      ].slice(0, 10));
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallingKey(null);
      window.setTimeout(clearTaskProgress, 900);
    }
  }

  async function updateInstalledSource(mod: SourceModSummary, match: InstalledSourceMatch) {
    if (!downloadsEnabled) {
      setStatus(downloadsBlockedMessage);
      return;
    }
    setResults([]);
    setStatus(`Loading update file for ${mod.name}...`);

    try {
      const detail = await fetchDetailForMod(mod);
      if (!hasLiveFileData(detail)) {
        setStatus(liveFileDataUnavailableMessage());
        return;
      }
      const files = installableFiles(detail.files, detail.source);

      if (files.length === 0) {
        setStatus("No installable update files were exposed by this source.");
        return;
      }

      if (files.length > 1) {
        setInstallPickerReplacementFiles(match.matchedFiles);
        setSelectedFileIds(defaultSelectedFileIds(files, detail.source));
        setInstallPickerMod({ ...detail, files });
        setStatus(`Choose the update file for ${detail.name}. Latest main file is selected.`);
      } else {
        await stageFile(detail, files[0], match.matchedFiles);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function openInstall(mod: SourceModSummary) {
    setInstallPickerReplacementFiles([]);
    if (!downloadsEnabled) {
      setStatus(downloadsBlockedMessage);
      return;
    }
    setResults([]);
    setStatus(`Loading files for ${mod.name}...`);

    try {
      const safeDetail = await fetchDetailForMod(mod);
      if (!hasLiveFileData(safeDetail)) {
        setSelectedMod(safeDetail);
        setView("detail");
        setStatus(liveFileDataUnavailableMessage());
        return;
      }

      const files = installableFiles(safeDetail.files, safeDetail.source);

      if (files.length === 0) {
        setSelectedMod(safeDetail);
        setView("detail");
        setStatus("No installable download files were exposed. Opened the mod page so you can check the source manually.");
        return;
      }

      if (files.length === 1) {
        await stageFile(safeDetail, files[0]);
        return;
      }

      setInstallPickerMod({ ...safeDetail, files });
      setSelectedFileIds(defaultSelectedFileIds(files, safeDetail.source));
      setStatus(`Choose files for ${safeDetail.name}. Latest main file is selected by default.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function installSelected() {
    if (!installPickerMod) return;
    if (!downloadsEnabled) {
      setStatus(downloadsBlockedMessage);
      return;
    }
    if (!hasLiveFileData(installPickerMod)) {
      setStatus(liveFileDataUnavailableMessage());
      setInstallPickerMod(null);
      return;
    }
    const match = sourceMatches[`${installPickerMod.source}-${installPickerMod.sourceId}`] ?? null;
    const files = installableFiles(installPickerMod.files, installPickerMod.source)
      .filter((file) => selectedFileIds.includes(file.id))
      .filter((file) => matchedFileNamesForSourceFile(file, match).length === 0);
    for (const file of files) await stageFile(installPickerMod, file, installPickerReplacementFiles);
  }

  useEffect(() => {
    if (!initialMod) return;

    setActiveTab(initialMod.source);
    setMods((current) => cleanMods([...current, initialMod]));
    void openMod(initialMod);
    onInitialModConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMod?.source, initialMod?.sourceId]);

  useEffect(() => {
    if (sourceSearching || activeModWorkshopSearch || activeNexusSearch) return;
    if (sourceMatchRefreshTimerRef.current !== null) window.clearTimeout(sourceMatchRefreshTimerRef.current);
    sourceMatchRefreshTimerRef.current = window.setTimeout(() => {
      sourceMatchRefreshTimerRef.current = null;
      void refreshSourceMatches(sourceMods);
    }, 350);
    return () => {
      if (sourceMatchRefreshTimerRef.current !== null) {
        window.clearTimeout(sourceMatchRefreshTimerRef.current);
        sourceMatchRefreshTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, sourceModsSignature, sourceSearching, activeModWorkshopSearch, activeNexusSearch]);

  useEffect(() => {
    if (restoredSessionRef.current) {
      restoredSessionRef.current = false;
      return;
    }

    if ((activeTab === "modworkshop" && activeModWorkshopSearch.trim()) || (activeTab === "nexus" && activeNexusSearch.trim())) {
      return;
    }

    const cached = readCache(profileId, activeTab, sourceGameKeyFor(activeTab), sortMode, 1, "", activeTab === "modworkshop" ? categoryId : "");

    setPages((current) => ({ ...current, [activeTab]: 0 }));
    setHasMore((current) => ({ ...current, [activeTab]: true }));

    if (cached && cached.mods.length > 0) {
      setMods((current) => cleanMods([
        ...current.filter((mod) => mod.source !== activeTab),
        ...cached.mods,
      ]));
      setCacheNote(`Showing ${cached.mods.length} cached ${sourceLabel(activeTab)} cards while live refresh runs.`);
      setStatus(`Showing ${cached.mods.length} cached ${sourceLabel(activeTab)} placeholder card(s); live results will replace page order and membership.`);
      setBrowseCardsLive(false);
      recordCachePolicyDiagnostic({
        browseDataSource: "cache-placeholder",
        detailDataSource: "unchanged",
        fileListDataSource: "unchanged",
        cacheFallbackReason: "temporary browse placeholders while live page loads",
      });
    } else {
      setMods((current) => current.filter((mod) => mod.source !== activeTab));
      setCacheNote("");
      setStatus(`Loading live ${sourceLabel(activeTab)} results...`);
      setBrowseCardsLive(false);
    }

    if (activeTab === "modworkshop") void loadModWorkshopLivePage(true, sortMode, 1);
    else void loadPage(activeTab, true, sortMode, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, activeSourceId, exactSourceCacheKey, sortMode, profileId, modWorkshopGameKey, nexusGameKey]);


  function backToBrowseList() {
    const detailSource = selectedMod?.source ?? activeTab;
    setView("list");
    setSelectedMod(null);

    const visibleForSource = sourceMods.filter((mod) => mod.source === detailSource).length;
    if (visibleForSource <= 1) {
      setActiveTab(detailSource);
      window.setTimeout(() => {
        if (detailSource === "modworkshop") void loadModWorkshopLivePage(true, sortMode, 1);
        else void loadPage(detailSource, true, sortMode, 1);
      }, 0);
    }
  }

  if (view === "detail" && selectedMod) {
    const loadingThisDetail = detailLoadingKey === `${selectedMod.source}-${selectedMod.sourceId}`;
    const liveFileData = hasLiveFileData(selectedMod);
    const files = liveFileData ? installableFiles(selectedMod.files, selectedMod.source) : [];
    const fileGroups = groupedSourceFiles(files, selectedMod.source);
    const selectedMatch = sourceMatches[`${selectedMod.source}-${selectedMod.sourceId}`];
    const detailSourceName = sourceLabel(selectedMod.source);
    const galleryImages = (selectedMod.images ?? []).filter((image) => canUseThumbnail(image.imageUrl || image.thumbnailUrl)).slice(0, 18);
    const changelogBlocks = descriptionParagraphs(selectedMod.changelog || "").filter((line) => line !== "No description loaded.");
    const commentBlocks = (selectedMod.comments ?? []).map(cleanDescription).filter(Boolean).slice(0, 16);
    const logBlocks = (selectedMod.logs ?? []).map(cleanDescription).filter(Boolean).slice(0, 16);
    const matchedFiles = selectedMatch?.matchedFiles ?? [];
    const disabledMatch = matchedFiles.some((name) => /\.disabled$/i.test(name));
    const fileBucketLabels: Record<SourceFileBucket, string> = { main: "Main files", optional: "Optional files", old: "Old files" };
    const sourceFileGroups: UnifiedFileGroup[] = (["main", "optional", "old"] as SourceFileBucket[])
      .filter((bucket) => bucket !== "old" || fileGroups.old.length > 0)
      .map((bucket) => ({
        id: bucket,
        title: fileBucketLabels[bucket],
        subtitle: bucket === "main" ? "Primary downloads" : bucket === "optional" ? "Optional downloads and requirements" : "Older versions",
        emptyLabel: `No ${fileBucketLabels[bucket].toLowerCase()} exposed by this source.`,
        rows: fileGroups[bucket].map((file) => {
          const matchedNames = matchedFileNamesForSourceFile(file, selectedMatch);
          const installed = matchedNames.length > 0;
          const disabled = matchedNames.some((name) => /\.disabled$/i.test(name));
          return {
            id: file.id,
            title: file.name,
            subtitle: sourceFileMetaLine(file),
            meta: file.uploadedAt ? `Uploaded ${formatSourceDate(file.uploadedAt)}` : null,
            status: installed ? (disabled ? "Disabled" : "Installed") : "Available",
            tone: installed ? (disabled ? "warning" as const : "good" as const) : "neutral" as const,
            actions: installed ? (
              <>
                {selectedMatch && <button className="ghost-button compact" type="button" onClick={() => openSourceFileNamesLocation(selectedMatch, matchedNames)} disabled={installingKey !== null}>Open Folder</button>}
                <button className="ghost-button compact" type="button" onClick={() => setSourceFileNamesEnabled(matchedNames, disabled)} disabled={installingKey !== null}>{disabled ? "Enable" : "Disable"}</button>
                <button className="ghost-button compact danger-button" type="button" onClick={() => uninstallSourceFileNames(matchedNames)} disabled={installingKey !== null}>Uninstall</button>
              </>
            ) : (
              <button className="ghost-button compact install-button" type="button" onClick={() => stageFile(selectedMod, file)} disabled={installingKey !== null || !downloadsEnabled} title={!downloadsEnabled ? downloadsBlockedMessage : undefined}>{installingKey === fileKey(selectedMod, file) ? "Installing..." : "Install"}</button>
            ),
            progress: <MiniProgress active={installingKey === fileKey(selectedMod, file)} />,
          };
        }),
      }));
    const installedFileGroups: UnifiedFileGroup[] = matchedFiles.length ? [{
      id: "installed-files",
      title: "Installed files",
      subtitle: "Files currently tracked for this source match.",
      rows: matchedFiles.map((fileName) => ({
        id: fileName,
        title: fileName.split(/[\\/]/).pop() ?? fileName,
        subtitle: fileName,
        status: /\.disabled$/i.test(fileName) ? "Disabled" : "Enabled",
        tone: /\.disabled$/i.test(fileName) ? "warning" as const : "good" as const,
        actions: selectedMatch ? (
          <>
            <button className="ghost-button compact" type="button" onClick={() => openSourceFileNamesLocation(selectedMatch, [fileName])} disabled={installingKey !== null}>Reveal</button>
            <button className="ghost-button compact" type="button" onClick={() => navigator.clipboard.writeText(fileName)}>Copy Path</button>
          </>
        ) : null,
      })),
    }] : [];
    const statistics: UnifiedInfoItem[] = [
      selectedMod.updatedAt ? { label: "Last Update", value: sourceUpdatedLabel(selectedMod as SourceModSummary) ?? String(selectedMod.updatedAt) } : null,
      typeof selectedMod.downloads === "number" ? { label: "Downloads", value: selectedMod.downloads.toLocaleString() } : null,
      typeof selectedMod.likes === "number" ? { label: "Likes", value: selectedMod.likes.toLocaleString() } : null,
      typeof selectedMod.views === "number" ? { label: "Views", value: selectedMod.views.toLocaleString() } : null,
      ...((selectedMod.stats ?? []).slice(0, 8)),
    ].filter(Boolean) as UnifiedInfoItem[];
    const metadata: UnifiedInfoItem[] = [
      { label: "Install Status", value: selectedMatch?.installed ? (selectedMatch.enabled === false ? "Disabled" : "Installed") : "Not installed", tone: selectedMatch?.installed ? "good" : "neutral" },
      { label: "Verification", value: selectedMatch ? `${selectedMatch.confidence}% ${selectedMatch.confidenceLevel ?? "match"}` : "Not matched" },
      { label: "Update", value: selectedMatch?.updateAvailable ? "Update available" : selectedMatch?.installed ? "Current" : "Unknown", tone: selectedMatch?.updateAvailable ? "warning" : "neutral" },
      { label: "Category", value: selectedMatch?.sourceFileCategory ?? null },
      { label: "Files", value: liveFileData ? `${files.length} downloadable` : "Live file list unavailable" },
    ];
    const actions: UnifiedAction[] = [
      selectedMatch?.installed && selectedMatch.updateAvailable ? { key: "update", label: installingKey ? "Updating..." : "Update", onClick: () => updateInstalledSource(selectedMod, selectedMatch), disabled: installingKey !== null || !downloadsEnabled, variant: "update" } : null,
      selectedMatch?.installed ? { key: "toggle", label: disabledMatch ? "Enable" : "Disable", onClick: () => setSourceFileNamesEnabled(matchedFiles, disabledMatch), disabled: installingKey !== null || matchedFiles.length === 0, variant: "neutral" } : null,
      !selectedMatch?.installed ? { key: "install", label: installingKey ? "Installing..." : "Install", onClick: () => openInstall(selectedMod), disabled: installingKey !== null || !downloadsEnabled, title: !downloadsEnabled ? downloadsBlockedMessage : undefined, variant: "install" } : null,
      liveFileData && files.length > 0 ? { key: "browse-files", label: "Browse Files", onClick: () => { setInstallPickerReplacementFiles([]); setSelectedFileIds(defaultSelectedFileIds(files, selectedMod.source)); setInstallPickerMod({ ...selectedMod, files }); }, disabled: installingKey !== null, variant: selectedMatch?.installed ? "neutral" : "primary" } : null,
      selectedMatch?.installed ? { key: "open-folder", label: "Open Folder", onClick: () => openSourceFileNamesLocation(selectedMatch, matchedFiles), disabled: installingKey !== null || matchedFiles.length === 0, variant: "neutral" } : null,
      selectedMatch?.installed ? { key: "uninstall", label: installingKey?.endsWith("-uninstall") ? "Uninstalling..." : "Uninstall", onClick: () => uninstallMatchedSource(selectedMatch), disabled: installingKey !== null, variant: "danger" } : null,
      { key: "refresh", label: loadingThisDetail ? "Refreshing..." : "Refresh", onClick: refreshSelectedDetail, disabled: detailLoadingKey !== null, variant: "neutral" },
      { key: "share", label: "Share", onClick: () => navigator.clipboard.writeText(selectedMod.pageUrl ?? selectedMod.name), variant: "neutral" },
    ].filter(Boolean) as UnifiedAction[];
    const versionHistory: UnifiedTimelineItem[] = [
      ...changelogBlocks.slice(0, 12).map((entry, index) => ({ id: `changelog-${index}`, title: "Changelog", detail: entry, tone: "neutral" as const })),
      ...logBlocks.slice(0, 12).map((entry, index) => ({ id: `log-${index}`, title: "Source log", detail: entry, tone: "neutral" as const })),
    ];
    const updateItems: UnifiedTimelineItem[] = selectedMatch ? [{
      id: "source-update",
      title: selectedMatch.updateAvailable ? "Update available" : "Installed version",
      detail: selectedMatch.reason,
      date: selectedMatch.sourceUpdatedAt ?? selectedMatch.sourceFileUploadedAt ?? selectedMatch.sourceFileVersion ?? null,
      status: selectedMatch.updateAvailable ? "Review" : "Current",
      tone: selectedMatch.updateAvailable ? "warning" : "good",
    }] : [];
    const developerItems: UnifiedInfoItem[] = [
      { label: "Source ID", value: selectedMod.sourceId },
      { label: "UID", value: selectedMod.uid },
      { label: "Data source", value: selectedMod.dataSource },
      { label: "Detail source", value: selectedMod.detailDataSource },
      { label: "File list source", value: selectedMod.fileListDataSource },
      { label: "Match kind", value: selectedMatch?.matchKind },
      { label: "Receipt ID", value: selectedMatch?.receiptId },
      { label: "Source File ID", value: selectedMatch?.sourceFileId },
    ];
    const liveDependencies = (selectedMod.dependencies ?? []).map((dependency) => enrichDependency({
      name: dependency.name,
      required: dependency.required,
      optional: dependency.optional,
      sourceKind: dependency.sourceKind as DependencySourceKind | undefined,
      gameDomain: dependency.gameDomain ?? undefined,
      numericGameId: dependency.numericGameId ?? undefined,
      modId: dependency.modId ?? undefined,
      url: dependency.url ?? undefined,
      notes: dependency.notes ?? undefined,
      versionConstraint: dependency.versionConstraint ?? undefined,
    }, profileId));
    const graphRoots = buildDependencyGraph(liveDependencies);
    const dependencyRows: UnifiedDependencyItem[] = [];
    const listedDependencies = new Set<string>();
    const addDependencyRow = (dependency: DependencyDefinition, parent?: string) => {
      if (listedDependencies.has(dependency.id)) return;
      listedDependencies.add(dependency.id);
      dependencyRows.push({
        id: dependency.id,
        title: <DependencyName dependency={dependency} onOpenNative={(item) => { const summary = dependencyToSourceSummary(item); if (!summary) return false; void openMod(summary); return true; }} />,
        detail: [parent ? `Required by ${parent}` : dependency.description, dependency.versionConstraint ? `Version ${dependency.versionConstraint}` : null, dependencySourceLabel(dependency)].filter(Boolean).join(" - "),
        status: dependency.required ? "Required" : dependency.optional ? "Optional" : "Recommended",
        tone: dependency.required ? "warning" : "neutral",
        actions: <DependencyActions dependency={dependency} onOpenNative={(item) => { const summary = dependencyToSourceSummary(item); if (!summary) return false; void openMod(summary); return true; }} />,
      });
      const node = graphRoots.find((root) => root.dependency.id === dependency.id);
      node?.children.forEach((child) => addDependencyRow(child.dependency, dependency.name));
    };
    graphRoots.forEach((node) => {
      addDependencyRow(node.dependency);
      node.children.forEach((child) => addDependencyRow(child.dependency, node.dependency.name));
    });

    return (
      <>
        {!downloadsEnabled && (
          <article className="safe-result warning profile-download-disabled" role="status">
            <strong>Downloads disabled</strong>
            <span>{downloadsBlockedMessage}</span>
          </article>
        )}
        <UnifiedModPage
          className="browse-unified-mod-page"
          backLabel="Back to Browse"
          onBack={backToBrowseList}
          source={selectedMod.source}
          sourceLabel={detailSourceName}
          sourceAccent={sourceAccent(selectedMod.source)}
          sourceId={selectedMod.sourceId}
          title={displayModTitle(selectedMod)}
          summary={selectedMod.shortDescription || "Source mod page."}
          description={selectedMod.description || selectedMod.shortDescription || "No description loaded."}
          author={displayAuthor(selectedMod)}
          version={selectedMod.version}
          game={selectedMod.gameId ?? sourceGameKeyFor(selectedMod.source)}
          category={selectedMatch?.sourceFileCategory ?? null}
          installStatus={selectedMatch?.installed ? (selectedMatch.enabled === false ? "Disabled" : "Installed") : "Not installed"}
          verificationStatus={selectedMatch ? `${selectedMatch.confidence}% ${selectedMatch.confidenceLevel ?? "match"}` : "Unmatched"}
          thumbnailUrl={canUseThumbnail(selectedMod.thumbnailUrl) ? selectedMod.thumbnailUrl : null}
          bannerUrl={canUseThumbnail(selectedMod.bannerUrl) ? selectedMod.bannerUrl : null}
          pageUrl={selectedMod.pageUrl}
          tags={selectedMod.tags ?? []}
          badges={[
            { label: detailSourceName, tone: "neutral" as const },
            loadingThisDetail ? { label: "Loading full page", tone: "warning" as const } : null,
            !liveFileData ? { label: "Live files unavailable", tone: "warning" as const } : null,
            selectedMatch?.updateAvailable ? { label: "Update Available", tone: "warning" as const } : null,
          ].filter(Boolean) as Array<{ label: ReactNode; tone?: "good" | "warning" | "danger" | "neutral" }>}
          actions={actions}
          metadata={metadata}
          statistics={statistics}
          galleryImages={galleryImages}
          fileGroups={sourceFileGroups}
          installedFileGroups={installedFileGroups}
          dependencies={dependencyRows}
          versionHistory={versionHistory}
          updateItems={updateItems}
          comments={commentBlocks.map((comment, index) => <p key={`comment-${index}`}>{comment}</p>)}
          developerMode={developerMode}
          developerItems={developerItems}
          filesUnavailableMessage={!liveFileData ? liveFileDataUnavailableMessage() : null}
          onOpenExternal={openWebsite}
          onImageError={markThumbnailFailed}
        />

        {results.length > 0 && <div className="card safe-results">{results.map((result, index) => <ResultNotice result={result} profileId={profileId} key={`${result.fileName}-${index}`} />)}</div>}

        {installPickerMod && (
          <InstallPicker
            mod={installPickerMod}
            match={sourceMatches[`${installPickerMod.source}-${installPickerMod.sourceId}`] ?? null}
            selectedFileIds={selectedFileIds}
            setSelectedFileIds={setSelectedFileIds}
            installingKey={installingKey}
            downloadsEnabled={downloadsEnabled}
            downloadsBlockedMessage={downloadsBlockedMessage}
            onClose={() => setInstallPickerMod(null)}
            onInstallOne={(mod, file) => stageFile(mod, file, installPickerReplacementFiles)}
            onInstallSelected={installSelected}
            onOpenLocation={openSourceFileNamesLocation}
            onUninstall={uninstallSourceFileNames}
            onSetEnabled={setSourceFileNamesEnabled}
          />
        )}

        {pendingDelete && (
          <div className="confirm-overlay" role="dialog" aria-modal="true">
            <div className="confirm-panel">
              <p className="eyebrow">Confirm delete</p>
              <h2>Delete {pendingDelete.title}?</h2>
              <p>Tsuki will permanently delete these files unless Keep Uninstalled Mods is enabled in Settings.</p>
              <div className="confirm-file-list">
                {pendingDelete.fileNames.map((fileName) => <span key={fileName}>{fileName}</span>)}
              </div>
              <div className="button-row">
                <button className="ghost-button compact" type="button" onClick={() => setPendingDelete(null)}>Cancel</button>
                <button className="ghost-button compact danger-button" type="button" onClick={confirmDelete}>Delete</button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }
  return (
    <section className="page browse-page safe-browse-page">
      <div className="browse-hero card">
        <div>
          <p className="eyebrow">Source browser</p>
          <h1>Browse</h1>
          <p className="page-description">Search Nexus Mods and ModWorkshop from one clean mod browser.</p>
        </div>

        <div className="browse-source-switcher">
          {configuredSources.map((source) => (
            <button
              className={`source-tab ${activeSource?.id === source.id ? "active" : ""}`}
              type="button"
              key={source.id}
              title={source.displayName}
              onClick={() => switchBrowseSource(sourceTabFor(source), source.id)}
            >
              <span>{source.displayName}</span>
            </button>
          ))}
        </div>
      </div>

      {!downloadsEnabled && (
        <article className="safe-result warning profile-download-disabled" role="status">
          <strong>{gameInstalled ? "Downloads pending profile validation" : "Browse-only profile"}</strong>
          <span>{downloadsBlockedMessage}</span>
        </article>
      )}

      <div className="browse-toolbar card">
        <div>
          <h2 title={activeSource?.displayName}>{activeSource?.displayName ?? sourceLabel(activeTab)}{activeTab === "modworkshop" && activeSource?.gameVersion ? ` - ${activeSource.gameVersion}` : ""}</h2>
          <p>{activeTab === "custom" ? (customBrowserUrl ? customBrowserUrl : "No start URL configured.") : loadingSource === activeTab ? `Loading ${sourceLabel(activeTab)}...` : `${sourceMods.length} mods loaded.`}</p>
          {activeTab === "modworkshop" && activeModWorkshopSearch && (
            <span className="status-pill">Search: {activeModWorkshopSearch}</span>
          )}
          {activeTab === "nexus" && activeNexusSearch && (
            <span className="status-pill">Search: {activeNexusSearch}</span>
          )}
        </div>

        <div className="browse-toolbar-controls unified-browser-controls">
          <form
            className="source-search-form unified-search-form"
            onSubmit={(event) => {
              event.preventDefault();
              searchActiveSource();
            }}
          >
            <input
              className="setting-input unified-search-input"
              value={sourceSearchQuery}
              onChange={(event) => {
                const value = event.target.value;
                setSourceSearchQuery(value);
                if (activeTab === "custom") return;
                if (value.trim() === "") {
                  setSearchQuery("");
                  setActiveModWorkshopSearch("");
                  setActiveNexusSearch("");
                  setPages((current) => ({ ...current, [activeTab]: 0 }));
                  setHasMore((current) => ({ ...current, [activeTab]: true }));
                  setStatus(`Showing normal ${sourceLabel(activeTab)} browse results.`);
                }
              }}
              placeholder={activeTab === "custom" ? "Enter website URL..." : `Search ${gameName} mods...`}
            />
            <button className="ghost-button" type="submit" disabled={sourceSearching || (activeTab === "nexus" && nexusApiKeyMissing)}>
              {activeTab === "custom" ? "Go" : sourceSearching ? "Searching..." : "Search"}
            </button>
            <button
              className="ghost-button compact"
              type="button"
              onClick={() => {
                void clearActiveSourceSearch();
              }}
              disabled={sourceSearching || loadingSource !== null}
            >
              Clear
            </button>
          </form>

          {activeTab !== "custom" && (
            <select
              className="select-input unified-sort-select"
              value={sortMode}
              aria-label={`Sort ${sourceLabel(activeTab)} mods`}
              onChange={(event) => handleSortChange(event.target.value as SortMode)}
            >
              {activeSortOptions.map((option) => (
                <option value={option.id} key={option.id}>{option.label}</option>
              ))}
            </select>
          )}

          {activeTab === "modworkshop" && modWorkshopCategories.length > 0 && (
            <select
              className="select-input unified-category-select"
              value={categoryId}
              aria-label="Filter ModWorkshop category"
              onChange={(event) => handleCategoryChange(event.target.value)}
              disabled={categoriesLoading || loadingSource !== null}
            >
              <option value="">All categories</option>
              {modWorkshopCategories.map((category) => (
                <option value={category.id} key={category.id}>{category.label}</option>
              ))}
            </select>
          )}

          {activeTab === "modworkshop" && categoriesLoading && modWorkshopCategories.length === 0 && (
            <span className="status-pill browse-filter-loading">Loading categories...</span>
          )}

          {activeTab === "modworkshop" && categoriesLoading && modWorkshopCategories.length > 0 && (
            <span className="status-pill browse-filter-loading">Refreshing categories...</span>
          )}

          {activeTab === "modworkshop" && !categoriesLoading && categoryStatus === "loaded" && modWorkshopCategories.length > 0 && (
            <span className="status-pill browse-filter-loading good">Categories loaded</span>
          )}

          {activeTab === "modworkshop" && !categoriesLoading && categoryStatus === "cache-refresh-failed" && modWorkshopCategories.length > 0 && (
            <span className="status-pill browse-filter-loading warning">Using cached categories</span>
          )}

          {activeTab === "modworkshop" && !categoriesLoading && categoryStatus === "unavailable" && modWorkshopCategories.length === 0 && (
            <span className="status-pill browse-filter-loading warning">Categories unavailable</span>
          )}

          {activeTab === "modworkshop" && !categoriesLoading && categoryStatus === "failed" && modWorkshopCategories.length === 0 && (
            <button className="ghost-button compact" type="button" onClick={retryModWorkshopCategories}>
              Retry categories
            </button>
          )}

          <div className="browse-toolbar-actions">
            <button className="ghost-button" type="button" onClick={refresh} disabled={activeTab === "nexus" && nexusApiKeyMissing}>{activeTab === "custom" ? "Refresh" : "Refresh"}</button>
            <button className="ghost-button" type="button" onClick={() => void openActiveSourceEmbeddedWindow()} disabled={managedBrowserOpening || (activeTab === "custom" ? (!customBrowserUrl && !customBrowserInput) : !sourceStartUrlFor(activeTab))}>{managedBrowserOpening ? "Opening..." : activeTab === "custom" && managedBrowserOpen ? "Focus In-App" : "Open In-App"}</button>
            <button className="ghost-button" type="button" onClick={() => void openActiveSourceExternal()} disabled={activeTab === "custom" ? (!customBrowserUrl && !customBrowserInput) : !sourceStartUrlFor(activeTab)}>Open External</button>
          </div>
        </div>
      </div>

      {activeTab === "modworkshop" && categoryStatus === "cache-refresh-failed" && modWorkshopCategories.length > 0 && (
        <div className="safe-result warning">
          <strong>Using cached ModWorkshop categories</strong>
          <span>{categoryError ?? "Refresh failed, so Tsuki kept the cached category list visible."}</span>
          <button className="ghost-button compact" type="button" onClick={retryModWorkshopCategories}>Retry</button>
        </div>
      )}

      {activeTab === "modworkshop" && (categoryStatus === "failed" || categoryStatus === "unavailable") && modWorkshopCategories.length === 0 && (
        <div className="safe-result warning">
          <strong>{categoryStatus === "failed" ? "Category request failed" : "Categories unavailable"}</strong>
          <span>{categoryError ?? `No ModWorkshop categories were returned for ${gameName} (${modWorkshopGameKey}).`}</span>
          <button className="ghost-button compact" type="button" onClick={retryModWorkshopCategories}>Retry</button>
        </div>
      )}

      {activeTab === "nexus" && nexusApiKeyMissing && (
        <div className="safe-result warning">
          <strong>Nexus API key required</strong>
          <span>Add a Nexus API key in Settings &gt; API Keys.</span>
          <small>ModWorkshop browsing still works without a key.</small>
        </div>
      )}

      {loadingSource === activeTab && (
        <div className="safe-result">
          <strong>Loading {sourceLabel(activeTab)}</strong>
          <span>{cacheNote || status}</span>
          <small>Live request has a timeout. If it stalls, Tsuki will show indexed/cache fallback cards instead of spinning forever.</small>
        </div>
      )}

      {activeTab === "custom" && (
        <section className={`embedded-browser-panel ${activeSource?.browseMode === "iframe" ? "inline-browser-mode" : "managed-window-mode"}`}>
          <header>
            <div>
              <p className="eyebrow">Embedded browsing</p>
              <h2>{customBrowserName}</h2>
            </div>
            <div className="embedded-browser-meta">
              {customBrowserDomainList.length ? customBrowserDomainList.slice(0, 4).map((domain) => <span key={domain}>{domain}</span>) : <span>Any domain</span>}
            </div>
          </header>
          <div className="managed-browser-toolbar" aria-label="Browser window controls">
            <div className="managed-browser-navigation">
              <button className="ghost-button compact" type="button" disabled={activeSource?.browseMode !== "iframe" && !managedBrowserOpen} onClick={() => void controlActiveBrowser("back")} title="Back">Back</button>
              <button className="ghost-button compact" type="button" disabled={activeSource?.browseMode !== "iframe" && !managedBrowserOpen} onClick={() => void controlActiveBrowser("forward")} title="Forward">Forward</button>
              <button className="ghost-button compact" type="button" disabled={activeSource?.browseMode !== "iframe" && !managedBrowserOpen} onClick={() => activeSource?.browseMode === "iframe" ? reloadCustomBrowser() : void controlActiveBrowser("refresh")} title="Refresh">Refresh</button>
            </div>
            <div className="managed-browser-actions">
              <button className="ghost-button compact" type="button" disabled={managedBrowserOpening} onClick={() => void openActiveSourceEmbeddedWindow()}>{managedBrowserOpening ? "Opening..." : managedBrowserOpen ? "Focus In-App" : "Open In-App"}</button>
              <button className="ghost-button compact" type="button" onClick={() => void openActiveSourceExternal()}>Open External</button>
              <button className="ghost-button compact" type="button" disabled={!managedBrowserOpen} onClick={() => void controlActiveBrowser("close")}>Close</button>
            </div>
          </div>
          {customBrowserUrl && activeSource?.browseMode === "iframe" ? (
            <div className="embedded-browser-frame-shell">
              {customBrowserLoading && <div className="embedded-browser-loading">Loading website...</div>}
              <iframe
                key={`${customBrowserUrl}-${customBrowserFrameKey}`}
                title={`${customBrowserName} embedded browser`}
                src={customBrowserUrl}
                referrerPolicy="no-referrer-when-downgrade"
                sandbox={`${downloadsEnabled ? "allow-downloads " : ""}allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts`}
                onLoad={() => {
                  setCustomBrowserLoading(false);
                  setStatus(`Loaded ${customBrowserUrl}`);
                }}
              />
            </div>
          ) : customBrowserUrl ? (
            <div ref={managedBrowserViewportRef} className={`managed-browser-window-state ${managedBrowserOpen ? "open" : "closed"}`}>
              <span className={`managed-browser-status ${managedBrowserOpen ? "open" : "closed"}`} role="status">{managedBrowserOpen ? "Embedded browser open" : "Embedded browser closed"}</span>
              <strong>{managedBrowserOpen ? `${customBrowserName} is open inside Tsuki` : `Open ${customBrowserName} inside Tsuki`}</strong>
              <span>{customBrowserUrl}</span>
              <button className="ghost-button install-button" type="button" disabled={managedBrowserOpening} onClick={() => void openActiveSourceEmbeddedWindow()}>{managedBrowserOpening ? "Opening..." : managedBrowserOpen ? `Focus ${customBrowserName}` : `Open ${customBrowserName}`}</button>
            </div>
          ) : (
            <article className="safe-result warning">
              <strong>No start URL configured</strong>
              <span>Add a Starting Page URL or Start URL to this profile's Custom Browser source in Profile Creator.</span>
            </article>
          )}
        </section>
      )}

      {activeTab !== "custom" && <div className="source-mod-grid cleaner-grid">
        {sourceMods.map((mod) => {
          const match = sourceMatches[`${mod.source}-${mod.sourceId}`];
          const installed = Boolean(match?.installed);
          const primaryAction = browseCardsLive && installed && match?.updateAvailable
            ? {
                label: "Update",
                variant: "update" as const,
                disabled: installingKey !== null || !downloadsEnabled,
                onClick: () => updateInstalledSource(mod, match),
              }
            : installed
              ? {
                  label: "Uninstall",
                  variant: "danger" as const,
                  disabled: installingKey !== null || !downloadsEnabled,
                  title: !downloadsEnabled ? downloadsBlockedMessage : undefined,
                  onClick: () => uninstallMatchedSource(match),
                }
              : {
                  label: "Install",
                  variant: "default" as const,
                  disabled: installingKey !== null || !downloadsEnabled,
                  title: !downloadsEnabled ? downloadsBlockedMessage : undefined,
                  onClick: () => openInstall(mod),
                };

          return (
            <ModCard
              key={`${mod.source}-${mod.sourceId}`}
              className="source-mod-card cleaner-card lightweight-card"
              title={displayModTitle(mod)}
              source={mod.source}
              sourceLabel={sourceLabel(mod.source)}
              author={displayAuthor(mod)}
              version={mod.version}
              thumbnailUrl={mod.thumbnailUrl}
              bannerUrl={mod.bannerUrl}
              tags={sourceCardTags(mod)}
              likes={mod.likes}
              downloads={mod.downloads}
              views={mod.views}
              updatedLabel={sourceUpdatedLabel(mod)}
              installed={installed}
              enabled={match?.enabled ?? null}
              canUseThumbnail={canUseThumbnail}
              onThumbnailFailed={markThumbnailFailed}
              onOpen={() => void openMod(mod)}
              primaryAction={primaryAction}
              moreActions={(
                <>
                  <button type="button" onClick={() => openWebsite(mod.pageUrl)}>Website</button>
                  <button type="button" onClick={() => openMod(mod)}>Open details</button>
                </>
              )}
            />
          );
        })}
      </div>}

      {activeTab !== "custom" && <div className="safe-floating-controls" aria-label="Browse bottom controls">
        <button className="ghost-button compact" type="button" onClick={scrollBrowseToTop}>
          Back to Top
        </button>
        <button className="ghost-button compact" type="button" onClick={() => goToBrowsePage(Math.max(1, pages[activeTab] - 1))} disabled={loadingSource !== null || pages[activeTab] <= 1}>
          Previous Page
        </button>
        <span className="safe-page-pill">Page {Math.max(1, pages[activeTab])}</span>
        <button className="ghost-button compact" type="button" onClick={() => goToBrowsePage(pages[activeTab] + 1)} disabled={loadingSource !== null || !hasMore[activeTab]}>
          {loadingSource === activeTab ? "Loading..." : hasMore[activeTab] ? "Next Page" : "No More"}
        </button>
      </div>}

      {activeTab !== "custom" && sourceMods.length === 0 && (
        <article className="card">
          <h2>No mods loaded</h2>
          <p>{status}</p>
          <button className="ghost-button" type="button" onClick={() => activeTab === "modworkshop" ? loadModWorkshopLivePage(true, sortMode, 1) : loadPage(activeTab, true, sortMode, 1)}>Try loading again</button>
        </article>
      )}

      {results.length > 0 && <div className="card safe-results">{results.map((result, index) => <ResultNotice result={result} profileId={profileId} key={`${result.fileName}-${index}`} />)}</div>}

      {installPickerMod && (
        <InstallPicker
          mod={installPickerMod}
          match={sourceMatches[`${installPickerMod.source}-${installPickerMod.sourceId}`] ?? null}
          selectedFileIds={selectedFileIds}
          setSelectedFileIds={setSelectedFileIds}
          installingKey={installingKey}
          downloadsEnabled={downloadsEnabled}
          downloadsBlockedMessage={downloadsBlockedMessage}
          onClose={() => setInstallPickerMod(null)}
          onInstallOne={(mod, file) => stageFile(mod, file, installPickerReplacementFiles)}
          onInstallSelected={installSelected}
          onOpenLocation={openSourceFileNamesLocation}
          onUninstall={uninstallSourceFileNames}
          onSetEnabled={setSourceFileNamesEnabled}
        />
      )}

      {pendingDelete && (
        <div className="confirm-overlay" role="dialog" aria-modal="true">
          <div className="confirm-panel">
            <p className="eyebrow">Confirm delete</p>
            <h2>Delete {pendingDelete.title}?</h2>
            <p>Tsuki will permanently delete these files unless Keep Uninstalled Mods is enabled in Settings.</p>
            <div className="confirm-file-list">
              {pendingDelete.fileNames.map((fileName) => <span key={fileName}>{fileName}</span>)}
            </div>
            <div className="button-row">
              <button className="ghost-button compact" type="button" onClick={() => setPendingDelete(null)}>Cancel</button>
              <button className="ghost-button compact danger-button" type="button" onClick={confirmDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function InstallPicker({
  mod,
  match,
  selectedFileIds,
  setSelectedFileIds,
  installingKey,
  downloadsEnabled,
  downloadsBlockedMessage,
  onClose,
  onInstallOne,
  onInstallSelected,
  onOpenLocation,
  onUninstall,
  onSetEnabled,
}: {
  mod: SourceModDetail;
  match: InstalledSourceMatch | null;
  selectedFileIds: string[];
  setSelectedFileIds: Dispatch<SetStateAction<string[]>>;
  installingKey: string | null;
  downloadsEnabled: boolean;
  downloadsBlockedMessage: string;
  onClose: () => void;
  onInstallOne: (mod: SourceModDetail, file: SourceModFile) => void;
  onInstallSelected: () => void;
  onOpenLocation: (match: InstalledSourceMatch, fileNames: string[]) => void;
  onUninstall: (fileNames: string[]) => void;
  onSetEnabled: (fileNames: string[], enabled: boolean) => void;
}) {
  const files = installableFiles(mod.files, mod.source);
  const groups = groupedSourceFiles(files, mod.source);
  const installableUninstalledIds = files
    .filter((file) => matchedFileNamesForSourceFile(file, match).length === 0)
    .map((file) => file.id);
  const selectedUninstalledCount = selectedFileIds.filter((id) => installableUninstalledIds.includes(id)).length;
  const requirements = (mod.dependencies ?? []).map((dependency) => enrichDependency({
    name: dependency.name,
    required: dependency.required,
    optional: dependency.optional,
    sourceKind: dependency.sourceKind as DependencySourceKind | undefined,
    gameDomain: dependency.gameDomain ?? undefined,
    numericGameId: dependency.numericGameId ?? undefined,
    modId: dependency.modId ?? undefined,
    url: dependency.url ?? undefined,
    notes: dependency.notes ?? undefined,
    versionConstraint: dependency.versionConstraint ?? undefined,
  }));

  return (
    <div className="image-preview-overlay safe-overlay" role="dialog" aria-modal="true">
      <div className="install-preview-panel quick-install-panel">
        <div className="image-preview-header">
          <strong>Install Files: {mod.name}</strong>
          <button className="ghost-button compact" type="button" onClick={onClose}>Close</button>
        </div>

        <div className="quick-install-actions">
          <button className="ghost-button compact" type="button" onClick={() => setSelectedFileIds(defaultSelectedFileIds(files, mod.source).filter((id) => installableUninstalledIds.includes(id)))}>Latest Main</button>
          <button className="ghost-button compact" type="button" onClick={() => setSelectedFileIds(installableUninstalledIds)}>Select All</button>
          <button className="ghost-button compact" type="button" onClick={() => setSelectedFileIds([])}>Select None</button>
          <button className="ghost-button compact install-button" type="button" onClick={onInstallSelected} disabled={!downloadsEnabled || installingKey !== null || selectedUninstalledCount === 0} title={!downloadsEnabled ? downloadsBlockedMessage : undefined}>
            {installingKey ? "Installing..." : `Install Selected (${selectedUninstalledCount})`}
          </button>
        </div>

        {!downloadsEnabled && (
          <article className="safe-result warning" role="status">
            <strong>Downloads disabled</strong>
            <span>{downloadsBlockedMessage}</span>
          </article>
        )}

        {requirements.length > 0 && <section className="quick-file-bucket optional">
          <div className="quick-file-bucket-heading"><strong>Requirements</strong><small>{requirements.length} linked</small></div>
          {requirements.map((dependency) => <div className="quick-file-row" key={dependency.id}>
            <div><DependencyName dependency={dependency} /><small>{dependency.required ? "Required" : "Optional"} - {dependencySourceLabel(dependency)}</small></div>
            <DependencyActions dependency={dependency} />
          </div>)}
        </section>}

        <div className="quick-file-list quick-file-bucket-list">
          {([
            ["main", "Main files"],
            ["optional", "Optional files"],
            ["old", "Old versions"],
          ] as Array<[SourceFileBucket, string]>).filter(([bucket]) => bucket !== "old" || groups.old.length > 0).map(([bucket, label]) => (
            <div className={`quick-file-bucket ${bucket}`} key={bucket}>
              <div className="quick-file-bucket-heading">
                <strong>{label}</strong>
                <small>{groups[bucket].length} file{groups[bucket].length === 1 ? "" : "s"}</small>
              </div>
              {groups[bucket].map((file) => {
                const key = fileKey(mod, file);
                const checked = selectedFileIds.includes(file.id);
                const matchedNames = matchedFileNamesForSourceFile(file, match);
                const installed = matchedNames.length > 0;
                const disabled = matchedNames.some((name) => /\.disabled$/i.test(name));
                const busy = installingKey === key || matchedNames.some((name) => installingKey?.includes(name));

                return (
                  <div className={`quick-file-row ${installed ? "installed" : ""}`} key={file.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={installed}
                        onChange={(event) => {
                          setSelectedFileIds((current) =>
                            event.target.checked
                              ? [...new Set([...current, file.id])]
                              : current.filter((id) => id !== file.id),
                          );
                        }}
                      />
                      <span>
                        <strong>{file.name}</strong>
                        <small>{sourceFileMetaLine(file)}</small>
                        {installed && <em>{disabled ? "Installed: Disabled" : "Installed"}</em>}
                      </span>
                    </label>

                    {installed ? (
                      <div className="quick-file-actions source-file-row-actions">
                        {match && (
                          <button className="ghost-button compact" type="button" onClick={() => onOpenLocation(match, matchedNames)} disabled={Boolean(busy)}>
                            Open Location
                          </button>
                        )}
                        <button className="ghost-button compact" type="button" onClick={() => onSetEnabled(matchedNames, disabled)} disabled={Boolean(busy)}>
                          {disabled ? "Enable" : "Disable"}
                        </button>
                        <button className="ghost-button compact danger-button" type="button" onClick={() => onUninstall(matchedNames)} disabled={Boolean(busy)}>
                          Uninstall
                        </button>
                      </div>
                    ) : (
                      <div className="quick-file-actions source-file-row-actions">
                        <button className="ghost-button compact install-button" type="button" onClick={() => onInstallOne(mod, file)} disabled={!downloadsEnabled || installingKey !== null} title={!downloadsEnabled ? downloadsBlockedMessage : undefined}>
                          {installingKey === key ? "Installing..." : "Install"}
                        </button>
                      </div>
                    )}

                    <MiniProgress active={installingKey === key} />
                  </div>
                );
              })}
              {groups[bucket].length === 0 && <p className="source-file-empty">No {label.toLowerCase()} found.</p>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

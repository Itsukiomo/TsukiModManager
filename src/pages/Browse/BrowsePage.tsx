import "./BrowsePage.css";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { AppSettings } from "../../models/settings";
import { CardMoreMenu } from "../../components/CardMoreMenu";
import { buildNexusBrowseKey, normalizeNexusId } from "../../sources/nexus/ids";
import type {
  ModSourceKind,
  SourceModDetail,
  SourceModSummary,
  SourceModFile,
  StagedDownloadResult,
  InstallApplyResult,
  InstalledSourceMatch,
} from "../../models/source";

type BrowseTab = ModSourceKind;
type SortMode = "recent" | "updated" | "added" | "popular" | "downloads" | "liked";
type ViewMode = "list" | "detail";

const SOURCE_CACHE_VERSION = "v1.8.39-author-home-comment-cache";
const SOURCE_CACHE_TTL_MS = 1000 * 60 * 5;

const sortOptions: Array<{ id: SortMode; label: string }> = [
  { id: "recent", label: "Recent" },
  { id: "updated", label: "Updated" },
  { id: "added", label: "Added" },
  { id: "popular", label: "Popular" },
  { id: "downloads", label: "Downloads" },
  { id: "liked", label: "Liked" },
];

function modMatchesQuery(mod: SourceModSummary, query: string) {
  const cleanQuery = query.trim().toLowerCase();
  if (!cleanQuery) return true;

  const haystack = [
    mod.name,
    mod.author ?? "",
    mod.shortDescription ?? "",
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

function sourceLabel(source: BrowseTab) {
  return source === "modworkshop" ? "ModWorkshop" : "Nexus";
}

function inferAuthorFromModName(name?: string | null) {
  const value = String(name ?? "").replace(/&#x2F;/gi, "/").replace(/&amp;/gi, "&").trim();
  const patterns = [
    /\s+by\s+([^()\[\]{}|•·<>]+)$/i,
    /\s+by\s+([^()\[\]{}|•·<>]+)\s*[-–—]/i,
  ];

  for (const pattern of patterns) {
    const author = value.match(pattern)?.[1]?.trim().replace(/\s+/g, " ");
    if (author && author.length <= 48) return author;
  }

  return null;
}

function displayAuthor(mod: SourceModSummary | SourceModDetail) {
  return (mod.author && mod.author.trim()) || inferAuthorFromModName(mod.name) || null;
}

function displayModTitle(mod: SourceModSummary | SourceModDetail) {
  const author = displayAuthor(mod);
  if (!author) return mod.name;
  const escapedAuthor = author.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return mod.name.replace(new RegExp(`\\s+by\\s+${escapedAuthor}\\s*$`, "i"), "").trim() || mod.name;
}

function cardDisplayAuthor(mod: SourceModSummary) {
  const direct = displayAuthor(mod);
  if (direct) return direct;

  const cached = readDetailCache(mod);
  if (cached) return displayAuthor(cached);

  return null;
}

function cardDisplayTitle(mod: SourceModSummary) {
  const cached = readDetailCache(mod);
  return displayModTitle(cached ?? mod);
}

function cardDisplayDescription(mod: SourceModSummary) {
  return friendlyCardDescription(mod) || "";
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

function invokeWithTimeout<T>(command: string, args: Record<string, unknown>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return Promise.race([
    invoke<T>(command, args),
    new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)),
  ]);
}

function sourceAccent(source: BrowseTab) {
  return source === "modworkshop" ? "MW" : "NX";
}

void sourceAccent;

function cacheKey(source: BrowseTab, sort: SortMode) {
  if (source === "nexus") {
    return `tsuki-source-cache:${SOURCE_CACHE_VERSION}:${buildNexusBrowseKey({
      gameDomainName: "payday3",
      sort,
      offset: 0,
      count: 24,
    })}`;
  }

  return `tsuki-source-cache:${SOURCE_CACHE_VERSION}:${source}:payday3:${sort}`;
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

function sortBrowseMods(mods: SourceModSummary[], sort: SortMode) {
  const copy = [...mods];

  copy.sort((a, b) => {
    const timeDelta = modTimeValue(b) - modTimeValue(a);
    const idDelta = sourceIdNumber(b) - sourceIdNumber(a);

    if (sort === "downloads" || sort === "popular") return (b.downloads ?? 0) - (a.downloads ?? 0) || timeDelta || idDelta;
    if (sort === "liked") return (b.likes ?? 0) - (a.likes ?? 0) || timeDelta || idDelta;
    if (sort === "added") return idDelta || timeDelta;
    if (sort === "updated" || sort === "recent") return timeDelta;
    return timeDelta || a.name.localeCompare(b.name);
  });

  return copy;
}


function orderBrowseModsForSource(mods: SourceModSummary[], source: BrowseTab, sort: SortMode) {
  const clean = cleanMods(mods).filter((mod) => mod.source === source);

  if (source === "modworkshop" && (sort === "recent" || sort === "updated")) {
    return clean;
  }

  return sortBrowseMods(clean, sort);
}

function readCache(source: BrowseTab, sort: SortMode): CachedSourceMods | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(source, sort));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as CachedSourceMods;
    if (parsed.version !== SOURCE_CACHE_VERSION || !Array.isArray(parsed.mods)) return null;

    const age = Date.now() - parsed.savedAt;
    if (age > SOURCE_CACHE_TTL_MS) return null;

    return {
      ...parsed,
      mods: orderBrowseModsForSource(parsed.mods, source, sort),
    };
  } catch {
    return null;
  }
}

function writeCache(source: BrowseTab, sort: SortMode, mods: SourceModSummary[], page: number, hasMore: boolean) {
  try {
    const sorted = source === "modworkshop" && (sort === "recent" || sort === "updated")
      ? cleanMods(mods).filter((mod) => mod.source === source).slice(0, 240)
      : orderBrowseModsForSource(mods, source, sort).slice(0, 240);
    window.localStorage.setItem(
      cacheKey(source, sort),
      JSON.stringify({ version: SOURCE_CACHE_VERSION, savedAt: Date.now(), page, hasMore, mods: sorted }),
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


const DETAIL_CACHE_VERSION = "v1.8.39-fast-tabs-source-actions";

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

const THUMBNAIL_FAIL_CACHE_KEY = "tsuki-thumbnail-failures:v0.85";
const THUMBNAIL_RETRY_AFTER_MS = 1000 * 60 * 60 * 24;

function readThumbnailFailures(): Record<string, number> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(THUMBNAIL_FAIL_CACHE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, number> : {};
  } catch {
    return {};
  }
}

function writeThumbnailFailures(value: Record<string, number>) {
  try {
    window.localStorage.setItem(THUMBNAIL_FAIL_CACHE_KEY, JSON.stringify(value));
  } catch {
    // Optional cache.
  }
}

function thumbnailRecentlyFailed(url: string | null | undefined, failures: Record<string, number>) {
  if (!url) return true;

  const failedAt = failures[url];
  if (!failedAt) return false;

  return Date.now() - failedAt < THUMBNAIL_RETRY_AFTER_MS;
}

function thumbnailFallbackText(source: BrowseTab) {
  return source === "modworkshop" ? "MW" : "NX";
}

function tagClassName(tag: string) {
  const key = tag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `status-pill tag-pill tag-${key || "general"}`;
}

function friendlyCardDescription(mod: SourceModSummary) {
  const text = shortCardDescription(mod).trim();
  const lower = text.toLowerCase();

  if (!text || lower.includes("live modworkshop payday 3 listing card") || lower.includes("no description cached")) {
    return "";
  }

  return text;
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

  return cleaned
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function renderLinkedText(text: string, openUrl: (url?: string | null) => void) {
  const parts: ReactNode[] = [];
  const pattern = /<a\s+[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>(.*?)<\/a>|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<)]+)/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const url = match[1] || match[4] || match[5];
    const label = (match[2] || match[3] || url).replace(/<[^>]+>/g, "").trim() || url;
    parts.push(
      <button className="inline-description-link" type="button" key={`${url}-${match.index}`} onClick={() => openUrl(url)}>
        {label}
      </button>,
    );
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length ? parts : text;
}

function shortCardDescription(mod: SourceModSummary) {
  const detail = readDetailCache(mod);
  const detailText = detail ? descriptionParagraphs(detail.description || detail.shortDescription || "").join(" ") : "";
  const rawSummary = cleanDescription((mod as SourceModSummary & { description?: string }).description || mod.shortDescription || "");
  const rawLower = rawSummary.toLowerCase();
  const rawIsWeak = !rawSummary
    || rawLower.includes("live modworkshop payday 3 listing card")
    || rawLower.includes("loaded from the payday 3 modworkshop page")
    || rawLower.includes("no description cached")
    || rawLower.includes("no description exposed");

  const summary = cleanDescription(rawIsWeak ? detailText : rawSummary);
  return summary;
}

function mergedCardTags(mod: SourceModSummary) {
  const detail = readDetailCache(mod);
  const tags = [
    sourceLabel(mod.source),
    "PAYDAY 3",
    ...(Array.isArray(mod.tags) ? mod.tags : []),
    ...((detail && Array.isArray(detail.tags)) ? detail.tags : []),
  ]
    .map((tag) => tag.trim())
    .filter(Boolean);

  return [...new Set(tags)].slice(0, 8);
}

function needsCardEnrichment(mod: SourceModSummary) {
  const description = cleanDescription(mod.shortDescription || "");
  if (!cardDisplayAuthor(mod) && mod.source === "modworkshop") return true;
  if (!readDetailCache(mod)) return true;
  if (!description) return true;
  if (description.toLowerCase().includes("loaded from the payday 3 modworkshop page")) return true;
  if (!mod.tags || mod.tags.length <= 1) return true;
  return false;
}
void needsCardEnrichment;


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
    const gameId = mod.source === "nexus" ? normalizeNexusId(mod.gameId ?? mod.nexus?.gameId) : null;
    const uid = mod.source === "nexus" ? normalizeNexusId(mod.uid ?? mod.nexus?.uid) : null;

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
      author: displayAuthor({ ...mod, name }) ?? mod.author,
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
  return [...files].sort((a, b) => String(b.uploadedAt ?? "").localeCompare(String(a.uploadedAt ?? "")));
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
    return installable.filter((file) => !isGenericModWorkshopPlaceholder(file));
  }

  return installable.filter((file) => !isGenericModWorkshopPlaceholder(file) || fileHasRouteHint(file));
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
    : installable.find((file) => !/\b(optional|addon|add-on|patch|compat|plugin|extra|lite|translation|variant|old|legacy|previous|archive|deprecated)\b/i.test(`${file.name} ${file.version ?? ""}`)) ?? installable[0] ?? null;
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
  ].filter(Boolean).join(" · ");
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

function ResultNotice({ result }: { result: StagedDownloadResult }) {
  const failed = result.archiveKind === "download-failed";
  return (
    <div className={`safe-result ${failed ? "failed" : ""}`}>
      <strong>{failed ? "Failed" : "Staged"}</strong>
      <span>{result.fileName}</span>
      <small>{failed ? result.warnings.join(" ") : `${result.archiveKind} · ${result.sizeBytes.toLocaleString()} bytes`}</small>
    </div>
  );
}

export function BrowsePage({ initialMod = null, onInitialModConsumed }: { initialMod?: SourceModSummary | null; onInitialModConsumed?: () => void }) {
  const [activeTab, setActiveTab] = useState<BrowseTab>("modworkshop");
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [view, setView] = useState<ViewMode>("list");
  const [mods, setMods] = useState<SourceModSummary[]>([]);
  const [pages, setPages] = useState<Record<BrowseTab, number>>({ modworkshop: 0, nexus: 0 });
  const [hasMore, setHasMore] = useState<Record<BrowseTab, boolean>>({ modworkshop: true, nexus: true });
  const [loadingSource, setLoadingSource] = useState<BrowseTab | null>(null);
  const [status, setStatus] = useState("Safe Browse is ready.");
  const [searchQuery, setSearchQuery] = useState("");
  const [sourceSearchQuery, setSourceSearchQuery] = useState("");
  const [activeModWorkshopSearch, setActiveModWorkshopSearch] = useState("");
  const [, setModWorkshopSearchPage] = useState(0);
  const [activeNexusSearch, setActiveNexusSearch] = useState("");
  const [sourceSearching, setSourceSearching] = useState(false);
  const [selectedMod, setSelectedMod] = useState<SourceModDetail | null>(null);
  const [detailLoadingKey, setDetailLoadingKey] = useState<string | null>(null);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [sourceDetailTab, setSourceDetailTab] = useState<"description" | "files" | "changelog" | "comments" | "images">("description");
  const [installPickerMod, setInstallPickerMod] = useState<SourceModDetail | null>(null);
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [results, setResults] = useState<StagedDownloadResult[]>([]);
  const [sourceMatches, setSourceMatches] = useState<Record<string, InstalledSourceMatch>>({});
  const [failedImages, setFailedImages] = useState<Record<string, number>>(() => readThumbnailFailures());
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [cacheNote, setCacheNote] = useState("");
  const [browseCardsLive, setBrowseCardsLive] = useState(false);
  const [nexusApiKeyMissing, setNexusApiKeyMissing] = useState(false);
  const browseRequestSeqRef = useRef(0);
  const enrichingCardKeysRef = useRef<Set<string>>(new Set());
  const modWorkshopSearchCacheRef = useRef<Map<string, SourceModSummary[]>>(new Map());
  const sourceMatchRefreshTimerRef = useRef<number | null>(null);

  const sourceMods = useMemo(() => {
    const base = orderBrowseModsForSource(mods, activeTab, sortMode);
    return base.filter((mod) => modMatchesQuery(mod, searchQuery));
  }, [activeTab, mods, searchQuery, sortMode]);


  useEffect(() => {
    let cancelled = false;

    const refreshNexusKeyStatus = () => {
      invoke<AppSettings>("get_app_settings")
        .then((settings) => {
          if (cancelled) return;
          setNexusApiKeyMissing(!settings.nexusApiKey?.trim());
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

  // v1.8.4: light, capped card enrichment. This fills real descriptions/tags without blocking scrolling.
  useEffect(() => {
    let cancelled = false;
    const targets = sourceMods
      .filter((mod) => needsCardEnrichment(mod))
      .filter((mod) => !enrichingCardKeysRef.current.has(`${mod.source}-${mod.sourceId}`))
      .slice(0, sourceSearching ? 0 : 6);

    if (targets.length === 0) return;

    const run = async () => {
      for (const mod of targets) {
        if (cancelled) return;
        const key = `${mod.source}-${mod.sourceId}`;
        enrichingCardKeysRef.current.add(key);

        try {
          const detail = await fetchDetailForMod(mod);
          if (cancelled) return;
          const description = cleanDescription(detail.description || detail.shortDescription || mod.shortDescription || "");
          const nextTags = Array.from(new Set([...(mod.tags ?? []), ...(detail.tags ?? [])].filter(Boolean))).slice(0, 12);

          setMods((current) => current.map((item) => {
            if (`${item.source}-${item.sourceId}` !== key) return item;
            return {
              ...item,
              name: displayModTitle(detail) || item.name,
              author: displayAuthor(detail) ?? item.author,
              shortDescription: description || item.shortDescription,
              tags: nextTags.length > 0 ? nextTags : item.tags,
              updatedAt: item.updatedAt ?? detail.updatedAt,
              downloads: item.downloads ?? detail.downloads,
              likes: item.likes ?? detail.likes,
            };
          }));
        } catch {
          // Card enrichment is best-effort. Failures stay in Debug/Test All, not normal cards.
        }

        await new Promise((resolve) => window.setTimeout(resolve, 30));
      }
    };

    void run();
    return () => { cancelled = true; };
  }, [activeTab, sourceMods.length, sortMode, searchQuery, sourceSearching]);

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
      setSourceMatches({});
      return;
    }

    try {
      const result = await invoke<InstalledSourceMatch[]>("match_installed_source_mods", {
        sourceMods: clean,
      });

      const next: Record<string, InstalledSourceMatch> = {};
      for (const match of result) next[`${match.source}-${match.sourceId}`] = match;
      setSourceMatches(next);
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
        ? await invoke<string>("uninstall_source_install", { source: match.source, sourceId: match.sourceId })
        : await invoke<string>("uninstall_pak_mod_files", { fileNames: match.matchedFiles });

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
      const result = await invoke<string>("uninstall_pak_mod_files", { fileNames });
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
      const result = await invoke<string>("set_pak_mod_files_enabled", { fileNames, enabled });
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
        ? await invoke<string>("uninstall_source_install", { source, sourceId })
        : await invoke<string>("uninstall_pak_mod_files", { fileNames: target.fileNames });

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

  async function loadSourceIndexFallback(source: BrowseTab, reset: boolean, reason: string, requestedSort: SortMode = sortMode) {
    void reset;
    void requestedSort;
    recordCachePolicyDiagnostic({
      browseDataSource: "live-unavailable",
      detailDataSource: "unchanged",
      fileListDataSource: "unchanged",
      cacheFallbackReason: reason,
    });
    setHasMore((current) => ({ ...current, [source]: false }));
      setCacheNote(`${sourceLabel(source)} live failed: ${reason}. Cache/source-index kept as placeholders only and did not decide page membership.`);
      setStatus(`${sourceLabel(source)} live browsing failed. Cache cannot decide page order or membership. Please try again.`);
    setBrowseCardsLive(false);
    reportTaskProgress(`Load ${sourceLabel(source)}`, 100, "Live unavailable; cache fallback blocked by policy.");
  }



  async function loadModWorkshopLivePage(reset = false, requestedSort: SortMode = sortMode, targetPage?: number) {
    if (loadingSource && loadingSource !== "modworkshop") return;
    if (!reset && !hasMore.modworkshop && !targetPage) return;

    const requestId = ++browseRequestSeqRef.current;
    const previousPage = Math.max(1, pages.modworkshop || 1);
    const nextPage = Math.max(1, targetPage ?? (reset ? 1 : pages.modworkshop + 1));
    const replacePage = true;

    let watchdog: number | null = null;

    if (reset) {
      setActiveModWorkshopSearch("");
      setModWorkshopSearchPage(0);
      setSearchQuery("");
      setHasMore((current) => ({ ...current, modworkshop: true }));
      setCacheNote("ModWorkshop page mode: keeping current cards visible while loading page 1.");
      setBrowseCardsLive(false);
    }

    setPages((current) => ({ ...current, modworkshop: nextPage }));
    setLoadingSource("modworkshop");
    setStatus(`Loading ModWorkshop PAYDAY 3 page ${nextPage}...`);
    reportTaskProgress("Load ModWorkshop", reset ? 8 : 38, `Public page ${nextPage}`);

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
        { page: nextPage, sort: requestedSort },
        30_000,
        "ModWorkshop public live page timed out.",
      );

      if (requestId !== browseRequestSeqRef.current) return;

      const cleaned = cleanMods(loaded).filter((mod) => mod.source === "modworkshop").slice(0, 48);

      if (cleaned.length === 0) {
        if (reset || nextPage <= 1) {
          await loadSourceIndexFallback("modworkshop", reset, `ModWorkshop page ${nextPage} returned zero PAYDAY 3 cards.`, requestedSort);
          return;
        }

      setHasMore((current) => ({ ...current, modworkshop: false }));
        setCacheNote(`ModWorkshop live page ${nextPage} returned no cards. Source-index fallback was not used for live pagination.`);
        setStatus(`ModWorkshop page ${nextPage} returned no live PAYDAY 3 cards. Stopped at the end of the live listing.`);
        setBrowseCardsLive(false);
        return;
      }

      setMods((current) => {
        const base = replacePage ? current.filter((mod) => mod.source !== "modworkshop") : current;
        return [...base, ...cleaned];
      });

      setHasMore((current) => ({ ...current, modworkshop: true }));
      setBrowseCardsLive(true);
      setCacheNote(`ModWorkshop page mode · Page ${nextPage} · ${cleaned.length} live cards · cache bypassed.`);
      setStatus(`Loaded ModWorkshop page ${nextPage}: ${cleaned.length} PAYDAY 3 mod cards.`);
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

  async function loadPage(source: BrowseTab = activeTab, reset = false, requestedSort: SortMode = sortMode) {
    if (source === "modworkshop") {
      await loadModWorkshopLivePage(reset, requestedSort);
      return;
    }

    // After the early ModWorkshop return, this generic loader is Nexus-only.
    // Keeping old source === "modworkshop" checks here made TypeScript narrow
    // source to "nexus" and reject those dead branches during release build.
    if (source === "nexus" && nexusApiKeyMissing) {
      setStatus("Nexus browsing needs an API key. Add one in Settings → Sources.");
      setHasMore((current) => ({ ...current, nexus: false }));
      return;
    }

    if (loadingSource && loadingSource !== source) return;
    if (!reset && !hasMore[source]) return;

    if (activeNexusSearch.trim() && !reset) {
      setHasMore((current) => ({ ...current, nexus: false }));
      setStatus("Nexus search results are loaded as one ranked set. Clear search or press Refresh for normal browsing.");
      return;
    }

    if (reset) {
      setActiveNexusSearch("");
    }

    const requestId = ++browseRequestSeqRef.current;
    const nextPage = reset ? 1 : pages[source] + 1;
    setLoadingSource(source);
    if (reset) {
      // Keep current cards visible until live/fallback cards are ready.
      setCacheNote("");
      setBrowseCardsLive(false);
    }
    reportTaskProgress(`Load ${sourceLabel(source)}`, reset ? 8 : 34, `Page ${nextPage}`);
    setStatus(`Loading live Nexus page ${nextPage} through GraphQL first...`);

    try {
      const loaded = await invokeWithTimeout<SourceModSummary[]>(
        "fetch_source_mods_page",
        { source, page: nextPage, sort: requestedSort },
        reset ? 9000 : 12000,
        `${sourceLabel(source)} live request timed out.`,
      );

      if (requestId !== browseRequestSeqRef.current) return;

      const cleaned = sortBrowseMods(cleanMods(loaded).filter((mod) => mod.source === source), requestedSort);

      if (cleaned.length === 0) {
        await loadSourceIndexFallback(source, reset, "Backend returned zero cards.", requestedSort);
        return;
      }

      setMods((current) => {
        const base = reset ? current.filter((mod) => mod.source !== source) : current;
        const merged = sortBrowseMods(cleanMods([...base, ...cleaned]), requestedSort);
        writeCache(source, requestedSort, merged.filter((mod) => mod.source === source), nextPage, cleaned.length > 0);
        return merged;
      });

      setPages((current) => ({ ...current, [source]: nextPage }));
      setHasMore((current) => ({ ...current, [source]: cleaned.length >= 20 }));
      setBrowseCardsLive(true);
      setCacheNote("");
      setStatus(`Loaded ${cleaned.length} live/sorted ${sourceLabel(source)} mods.`);
      recordCachePolicyDiagnostic({
        browseDataSource: "live",
        detailDataSource: "unchanged",
        fileListDataSource: "unchanged",
        cacheFallbackReason: "none",
      });
      reportTaskProgress(`Load ${sourceLabel(source)}`, 100, `Loaded ${cleaned.length} live cards.`);
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

  function handleSortChange(nextSort: SortMode) {
    setSortMode(nextSort);
    setCacheNote(`Sorted visible ${sourceLabel(activeTab)} cards by ${nextSort}.`);

    if (activeTab === "modworkshop") {
      setStatus(`Sorted visible ModWorkshop cards by ${nextSort}. Press Refresh only when you want a live reload.`);
      return;
    }

    setActiveNexusSearch("");
    setPages((current) => ({ ...current, [activeTab]: 0 }));
    setHasMore((current) => ({ ...current, [activeTab]: true }));
    browseRequestSeqRef.current += 1;
    void loadPage(activeTab, true, nextSort);
  }

  async function testModWorkshopLive() {
    setLoadingSource("modworkshop");
    setStatus("Testing ModWorkshop public live/API routes...");
    setCacheNote("Running ModWorkshop live diagnostic...");
    try {
      const result = await invoke<string>("diagnose_modworkshop_browse_live");
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

  function refresh() {
    try {
      // Keep the visible/cache cards as a safety net while live requests reload.
      // Clearing the cache first made both sources go blank when a route returned zero.
    } catch {
      // optional cache
    }
    if (activeTab === "modworkshop") {
      setActiveModWorkshopSearch("");
      setModWorkshopSearchPage(0);
    }

    if (activeTab === "nexus") {
      setActiveNexusSearch("");
    }
    setPages((current) => ({ ...current, [activeTab]: 0 }));
    setHasMore((current) => ({ ...current, [activeTab]: true }));
    // Do not wipe visible cards before the replacement data arrives.
    setCacheNote(activeTab === "modworkshop" ? "Reloading ModWorkshop cards while keeping the current library visible..." : "Reloading cards while keeping the current library visible...");
    if (activeTab === "modworkshop") {
      reportTaskProgress("Refresh ModWorkshop", 5, "Loading public PAYDAY 3 game page without blanking the current view...");
      void loadModWorkshopLivePage(true, sortMode, 1);
      return;
    }

    browseRequestSeqRef.current += 1;
    reportTaskProgress(`Refresh ${sourceLabel(activeTab)}`, 5, "Loading live/fallback cards without blanking the current view...");
    void loadPage(activeTab, true);
  }

  async function applyFastModWorkshopSearchResults(query: string, page: number, reset: boolean) {
    const cacheKey = `${query.toLowerCase()}::${page}::${sortMode}`;
    const cached = modWorkshopSearchCacheRef.current.get(cacheKey);
    const localMatches = cached ?? orderBrowseModsForSource(mods, "modworkshop", sortMode)
      .filter((mod) => modMatchesQuery(mod, query));
    const cleaned = sortBrowseMods(cleanMods(localMatches).filter((mod) => mod.source === "modworkshop"), sortMode).slice(0, 72);

    if (cleaned.length === 0) return false;

    setMods((current) => {
      const existing = reset ? current.filter((mod) => mod.source !== "modworkshop") : current;
      const merged = sortBrowseMods(cleanMods([...existing, ...cleaned]), sortMode);
      writeCache("modworkshop", sortMode, merged.filter((mod) => mod.source === "modworkshop"), page, false);
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
    setCacheNote(`Cleared search and filters for ${sourceLabel(activeTab)}.`);

    if (activeTab === "modworkshop") {
      setStatus("Cleared ModWorkshop search. Loading live public listing page 1.");
      void loadModWorkshopLivePage(true, sortMode, 1);
      return;
    }

    setStatus("Cleared Nexus search. Reloading normal Nexus browse cards.");
    await loadPage("nexus", true);
  }


  async function searchModWorkshopPage(query: string, page: number, reset: boolean) {
    const cleanQuery = query.trim();
    if (cleanQuery.length < 2) {
      await clearActiveSourceSearch();
      return;
    }

    setActiveTab("modworkshop");
    setSearchQuery(cleanQuery);
    setSourceSearching(true);
    setLoadingSource("modworkshop");
    setStatus(`Searching ModWorkshop for "${cleanQuery}"...`);

    try {
      await applyFastModWorkshopSearchResults(cleanQuery, page, reset);

      setStatus(`Searching ModWorkshop live routes for "${cleanQuery}"...`);
      const cacheKey = `${cleanQuery.toLowerCase()}::${page}::${sortMode}`;
      const cached = modWorkshopSearchCacheRef.current.get(cacheKey);
      const results = cached ?? await invokeWithTimeout<SourceModSummary[]>("search_modworkshop_mods_for_query", { query: cleanQuery, page }, 16000, "ModWorkshop search timed out.");
      if (!cached && results.length > 0) {
        modWorkshopSearchCacheRef.current.set(cacheKey, results);
      }
      let cleaned = cleanMods(results).filter((mod) => mod.source === "modworkshop");

      if (cleaned.length === 0) {
        const fallbackHits: SourceModSummary[] = [];
        for (let browsePage = 1; browsePage <= 2 && fallbackHits.length < 24; browsePage += 1) {
          const pageMods = await invoke<SourceModSummary[]>("fetch_modworkshop_browse_live_page", { page: browsePage, sort: sortMode }).catch(() => []);
          for (const mod of pageMods) {
            if (modMatchesQuery(mod, cleanQuery) && !fallbackHits.some((existing) => existing.sourceId === mod.sourceId)) {
              fallbackHits.push(mod);
            }
          }
        }

        cleaned = cleanMods(fallbackHits).filter((mod) => mod.source === "modworkshop").slice(0, 36);
      }

      setMods((current) => {
        // Do not blank the library on zero-result live searches.
        const existing = reset && cleaned.length > 0 ? current.filter((mod) => mod.source !== "modworkshop") : current;
        const merged = cleanMods([...existing, ...cleaned]);
        writeCache("modworkshop", sortMode, merged.filter((mod) => mod.source === "modworkshop"), page, cleaned.length > 0);
        return merged;
      });

      setActiveModWorkshopSearch(cleanQuery);
      setModWorkshopSearchPage(page);
      setPages((current) => ({ ...current, modworkshop: page }));
      setHasMore((current) => ({ ...current, modworkshop: cleaned.length > 0 }));
      setStatus(
        cleaned.length > 0
          ? `${reset ? "Found" : "Loaded"} ${cleaned.length} ModWorkshop live result(s) for "${cleanQuery}" page ${page}.`
          : `No ModWorkshop live results for "${cleanQuery}". Kept the current library visible.`
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

  async function searchNexus() {
    const query = sourceSearchQuery.trim();

    if (nexusApiKeyMissing) {
      setStatus("Nexus search needs an API key. Add one in Settings → Sources.");
      return;
    }

    if (query.length < 2) {
      setSearchQuery("");
      setActiveNexusSearch("");
      setStatus("Cleared Nexus search. Loading normal Nexus browse page.");
      await loadPage("nexus", true);
      return;
    }

    setActiveTab("nexus");
    setSourceSearching(true);
    setLoadingSource("nexus");
    reportTaskProgress("Nexus search", 15, query);
    setStatus(`Searching Nexus for "${query}" through GraphQL/search fallback...`);

    try {
      const results = await invokeWithTimeout<SourceModSummary[]>("search_nexus_mods_for_query", { query }, 10000, "Nexus search timed out.");
      reportTaskProgress("Nexus search", 78, `Found ${results.length} raw result(s).`);
      const cleaned = sortBrowseMods(cleanMods(results).filter((mod) => mod.source === "nexus"), "updated");

      setMods((current) => {
        const existing = current.filter((mod) => mod.source !== "nexus");
        const merged = sortBrowseMods(cleanMods([...existing, ...cleaned]), sortMode);
        writeCache("nexus", sortMode, merged.filter((mod) => mod.source === "nexus"), 1, false);
        return merged;
      });

      setActiveNexusSearch(query);
      setPages((current) => ({ ...current, nexus: 1 }));
      setHasMore((current) => ({ ...current, nexus: false }));
      setStatus(
        cleaned.length > 0
          ? `Found ${cleaned.length} Nexus result(s) for "${query}".`
          : `No Nexus search results for "${query}". Try fewer words, then Rebuild Nexus if it is still missing.`
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSourceSearching(false);
      setLoadingSource(null);
      clearTaskProgress();
    }
  }

  function searchActiveSource() {
    if (activeTab === "nexus") void searchNexus();
    else void searchModWorkshop();
  }

  async function fetchDetailForMod(mod: SourceModSummary) {
    const detail =
      mod.source === "nexus"
        ? await invokeWithTimeout<SourceModDetail>("fetch_nexus_mod_detail", { modId: mod.sourceId }, 6500, "Nexus detail timed out.")
        : await invokeWithTimeout<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: mod.sourceId }, 6500, "ModWorkshop detail timed out.");

    const safe = safeDetail(detail, "live");
    writeDetailCache(safe);
    return safe;
  }

  async function openMod(mod: SourceModSummary) {
    const loadingKey = `${mod.source}-${mod.sourceId}`;
    const cached = readDetailCache(mod);

    setSelectedMod(cached ?? fallbackDetail(mod));
    setSourceDetailTab("description");
    setView("detail");
    reportTaskProgress("Open mod page", cached ? 35 : 15, mod.name);
    setDetailLoadingKey(loadingKey);
    setStatus(cached ? `Opened cached ${mod.name}. Refreshing source page quietly...` : `Opening ${mod.name}. Loading full source page...`);
    recordCachePolicyDiagnostic({
      browseDataSource: "unchanged",
      detailDataSource: cached ? "cache-placeholder" : "fallback-placeholder",
      fileListDataSource: "unavailable",
      cacheFallbackReason: cached ? "temporary cached detail metadata while live detail loads" : "basic placeholder while live detail loads",
    });

    try {
      reportTaskProgress("Open mod page", 55, "Loading source details...");
      const detail =
        mod.source === "nexus"
          ? await invokeWithTimeout<SourceModDetail>("fetch_nexus_mod_detail", { modId: mod.sourceId }, 6500, "Nexus detail timed out. Showing cached/basic page so the app stays responsive.")
          : await invokeWithTimeout<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: mod.sourceId }, 6500, "ModWorkshop detail timed out. Showing cached/basic page so the app stays responsive.");

      const safe = safeDetail(detail, "live");
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
        shortDescription: cleanDescription(safe.shortDescription || safe.description || item.shortDescription || "") || item.shortDescription,
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
          ? await invoke<SourceModDetail>("fetch_nexus_mod_detail", { modId: current.sourceId })
          : await invoke<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: current.sourceId });

      const safe = safeDetail(detail, "live");
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
        shortDescription: cleanDescription(safe.shortDescription || safe.description || item.shortDescription || "") || item.shortDescription,
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
      });

      setResults((current) => [result, ...current].slice(0, 10));
      reportTaskProgress("Download mod", 52, `Downloaded ${file.name}`);

      if (!result.canInstallLater) {
        setStatus(`Downloaded ${file.name}, but install is blocked for review.`);
        reportTaskProgress("Install failed", 100, "No installable files detected.");
        return;
      }

      setStatus(`Installing ${file.name} into detected PAYDAY 3 paths...`);
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

      await stageFile(detail, files[0], match.matchedFiles);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function openInstall(mod: SourceModSummary) {
    setResults([]);
    setStatus(`Loading files for ${mod.name}...`);

    try {
      const safeDetail = await fetchDetailForMod(mod);
      if (!hasLiveFileData(safeDetail)) {
        setSelectedMod(safeDetail);
        setSourceDetailTab("files");
        setView("detail");
        setStatus(liveFileDataUnavailableMessage());
        return;
      }

      const files = installableFiles(safeDetail.files, safeDetail.source);

      if (files.length === 0) {
        setSelectedMod(safeDetail);
        setSourceDetailTab("files");
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
    if (!hasLiveFileData(installPickerMod)) {
      setStatus(liveFileDataUnavailableMessage());
      setInstallPickerMod(null);
      return;
    }
    const match = sourceMatches[`${installPickerMod.source}-${installPickerMod.sourceId}`] ?? null;
    const files = installableFiles(installPickerMod.files, installPickerMod.source)
      .filter((file) => selectedFileIds.includes(file.id))
      .filter((file) => matchedFileNamesForSourceFile(file, match).length === 0);
    for (const file of files) await stageFile(installPickerMod, file);
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
  }, [activeTab, sourceMods.length, sourceSearching, activeModWorkshopSearch, activeNexusSearch]);

  useEffect(() => {
    const cached = activeTab === "modworkshop" ? null : readCache(activeTab, sortMode);

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
      // Do not wipe visible cards before the replacement data arrives.
      setCacheNote("");
      setStatus(`Loading live ${sourceLabel(activeTab)} results...`);
      setBrowseCardsLive(false);
    }

    if (activeTab === "modworkshop") void loadModWorkshopLivePage(true, sortMode, 1);
    else void loadPage(activeTab, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, sortMode]);


  function backToBrowseList() {
    const detailSource = selectedMod?.source ?? activeTab;
    setView("list");
    setSelectedMod(null);

    const visibleForSource = sourceMods.filter((mod) => mod.source === detailSource).length;
    if (visibleForSource <= 1) {
      setActiveTab(detailSource);
      window.setTimeout(() => {
        if (detailSource === "modworkshop") void loadModWorkshopLivePage(true, sortMode, 1);
        else void loadPage(detailSource, true);
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
    const pageFlavor = "Source detail";
    const heroImage = selectedMod.bannerUrl ?? selectedMod.thumbnailUrl;
    const galleryImages = (selectedMod.images ?? [])
      .filter((image) => canUseThumbnail(image.imageUrl || image.thumbnailUrl))
      .slice(0, 8);
    const descriptionBlocks = descriptionParagraphs(selectedMod.description || selectedMod.shortDescription || "").slice(0, 36);
    const changelogBlocks = descriptionParagraphs(selectedMod.changelog || "").filter((line) => line !== "No description loaded.");
    const commentBlocks = (selectedMod.comments ?? []).map(cleanDescription).filter(Boolean).slice(0, 8);
    const logBlocks = (selectedMod.logs ?? []).map(cleanDescription).filter(Boolean).slice(0, 8);
    const statItems = [
      selectedMod.updatedAt ? { label: "Updated", value: sourceUpdatedLabel(selectedMod as SourceModSummary) ?? String(selectedMod.updatedAt) } : null,
      typeof selectedMod.downloads === "number" ? { label: "Downloads", value: selectedMod.downloads.toLocaleString() } : null,
      typeof selectedMod.likes === "number" ? { label: "Likes", value: selectedMod.likes.toLocaleString() } : null,
      selectedMod.version ? { label: "Version", value: selectedMod.version } : null,
      ...((selectedMod.stats ?? []).slice(0, 4)),
    ].filter(Boolean) as Array<{ label: string; value: string }>;

    return (
      <section className={`page browse-page safe-browse-page source-detail-page source-detail-${selectedMod.source}`}>
        <div className="source-page-shell">
          <div className="source-page-nav">
            <button className="ghost-button compact" type="button" onClick={backToBrowseList}>
              ← Back to Browse
            </button>
            <span>{pageFlavor}</span>
          </div>

          <div className="source-detail-hero card">
            <div className="source-detail-hero-media">
              {canUseThumbnail(heroImage) ? (
                <img
                  src={heroImage ?? ""}
                  alt=""
                  loading="lazy"
                  onError={() => markThumbnailFailed(heroImage)}
                />
              ) : (
                <div className="source-detail-fallback">{thumbnailFallbackText(selectedMod.source)}</div>
              )}
            </div>

            <div className="source-detail-hero-copy">
              <p className="eyebrow">{detailSourceName}</p>
              <h1>{displayModTitle(selectedMod)}</h1>
              <p>{selectedMod.shortDescription || "Source mod page."}</p>
              <div className="safe-badge-row source-detail-badges">
                <span className="status-pill">{detailSourceName}</span>
                {displayAuthor(selectedMod) && <span className="status-pill">by {displayAuthor(selectedMod)}</span>}
                {selectedMod.updatedAt && <span className="status-pill">{sourceUpdatedLabel(selectedMod as SourceModSummary)}</span>}
                {typeof selectedMod.downloads === "number" && <span className="status-pill">{selectedMod.downloads.toLocaleString()} downloads</span>}
                {loadingThisDetail && <span className="status-pill">loading full page...</span>}
                {!liveFileData && <span className="status-pill">live files unavailable</span>}
              </div>
            </div>

            <div className="source-detail-actions">
              <button className="ghost-button compact" type="button" onClick={() => openWebsite(selectedMod.pageUrl)}>
                Open {detailSourceName}
              </button>
              {liveFileData && selectedMatch?.installed && selectedMatch.updateAvailable ? (
                <button className="ghost-button compact update-button" type="button" onClick={() => updateInstalledSource(selectedMod, selectedMatch)} disabled={installingKey !== null}>
                  {installingKey ? "Updating..." : "Update"}
                </button>
              ) : selectedMatch?.installed ? (
                <button className="ghost-button compact danger-button" type="button" onClick={() => uninstallMatchedSource(selectedMatch)} disabled={installingKey !== null}>
                  {installingKey?.endsWith("-uninstall") ? "Uninstalling..." : "Uninstall"}
                </button>
              ) : liveFileData && files.length === 1 ? (
                <button className="ghost-button compact install-button" type="button" onClick={() => stageFile(selectedMod, files[0])} disabled={installingKey !== null}>
                  {installingKey ? "Installing..." : "Install"}
                </button>
              ) : null}
              <button className="ghost-button compact" type="button" onClick={refreshSelectedDetail} disabled={detailLoadingKey !== null}>
                {detailLoadingKey ? "Refreshing..." : "Refresh page data"}
              </button>
              <button className="ghost-button compact" type="button" onClick={() => setInstallPickerMod({ ...selectedMod, files })} disabled={!liveFileData || files.length === 0}>
                Files
              </button>
            </div>
          </div>

          <div className="source-detail-grid-v2">
            <main className="source-detail-main-stack source-detail-tabbed-main">
              <article className="card source-content-card source-tabbed-panel">
                <div className="mod-page-tabs source-page-tabs">
                  {([
                    ["description", "Description"],
                    ["files", `Files ${files.length}`],
                    ["changelog", `Changelog ${changelogBlocks.length + logBlocks.length}`],
                    ["comments", `Comments ${commentBlocks.length}`],
                    ["images", `Images ${galleryImages.length}`],
                  ] as Array<[typeof sourceDetailTab, string]>).map(([id, label]) => (
                    <button className={`mod-page-tab ${sourceDetailTab === id ? "active" : ""}`} key={id} type="button" onClick={() => setSourceDetailTab(id)}>
                      {label}
                    </button>
                  ))}
                </div>

                {sourceDetailTab === "description" && (
                  <div className="source-tab-pane source-description-prose">
                    <div className="section-title-row">
                      <div>
                        <p className="eyebrow">Overview</p>
                        <h2>Description</h2>
                      </div>
                      <span className="status-pill">{selectedMod.source === "modworkshop" ? "ModWorkshop" : "Nexus"}</span>
                    </div>
                    {descriptionBlocks.map((paragraph, index) => <p key={`desc-${index}`}>{renderLinkedText(paragraph, openWebsite)}</p>)}
                  </div>
                )}

                {sourceDetailTab === "files" && (
                  <div className="source-tab-pane source-downloads-expanded-list source-downloads-tab-pane">
                    <div className="section-title-row">
                      <div>
                        <p className="eyebrow">Downloads</p>
                        <h2>Files</h2>
                      </div>
                      <span className="status-pill">{files.length} installable</span>
                    </div>
                    {!liveFileData && <p>{liveFileDataUnavailableMessage()}</p>}
                    {([
                      ["main", "Main files"],
                      ["optional", "Optional files"],
                      ["old", "Old versions"],
                    ] as Array<[SourceFileBucket, string]>).filter(([bucket]) => bucket !== "old" || fileGroups.old.length > 0).map(([bucket, label]) => (
                      <div className={`source-downloads-expanded-group ${bucket}`} key={bucket}>
                        <div className="source-downloads-group-heading">
                          <h3>{label}</h3>
                          <span className="status-pill">{fileGroups[bucket].length}</span>
                        </div>
                        {fileGroups[bucket].map((file) => {
                          const matchedNames = matchedFileNamesForSourceFile(file, selectedMatch);
                          const installed = matchedNames.length > 0;
                          const disabled = matchedNames.some((name) => /\.disabled$/i.test(name));
                          return (
                            <div className={`source-download-detail-row source-download-action-row ${installed ? "installed" : ""}`} key={`${bucket}-${file.id}`}>
                              <div>
                                <strong>{file.name}</strong>
                                <span>{sourceFileMetaLine(file)}</span>
                              </div>
                              {installed ? (
                                <div className="source-file-row-actions">
                                  {selectedMatch && <button className="ghost-button compact" type="button" onClick={() => openSourceFileNamesLocation(selectedMatch, matchedNames)} disabled={installingKey !== null}>Open File Location</button>}
                                  <button className="ghost-button compact" type="button" onClick={() => setSourceFileNamesEnabled(matchedNames, disabled)} disabled={installingKey !== null}>{disabled ? "Enable" : "Disable"}</button>
                                  <button className="ghost-button compact danger-button" type="button" onClick={() => uninstallSourceFileNames(matchedNames)} disabled={installingKey !== null}>Uninstall</button>
                                </div>
                              ) : (
                                <button className="ghost-button compact install-button" type="button" onClick={() => stageFile(selectedMod, file)} disabled={installingKey !== null}>
                                  {installingKey === fileKey(selectedMod, file) ? "Installing..." : "Install"}
                                </button>
                              )}
                              <MiniProgress active={installingKey === fileKey(selectedMod, file)} />
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}

                {sourceDetailTab === "changelog" && (
                  <div className="source-tab-pane source-notes-list">
                    <div className="section-title-row">
                      <div>
                        <p className="eyebrow">Updates</p>
                        <h2>Changelog / logs</h2>
                      </div>
                    </div>
                    {[...changelogBlocks, ...logBlocks].length ? [...changelogBlocks, ...logBlocks].slice(0, 24).map((entry, index) => <p key={`log-${index}`}>{entry}</p>) : (
                      <div className="source-empty-tab-actions">
                        <p>No changelog was exposed by the current public source payload yet.</p>
                        <button className="ghost-button compact" type="button" onClick={() => openWebsite(selectedMod.pageUrl)}>Open source changelog</button>
                      </div>
                    )}
                  </div>
                )}

                {sourceDetailTab === "comments" && (
                  <div className="source-tab-pane source-comment-list">
                    <div className="section-title-row">
                      <div>
                        <p className="eyebrow">Community</p>
                        <h2>Comments</h2>
                      </div>
                      <span className="status-pill">{commentBlocks.length}</span>
                    </div>
                    {commentBlocks.length ? commentBlocks.map((comment, index) => <p key={`comment-${index}`}>{comment}</p>) : (
                      <div className="source-empty-tab-actions">
                        <p>Comments are not exposed by the current public source payload yet.</p>
                        <button className="ghost-button compact" type="button" onClick={() => openWebsite(selectedMod.pageUrl)}>Open source comments</button>
                      </div>
                    )}
                  </div>
                )}

                {sourceDetailTab === "images" && (
                  <div className="source-tab-pane">
                    <div className="section-title-row">
                      <div>
                        <p className="eyebrow">Images</p>
                        <h2>Gallery</h2>
                      </div>
                      <span className="status-pill">{galleryImages.length} loaded</span>
                    </div>
                    <div className="source-image-grid">
                      {galleryImages.map((image) => (
                        <button className="source-image-tile" type="button" key={image.id} onClick={() => openWebsite(image.imageUrl)}>
                          <img src={image.thumbnailUrl ?? image.imageUrl} alt={image.title ?? selectedMod.name} loading="lazy" onError={() => markThumbnailFailed(image.thumbnailUrl ?? image.imageUrl)} />
                        </button>
                      ))}
                      {galleryImages.length === 0 && <p>No images exposed by this source yet.</p>}
                    </div>
                  </div>
                )}
              </article>
            </main>

            <aside className="source-detail-side-stack">
              <article className="card safe-files-card source-files-card-v2">
                <div className="safe-files-header">
                    <p className="eyebrow">Downloads</p>
                    <h2>{selectedMod.source === "modworkshop" ? "Files" : "Nexus files"}</h2>
                  <span className="status-pill">{files.length} files</span>
                </div>

                <div className="source-file-buckets">
                  {!liveFileData && <p>{liveFileDataUnavailableMessage()}</p>}
                  {([
                    ["main", "Main files"],
                    ["optional", "Optional files"],
                    ["old", "Old versions"],
                  ] as Array<[SourceFileBucket, string]>).filter(([bucket]) => bucket !== "old" || fileGroups.old.length > 0).map(([bucket, label]) => (
                    <div className={`source-file-bucket source-file-bucket-${bucket}`} key={bucket}>
                      <div className="source-file-bucket-heading">
                        <div>
                          <h3>{label}</h3>
                        </div>
                        <span className="status-pill">{fileGroups[bucket].length}</span>
                      </div>
                      <div className="safe-file-list source-file-list-v2">
                        {fileGroups[bucket].map((file) => {
                          const matchedNames = matchedFileNamesForSourceFile(file, selectedMatch);
                          const installed = matchedNames.length > 0;
                          const disabled = matchedNames.some((name) => /\.disabled$/i.test(name));
                          return (
                            <div className="safe-file-row source-file-row-v2" key={file.id}>
                              <div>
                                <strong title={file.name}>{file.name}</strong>
                                <p>{sourceFileMetaLine(file)}</p>
                              </div>
                              {installed ? (
                                <div className="source-file-row-actions">
                                  {selectedMatch && <button className="ghost-button compact" type="button" onClick={() => openSourceFileNamesLocation(selectedMatch, matchedNames)} disabled={installingKey !== null}>Open File Location</button>}
                                  <button className="ghost-button compact" type="button" onClick={() => setSourceFileNamesEnabled(matchedNames, disabled)} disabled={installingKey !== null}>{disabled ? "Enable" : "Disable"}</button>
                                  <button className="ghost-button compact danger-button" type="button" onClick={() => uninstallSourceFileNames(matchedNames)} disabled={installingKey !== null}>Uninstall</button>
                                </div>
                              ) : (
                                <button className="ghost-button compact install-button" type="button" onClick={() => stageFile(selectedMod, file)} disabled={installingKey !== null}>
                                  {installingKey === fileKey(selectedMod, file) ? "Installing..." : "Install"}
                                </button>
                              )}
                              <MiniProgress active={installingKey === fileKey(selectedMod, file)} />
                            </div>
                          );
                        })}
                        {fileGroups[bucket].length === 0 && <p className="source-file-empty">No {label.toLowerCase()} exposed by this source.</p>}
                      </div>
                    </div>
                  ))}
                  {files.length === 0 && <p>No files exposed by this source yet.</p>}
                </div>
              </article>

              <article className="card source-meta-card">
                <p className="eyebrow">Page info</p>
                <h2>Details</h2>
                <div className="source-meta-list">
                  {statItems.map((item) => (
                    <div key={`${item.label}-${item.value}`}>
                      <span>{item.label}</span>
                      <strong>{item.value}</strong>
                    </div>
                  ))}
                  {!statItems.length && <p>No extra page stats loaded yet.</p>}
                </div>
              </article>

              {(selectedMod.tags ?? []).length > 0 && (
                <article className="card source-tag-card">
                  <p className="eyebrow">Tags</p>
                  <div className="safe-badge-row">
                    {(selectedMod.tags ?? []).slice(0, 18).map((tag) => <span className={tagClassName(tag)} key={tag}>{tag}</span>)}
                  </div>
                </article>
              )}
            </aside>
          </div>
        </div>

        {results.length > 0 && <div className="card safe-results">{results.map((result, index) => <ResultNotice result={result} key={`${result.fileName}-${index}`} />)}</div>}

        {installPickerMod && (
          <InstallPicker
            mod={installPickerMod}
            match={sourceMatches[`${installPickerMod.source}-${installPickerMod.sourceId}`] ?? null}
            selectedFileIds={selectedFileIds}
            setSelectedFileIds={setSelectedFileIds}
            installingKey={installingKey}
            onClose={() => setInstallPickerMod(null)}
            onInstallOne={stageFile}
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

  return (
    <section className="page browse-page safe-browse-page">
      <div className="browse-hero card">
        <div>
          <p className="eyebrow">Source browser</p>
          <h1>Browse</h1>
          <p className="page-description">Search Nexus Mods and ModWorkshop from one clean mod browser.</p>
        </div>

        <div className="browse-source-switcher">
          <button
            className={`source-tab ${activeTab === "modworkshop" ? "active" : ""}`}
            type="button"
            onClick={() => {
              setActiveTab("modworkshop");
              setSourceSearchQuery("");
            }}
          >
            ModWorkshop
          </button>
          <button
            className={`source-tab ${activeTab === "nexus" ? "active" : ""}`}
            type="button"
            onClick={() => {
              setActiveTab("nexus");
              setSourceSearchQuery("");
            }}
          >
            Nexus Mods
          </button>
        </div>
      </div>

      <div className="browse-toolbar card">
        <div>
          <h2>{sourceLabel(activeTab)}</h2>
          <p>{loadingSource === activeTab ? `Loading ${sourceLabel(activeTab)}...` : `${sourceMods.length} mods loaded.`}</p>
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
                if (value.trim() === "") {
                  setSearchQuery("");
                  setActiveModWorkshopSearch("");
                  setActiveNexusSearch("");
                  setStatus(`Showing normal ${sourceLabel(activeTab)} browse results.`);
                }
              }}
              placeholder="Search PAYDAY 3 mods..."
            />
            <button className="ghost-button" type="submit" disabled={sourceSearching || (activeTab === "nexus" && nexusApiKeyMissing)}>
              {sourceSearching ? "Searching..." : "Search"}
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

          {activeTab === "nexus" && (
            <div className="sort-chip-row" aria-label="Sort Nexus mods">
              {sortOptions.map((option) => (
                <button
                  className={`sort-chip ${sortMode === option.id ? "active" : ""}`}
                  type="button"
                  key={option.id}
                  onClick={() => handleSortChange(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}



          <button className="ghost-button" type="button" onClick={refresh} disabled={activeTab === "nexus" && nexusApiKeyMissing}>Refresh</button>
        </div>
      </div>

      {activeTab === "nexus" && nexusApiKeyMissing && (
        <div className="safe-result warning">
          <strong>Nexus API key required</strong>
          <span>Add a Nexus API key in Settings → Sources before browsing or searching Nexus Mods.</span>
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

      <div className="source-mod-grid cleaner-grid">
        {sourceMods.map((mod) => (
          <article
            className="source-mod-card cleaner-card"
            key={`${mod.source}-${mod.sourceId}`}
            role="button"
            tabIndex={0}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("button, summary, details, input, select, a")) return;
              void openMod(mod);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void openMod(mod);
            }}
          >
            <button className="source-mod-thumb cleaner-thumb" type="button" onClick={() => openMod(mod)}>
              {canUseThumbnail(mod.thumbnailUrl) ? (
                <img src={mod.thumbnailUrl ?? ""} alt="" loading="lazy" onError={() => markThumbnailFailed(mod.thumbnailUrl)} />
              ) : (
                <span className="generated-thumb-label">{thumbnailFallbackText(mod.source)}</span>
              )}
            </button>

            <div className="source-mod-body">
              <div className="source-mod-title-line">
                <strong>{cardDisplayTitle(mod)}</strong>
                <span>{sourceLabel(mod.source)}</span>
              </div>

              {cardDisplayDescription(mod) && <p className="source-card-description">{cardDisplayDescription(mod)}</p>}

              <div className="source-mod-meta">
                <span>{cardDisplayAuthor(mod) ? `by ${cardDisplayAuthor(mod)}` : mod.source === "modworkshop" ? "Author loading" : "Unknown author"}</span>
                {mod.version && <span>v{mod.version}</span>}
                {sourceUpdatedLabel(mod) && <span className="source-card-date">{sourceUpdatedLabel(mod)}</span>}
                {typeof mod.downloads === "number" && <span>{mod.downloads.toLocaleString()} downloads</span>}
                {typeof mod.likes === "number" && <span>{mod.likes.toLocaleString()} likes</span>}
              </div>

              <div className="source-tag-row visible-tags">
                {sourceMatches[`${mod.source}-${mod.sourceId}`]?.installed && <span className="status-pill installed-pill">Installed</span>}
                {(mod.tags?.length ? mod.tags : mergedCardTags(mod)).slice(0, 8).map((tag) => <span className={tagClassName(tag)} key={tag}>{tag}</span>)}
                {(mod.tags?.length ?? 0) === 0 && <span className="status-pill tag-pill tag-general">No tags cached</span>}
              </div>

              <div className="source-card-actions">
                {browseCardsLive && sourceMatches[`${mod.source}-${mod.sourceId}`]?.installed && sourceMatches[`${mod.source}-${mod.sourceId}`]?.updateAvailable ? (
                  <button
                    className="ghost-button compact update-button"
                    type="button"
                    onClick={() => updateInstalledSource(mod, sourceMatches[`${mod.source}-${mod.sourceId}`])}
                    disabled={installingKey !== null}
                  >
                    Update
                  </button>
                ) : sourceMatches[`${mod.source}-${mod.sourceId}`]?.installed ? (
                  <button
                    className="ghost-button compact danger-button"
                    type="button"
                    onClick={() => uninstallMatchedSource(sourceMatches[`${mod.source}-${mod.sourceId}`])}
                    disabled={installingKey !== null}
                  >
                    Uninstall
                  </button>
                ) : (
                  <button className="ghost-button compact install-button" type="button" onClick={() => openInstall(mod)} disabled={installingKey !== null}>Install</button>
                )}
                <CardMoreMenu>
                  <summary aria-label="More options">⋯</summary>
                  <div>
                    <button type="button" onClick={() => openWebsite(mod.pageUrl)}>Website</button>
                    <button type="button" onClick={() => openMod(mod)}>Open details</button>
                  </div>
                </CardMoreMenu>
              </div>
            </div>
          </article>
        ))}
      </div>

      <div className="safe-floating-controls" aria-label="Browse bottom controls">
        <button className="ghost-button compact" type="button" onClick={scrollBrowseToTop}>
          Back to Top
        </button>
        {activeTab === "modworkshop" ? (
          <>
            <button className="ghost-button compact" type="button" onClick={() => loadModWorkshopLivePage(false, sortMode, Math.max(1, pages.modworkshop - 1))} disabled={loadingSource !== null || pages.modworkshop <= 1}>
              Previous Page
            </button>
            <span className="safe-page-pill">Page {Math.max(1, pages.modworkshop)}</span>
            <button className="ghost-button compact" type="button" onClick={() => loadModWorkshopLivePage(false, sortMode, pages.modworkshop + 1)} disabled={loadingSource !== null || !hasMore.modworkshop}>
              {loadingSource === "modworkshop" ? "Loading..." : hasMore.modworkshop ? "Next Page" : "No More"}
            </button>
          </>
        ) : (
          <button className="ghost-button compact" type="button" onClick={() => loadPage(activeTab)} disabled={loadingSource !== null || !hasMore[activeTab]}>
            {loadingSource === activeTab ? "Loading..." : hasMore[activeTab] ? "Load More" : "No More"}
          </button>
        )}
      </div>

      {sourceMods.length === 0 && (
        <article className="card">
          <h2>No mods loaded</h2>
          <p>{status}</p>
          <button className="ghost-button" type="button" onClick={() => activeTab === "modworkshop" ? loadModWorkshopLivePage(true, sortMode, 1) : loadPage(activeTab, true)}>Try loading again</button>
        </article>
      )}

      {results.length > 0 && <div className="card safe-results">{results.map((result, index) => <ResultNotice result={result} key={`${result.fileName}-${index}`} />)}</div>}

      {installPickerMod && (
        <InstallPicker
          mod={installPickerMod}
          match={sourceMatches[`${installPickerMod.source}-${installPickerMod.sourceId}`] ?? null}
          selectedFileIds={selectedFileIds}
          setSelectedFileIds={setSelectedFileIds}
          installingKey={installingKey}
          onClose={() => setInstallPickerMod(null)}
          onInstallOne={stageFile}
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
          <button className="ghost-button compact install-button" type="button" onClick={onInstallSelected} disabled={installingKey !== null || selectedUninstalledCount === 0}>
            {installingKey ? "Installing..." : `Install Selected (${selectedUninstalledCount})`}
          </button>
        </div>

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
                        <button className="ghost-button compact install-button" type="button" onClick={() => onInstallOne(mod, file)} disabled={installingKey !== null}>
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

import "./BrowsePage.css";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
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

const SOURCE_CACHE_VERSION = "v1.07.25-workshop-title-card-cache";
const SOURCE_CACHE_TTL_MS = 1000 * 60 * 5;

const sortOptions: Array<{ id: SortMode; label: string }> = [
  { id: "recent", label: "Recent" },
  { id: "updated", label: "Updated" },
  { id: "added", label: "Added" },
  { id: "popular", label: "Popular" },
  { id: "downloads", label: "Downloads" },
  { id: "liked", label: "Liked" },
];

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

  // v1.0.7.23: ModWorkshop now carries parsed relative timestamps from the public page.
  // Sort by those timestamps so older/months-old cards cannot float to the top.
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
    const sorted = orderBrowseModsForSource(mods, source, sort).slice(0, 240);
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


const DETAIL_CACHE_VERSION = "v0.85-source-speed-thumbs";

function detailCacheKey(source: BrowseTab, id: string) {
  return `tsuki-source-detail:${DETAIL_CACHE_VERSION}:${source}:${id}`;
}

function safeDetail(detail: SourceModDetail): SourceModDetail {
  return {
    ...detail,
    tags: Array.isArray(detail.tags) ? detail.tags : [],
    files: Array.isArray(detail.files)
      ? (detail.source === "modworkshop" ? filterModWorkshopFileChoices(detail.files) : detail.files.filter(isInstallableSourceFile))
      : [],
    images: Array.isArray(detail.images) ? detail.images : [],
    logs: Array.isArray(detail.logs) ? detail.logs : [],
    stats: Array.isArray(detail.stats) ? detail.stats : [],
    description: cleanDescription(detail.description || detail.shortDescription || ""),
  };
}

function readDetailCache(mod: SourceModSummary): SourceModDetail | null {
  try {
    const raw = window.localStorage.getItem(detailCacheKey(mod.source, mod.sourceId));
    if (!raw) return null;
    return safeDetail(JSON.parse(raw) as SourceModDetail);
  } catch {
    return null;
  }
}

function writeDetailCache(detail: SourceModDetail) {
  try {
    window.localStorage.setItem(detailCacheKey(detail.source, detail.sourceId), JSON.stringify(detail));
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



function cleanDescription(text: string) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/=["']?\/?_nuxt\/[\s\S]*?PAYDAY\s*3/gi, "PAYDAY 3")
    .replace(/Description\s+Images\s+Downloads\s+(Changelog\s+)?Dependencies\s*&\s*Instructions/gi, "")
    .replace(/Images\s+Downloads\s+(Changelog\s+)?Dependencies\s*&\s*Instructions/gi, "")
    .replace(/Upload\s+Mod\s+Mods\s+Games\s+News\s+Discord\s+Forum/gi, "")
    .replace(/Rules\s+More\s+Wiki\s+Translations\s+Search\s+CTRL\s+K\s+Login\s+Register\s+Games/gi, "")
    .replace(/Install with Mod Organizer 2.*$/gim, "")
    .replace(/Don't have Mod Organizer 2\??/gim, "")
    .replace(/^[a-f0-9]{5,}\s+/gim, "")
    .replace(/\bDownloads?\s+\d+\b/gi, "")
    .replace(/\bViews\b/gi, "")
    .replace(/\s{2,}/g, " ")
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

function shortCardDescription(mod: SourceModSummary) {
  const detail = readDetailCache(mod);
  const detailText = detail ? descriptionParagraphs(detail.description).join(" ") : "";
  const summary = cleanDescription(mod.shortDescription || detailText || "");

  if (!summary || summary.toLowerCase().includes("loaded from the payday 3 modworkshop page")) {
    return detailText || "No description cached yet. Open or wait for background card enrichment.";
  }

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
  if (!readDetailCache(mod)) return true;
  if (!description) return true;
  if (description.toLowerCase().includes("loaded from the payday 3 modworkshop page")) return true;
  if (!mod.tags || mod.tags.length <= 1) return true;
  return false;
}
void needsCardEnrichment;


function cleanMods(mods: SourceModSummary[]) {
  const unique = new Map<string, SourceModSummary>();

  for (const mod of Array.isArray(mods) ? mods : []) {
    if (!mod?.source || !mod?.sourceId || !String(mod?.name ?? "").trim()) continue;
    if (mod.source !== "nexus" && mod.source !== "modworkshop") continue;

    const name = String(mod.name).trim();
    const lowered = name.toLowerCase();
    if (lowered === "unknown mod" || lowered === "untitled" || lowered.startsWith("nexus mod unknown")) continue;

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
      name,
      tags: Array.isArray(mod.tags) ? mod.tags : [],
    });
  }

  return [...unique.values()];
}

function fallbackDetail(mod: SourceModSummary): SourceModDetail {
  return {
    ...mod,
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
  const installable = newestFiles(files).filter(isInstallableSourceFile);
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
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sourceSearchQuery, setSourceSearchQuery] = useState("");
  const [activeModWorkshopSearch, setActiveModWorkshopSearch] = useState("");
  const [, setModWorkshopSearchPage] = useState(0);
  const [activeNexusSearch, setActiveNexusSearch] = useState("");
  const [sourceSearching, setSourceSearching] = useState(false);
  const [selectedMod, setSelectedMod] = useState<SourceModDetail | null>(null);
  const [detailLoadingKey, setDetailLoadingKey] = useState<string | null>(null);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [installPickerMod, setInstallPickerMod] = useState<SourceModDetail | null>(null);
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [results, setResults] = useState<StagedDownloadResult[]>([]);
  const [sourceMatches, setSourceMatches] = useState<Record<string, InstalledSourceMatch>>({});
  const [failedImages, setFailedImages] = useState<Record<string, number>>(() => readThumbnailFailures());
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [cacheNote, setCacheNote] = useState("");
  const browseRequestSeqRef = useRef(0);

  const modworkshopCategories = useMemo(() => {
    const common = ["all", "Gameplay", "HUD/UI", "Weapons", "Characters", "Audio", "Movies", "Tools", "PAYDAY 3"];
    const fromTags = cleanMods(mods)
      .filter((mod) => mod.source === "modworkshop")
      .flatMap((mod) => mod.tags ?? [])
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 1 && tag.length < 32);

    return Array.from(new Set([...common, ...fromTags])).slice(0, 40);
  }, [mods]);

  const sourceMods = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const category = categoryFilter.toLowerCase();

    return orderBrowseModsForSource(mods, activeTab, sortMode)
      .filter((mod) => {
        if (activeTab !== "modworkshop" || categoryFilter === "all") return true;
        return (mod.tags ?? []).some((tag) => tag.toLowerCase().includes(category));
      })
      .filter((mod) => {
        if (!query) return true;
        return (
          mod.name.toLowerCase().includes(query) ||
          String(mod.author ?? "").toLowerCase().includes(query) ||
          (mod.tags ?? []).some((tag) => tag.toLowerCase().includes(query))
        );
      });
  }, [activeTab, categoryFilter, mods, searchQuery, sortMode]);

  // v0.57: disabled automatic source-detail card enrichment.
  // It was fetching descriptions while scrolling and causing stutter/freezes.

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
      await refreshSourceMatches();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallingKey(null);
      clearTaskProgress();
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
      await refreshSourceMatches();
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
    const fallbackPageSize = 96;
    const fallbackPage = reset ? 1 : pages[source] + 1;
    const fallbackLimit = Math.min(1200, fallbackPage * fallbackPageSize + fallbackPageSize);

    reportTaskProgress(`Load ${sourceLabel(source)}`, 72, `Live route slow/empty. Loading indexed fallback page ${fallbackPage}...`);
    const cachedUi = readCache(source, requestedSort);
    const indexed = await invokeWithTimeout<SourceModSummary[]>(
      "list_source_index",
      { source, limit: fallbackLimit },
      6500,
      `${sourceLabel(source)} source-index fallback timed out.`,
    ).catch(() => []);

    const combined = sortBrowseMods(cleanMods([
      ...(Array.isArray(indexed) ? indexed : []),
      ...(cachedUi?.mods ?? []),
    ]).filter((mod) => mod.source === source), requestedSort);

    const start = (fallbackPage - 1) * fallbackPageSize;
    const cleaned = combined.slice(start, start + fallbackPageSize);
    const hasMoreFallback = combined.length > start + cleaned.length;

    if (cleaned.length === 0) {
      setMods((current) => reset ? current.filter((mod) => mod.source !== source) : current);
      setStatus(`${sourceLabel(source)} returned no live, indexed, or cached cards. Last reason: ${reason}`);
      setCacheNote(`No fallback cards found. ${reason}`);
      setHasMore((current) => ({ ...current, [source]: false }));
      reportTaskProgress(`Load ${sourceLabel(source)}`, 100, "No cards found.");
      return;
    }

    setMods((current) => {
      const base = reset ? current.filter((mod) => mod.source !== source) : current;
      const merged = sortBrowseMods(cleanMods([...base, ...cleaned]), requestedSort);
      writeCache(source, requestedSort, merged.filter((mod) => mod.source === source), fallbackPage, hasMoreFallback);
      return merged;
    });

    setPages((current) => ({ ...current, [source]: fallbackPage }));
    setHasMore((current) => ({ ...current, [source]: hasMoreFallback }));
    setCacheNote(`Showing indexed fallback page ${fallbackPage} for ${sourceLabel(source)}. Live reason: ${reason}`);
    setStatus(`Showing ${cleaned.length} indexed fallback ${sourceLabel(source)} card(s).`);
    reportTaskProgress(`Load ${sourceLabel(source)}`, 100, `Showing ${cleaned.length} fallback cards.`);
  }



  async function loadModWorkshopLivePage(reset = false, requestedSort: SortMode = sortMode, targetPage?: number) {
    if (loadingSource && loadingSource !== "modworkshop") return;
    if (!reset && !hasMore.modworkshop && !targetPage) return;

    const requestId = ++browseRequestSeqRef.current;
    const nextPage = Math.max(1, targetPage ?? (reset ? 1 : pages.modworkshop + 1));
    const replacePage = true;

    let watchdog: number | null = null;

    if (reset) {
      clearModWorkshopBrowseCaches();
      setActiveModWorkshopSearch("");
      setModWorkshopSearchPage(0);
      setHasMore((current) => ({ ...current, modworkshop: true }));
      setCacheNote("ModWorkshop page mode: old cache cleared, loading public PAYDAY 3 page 1.");
    }

    setPages((current) => ({ ...current, modworkshop: nextPage }));
    setMods((current) => current.filter((mod) => mod.source !== "modworkshop"));
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

      const cleaned = orderBrowseModsForSource(loaded, "modworkshop", requestedSort)
        .slice(0, 48);

      if (cleaned.length === 0) {
        setMods((current) => replacePage ? current.filter((mod) => mod.source !== "modworkshop") : current);
        setHasMore((current) => ({ ...current, modworkshop: false }));
        setCacheNote(`ModWorkshop page ${nextPage} returned zero cards. No cache shown.`);
        setStatus(`ModWorkshop page ${nextPage} returned zero PAYDAY 3 cards.`);
        reportTaskProgress("Load ModWorkshop", 100, "Zero live cards.");
        return;
      }

      setMods((current) => {
        const base = replacePage ? current.filter((mod) => mod.source !== "modworkshop") : current;
        return [...base, ...cleaned];
      });

      setHasMore((current) => ({ ...current, modworkshop: cleaned.length >= 18 }));
      setCacheNote(`ModWorkshop page mode · Page ${nextPage} · ${cleaned.length} live cards · cache bypassed.`);
      setStatus(`Loaded ModWorkshop page ${nextPage}: ${cleaned.length} PAYDAY 3 mod cards.`);
      reportTaskProgress("Load ModWorkshop", 100, `Page ${nextPage}: ${cleaned.length} cards.`);
    } catch (error) {
      if (requestId !== browseRequestSeqRef.current) return;
      const message = error instanceof Error ? error.message : String(error);

      setMods((current) => replacePage ? current.filter((mod) => mod.source !== "modworkshop") : current);
      setHasMore((current) => ({ ...current, modworkshop: false }));
      setCacheNote(`ModWorkshop page ${nextPage} failed. No cache shown. ${message}`);
      setStatus(`ModWorkshop page ${nextPage} failed: ${message}`);
      reportTaskProgress("Load ModWorkshop", 100, "Live page failed. No cache shown.");
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
      setMods((current) => current.filter((mod) => mod.source !== source));
      setCacheNote("");
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
      setCacheNote("");
      setStatus(`Loaded ${cleaned.length} live/sorted ${sourceLabel(source)} mods.`);
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
    setCacheNote("");
    setActiveModWorkshopSearch("");
    setModWorkshopSearchPage(0);
    setActiveNexusSearch("");
    setPages((current) => ({ ...current, [activeTab]: 0 }));
    setHasMore((current) => ({ ...current, [activeTab]: true }));
    setMods((current) => current.filter((mod) => mod.source !== activeTab));
    browseRequestSeqRef.current += 1;
    if (activeTab === "modworkshop") void loadModWorkshopLivePage(true, nextSort);
    else void loadPage(activeTab, true, nextSort);
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

  function refresh() {
    try {
      window.localStorage.removeItem(cacheKey(activeTab, sortMode));
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
    setMods((current) => current.filter((mod) => mod.source !== activeTab));
    setCacheNote(activeTab === "modworkshop" ? "Cleared old ModWorkshop cards. Testing direct live now..." : "");
    if (activeTab === "modworkshop") {
      reportTaskProgress("Refresh ModWorkshop", 5, "Clearing current view and loading public PAYDAY 3 game page...");
      void loadModWorkshopLivePage(true, sortMode, 1);
      return;
    }

    browseRequestSeqRef.current += 1;
    reportTaskProgress(`Refresh ${sourceLabel(activeTab)}`, 5, "Clearing current view and loading live/fallback cards...");
    void loadPage(activeTab, true);
  }

  async function searchModWorkshopPage(query: string, page: number, reset: boolean) {
    if (query.trim().length < 2) {
      setStatus("Type at least 2 characters to search ModWorkshop.");
      return;
    }

    setActiveTab("modworkshop");
    setSourceSearching(true);
    setLoadingSource("modworkshop");
    setStatus(`Searching ModWorkshop for "${query}" page ${page}...`);

    try {
      const results = await invokeWithTimeout<SourceModSummary[]>("search_modworkshop_mods_for_query", { query, page }, 10000, "ModWorkshop search timed out.");
      const cleaned = sortBrowseMods(cleanMods(results).filter((mod) => mod.source === "modworkshop"), sortMode);

      setMods((current) => {
        const existing = reset ? current.filter((mod) => mod.source !== "modworkshop") : current;
        const merged = sortBrowseMods(cleanMods([...existing, ...cleaned]), sortMode);
        writeCache("modworkshop", sortMode, merged.filter((mod) => mod.source === "modworkshop"), page, cleaned.length > 0);
        return merged;
      });

      setActiveModWorkshopSearch(query);
      setModWorkshopSearchPage(page);
      setPages((current) => ({ ...current, modworkshop: page }));
      setHasMore((current) => ({ ...current, modworkshop: cleaned.length > 0 }));
      setSearchQuery("");
      setStatus(
        cleaned.length > 0
          ? `${reset ? "Found" : "Loaded"} ${cleaned.length} ModWorkshop search result(s) for "${query}" page ${page}.`
          : `No more ModWorkshop search results for "${query}".`
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

    if (query.length < 2) {
      setStatus("Type at least 2 characters to search Nexus.");
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
      setSearchQuery("");
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
    const cached = readDetailCache(mod);

    if (cached) {
      return cached;
    }

    const detail =
      mod.source === "nexus"
        ? await invoke<SourceModDetail>("fetch_nexus_mod_detail", { modId: mod.sourceId })
        : await invoke<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: mod.sourceId });

    const safe = safeDetail(detail);
    writeDetailCache(safe);
    return safe;
  }

  async function openMod(mod: SourceModSummary) {
    const loadingKey = `${mod.source}-${mod.sourceId}`;
    const cached = readDetailCache(mod);

    setSelectedMod(cached ?? fallbackDetail(mod));
    setView("detail");
    reportTaskProgress("Open mod page", cached ? 35 : 15, mod.name);
    setDetailLoadingKey(loadingKey);
    setStatus(cached ? `Opened cached ${mod.name}. Refreshing source page quietly...` : `Opening ${mod.name}. Loading full source page...`);

    try {
      reportTaskProgress("Open mod page", 55, "Loading source details...");
      const detail =
        mod.source === "nexus"
          ? await invoke<SourceModDetail>("fetch_nexus_mod_detail", { modId: mod.sourceId })
          : await invoke<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: mod.sourceId });

      const safe = safeDetail(detail);
      writeDetailCache(safe);
      setSelectedMod(safe);
      reportTaskProgress("Open mod page", 100, safe.name);
      setStatus(`Opened ${safe.name}. ${safe.source === "nexus" ? "Files loaded through Nexus REST fallback." : ""}`.trim());
    } catch (error) {
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

      const safe = safeDetail(detail);
      writeDetailCache(safe);
      setSelectedMod(safe);
      setInstallPickerMod((picker) => picker && picker.source === safe.source && picker.sourceId === safe.sourceId ? safe : picker);
      setStatus(`Refreshed details and file list for ${safe.name}. ${safe.source === "nexus" ? "Files loaded through Nexus REST fallback." : ""}`.trim());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailLoadingKey(null);
      window.setTimeout(clearTaskProgress, 450);
    }
  }


  async function stageFile(mod: SourceModDetail, file: SourceModFile, replaceFileNames: string[] = []) {
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
        author: mod.author ?? null,
        thumbnailUrl: mod.thumbnailUrl ?? null,
        bannerUrl: mod.bannerUrl ?? null,
        pageUrl: mod.pageUrl ?? null,
        description: mod.description,
        replaceFileNames,
      });

      setStatus(`Installed ${applied.installedFiles.length} file(s) for ${mod.name}${applied.replacedFiles.length ? ` and replaced ${applied.replacedFiles.length} old file(s)` : ""}.`);
      window.dispatchEvent(new Event("tsuki-data-refresh"));
      await refreshSourceMatches();
    } catch (error) {
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
    }
  }

  async function updateInstalledSource(mod: SourceModSummary, match: InstalledSourceMatch) {
    setResults([]);
    setStatus(`Loading update file for ${mod.name}...`);

    try {
      const detail = await fetchDetailForMod(mod);
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
      setSelectedFileIds(files.map((file) => file.id));
      setStatus(`Choose files for ${safeDetail.name}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function installSelected() {
    if (!installPickerMod) return;
    const files = installableFiles(installPickerMod.files, installPickerMod.source).filter((file) => selectedFileIds.includes(file.id));
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
    void refreshSourceMatches(sourceMods);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, sourceMods.length]);

  useEffect(() => {
    const cached = activeTab === "modworkshop" ? null : readCache(activeTab, sortMode);

    setPages((current) => ({ ...current, [activeTab]: cached?.page ?? 0 }));
    setHasMore((current) => ({ ...current, [activeTab]: true }));

    if (cached && cached.mods.length > 0) {
      setMods((current) => cleanMods([
        ...current.filter((mod) => mod.source !== activeTab),
        ...cached.mods,
      ]));
      setCacheNote(`Showing ${cached.mods.length} cached ${sourceLabel(activeTab)} cards while live refresh runs.`);
      setStatus(`Showing ${cached.mods.length} recent cached ${sourceLabel(activeTab)} mods sorted by ${sortMode}; refreshing live in background...`);
    } else {
      setMods((current) => current.filter((mod) => mod.source !== activeTab));
      setCacheNote("");
      setStatus(`Loading live ${sourceLabel(activeTab)} results...`);
    }

    if (activeTab === "modworkshop") void loadModWorkshopLivePage(true, sortMode, 1);
    else void loadPage(activeTab, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, sortMode]);

  if (view === "detail" && selectedMod) {
    const loadingThisDetail = detailLoadingKey === `${selectedMod.source}-${selectedMod.sourceId}`;
    const files = installableFiles(selectedMod.files, selectedMod.source);
    const selectedMatch = sourceMatches[`${selectedMod.source}-${selectedMod.sourceId}`];

    return (
      <section className="page browse-page safe-browse-page">
        <div className="safe-mod-hero card">
          <div className="safe-hero-copy">
            <button className="ghost-button compact" type="button" onClick={() => { setView("list"); setSelectedMod(null); }}>
              ← Back to Browse
            </button>
            <p className="eyebrow">{sourceLabel(selectedMod.source)}</p>
            <h1>{selectedMod.name}</h1>
            <p>{selectedMod.shortDescription || "Source mod page."}</p>
            <div className="safe-badge-row">
              <span className="status-pill">{sourceLabel(selectedMod.source)}</span>
              <span className="status-pill">ID {selectedMod.sourceId}</span>
              {selectedMod.author && <span className="status-pill">by {selectedMod.author}</span>}
              {loadingThisDetail && <span className="status-pill">loading full page...</span>}
            </div>
          </div>

          <div className="safe-hero-actions">
            <button className="ghost-button compact" type="button" onClick={() => openWebsite(selectedMod.pageUrl)}>
              Website
            </button>
            {selectedMatch?.installed && selectedMatch.updateAvailable ? (
              <button className="ghost-button compact update-button" type="button" onClick={() => updateInstalledSource(selectedMod, selectedMatch)} disabled={installingKey !== null}>
                {installingKey ? "Updating..." : "Update"}
              </button>
            ) : selectedMatch?.installed ? (
              <button className="ghost-button compact danger-button" type="button" onClick={() => uninstallMatchedSource(selectedMatch)} disabled={installingKey !== null}>
                {installingKey?.endsWith("-uninstall") ? "Uninstalling..." : "Uninstall"}
              </button>
            ) : files.length === 1 ? (
              <button className="ghost-button compact install-button" type="button" onClick={() => stageFile(selectedMod, files[0])} disabled={installingKey !== null}>
                {installingKey ? "Installing..." : "Install"}
              </button>
            ) : null}
            <button className="ghost-button compact" type="button" onClick={refreshSelectedDetail} disabled={detailLoadingKey !== null}>
              {detailLoadingKey ? "Refreshing..." : "Refresh details"}
            </button>
            <button className="ghost-button compact" type="button" onClick={() => setInstallPickerMod({ ...selectedMod, files })} disabled={files.length === 0}>
              Files
            </button>
          </div>
        </div>

        <div className="safe-detail-layout polished">
          <article className="card safe-description-card">
            <div className="safe-detail-art">
              {canUseThumbnail(selectedMod.bannerUrl ?? selectedMod.thumbnailUrl) ? (
                <img
                  src={selectedMod.bannerUrl ?? selectedMod.thumbnailUrl ?? ""}
                  alt=""
                  loading="lazy"
                  onError={() => markThumbnailFailed(selectedMod.bannerUrl ?? selectedMod.thumbnailUrl)}
                />
              ) : (
                <span>{thumbnailFallbackText(selectedMod.source)}</span>
              )}
            </div>

            <div className="safe-badge-row">
              {(selectedMod.tags ?? []).slice(0, 10).map((tag) => <span className="status-pill" key={tag}>{tag}</span>)}
            </div>

            <h2>Description</h2>
            <div className="safe-description">
              {descriptionParagraphs(selectedMod.description).map((paragraph, index) => (
                <p key={`desc-${index}`}>{paragraph}</p>
              ))}
            </div>
          </article>

          <aside className="card safe-files-card">
            <div className="safe-files-header">
              <div>
                <p className="eyebrow">Downloads</p>
                <h2>Files</h2>
              </div>
              <span className="status-pill">{files.length} files</span>
            </div>

            <div className="safe-file-list">
              {files.map((file) => (
                <div className="safe-file-row" key={file.id}>
                  <div>
                    <strong>{file.name}</strong>
                    <p>{file.version ?? "Unknown version"} · {file.sizeLabel ?? "Unknown size"}</p>
                  </div>
                  <button className="ghost-button compact install-button" type="button" onClick={() => stageFile(selectedMod, file)} disabled={installingKey !== null}>
                    {installingKey === fileKey(selectedMod, file) ? "Installing..." : "Install"}
                  </button>
                  <MiniProgress active={installingKey === fileKey(selectedMod, file)} />
                </div>
              ))}
              {files.length === 0 && <p>No files exposed by this source yet.</p>}
            </div>
          </aside>
        </div>

      {results.length > 0 && <div className="card safe-results">{results.map((result, index) => <ResultNotice result={result} key={`${result.fileName}-${index}`} />)}</div>}

        {installPickerMod && (
          <InstallPicker
            mod={installPickerMod}
            selectedFileIds={selectedFileIds}
            setSelectedFileIds={setSelectedFileIds}
            installingKey={installingKey}
            onClose={() => setInstallPickerMod(null)}
            onInstallOne={stageFile}
            onInstallSelected={installSelected}
          />
        )}

        {pendingDelete && (
          <div className="confirm-overlay" role="dialog" aria-modal="true">
            <div className="confirm-panel">
              <p className="eyebrow">Confirm delete</p>
              <h2>Delete {pendingDelete.title}?</h2>
              <p>Tsuki will move these files out of ~mods into the uninstalled holding folder.</p>
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
          <h1>Browse Mods</h1>
          <p className="page-description">Safe rebuilt Browse view. This page should show an error message instead of blanking the app.</p>
        </div>

        <div className="browse-source-switcher">
          <button
            className={`source-tab ${activeTab === "modworkshop" ? "active" : ""}`}
            type="button"
            onClick={() => {
              setActiveTab("modworkshop");
              setCategoryFilter("all");
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
              setCategoryFilter("all");
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
          <p>{status}</p>
        {cacheNote && <p className="muted-inline">{cacheNote}</p>}
          {activeTab === "modworkshop" && activeModWorkshopSearch && (
            <span className="status-pill">Search: {activeModWorkshopSearch}</span>
          )}
          {activeTab === "nexus" && activeNexusSearch && (
            <span className="status-pill">Search: {activeNexusSearch}</span>
          )}
        </div>

        <div className="browse-toolbar-controls">
          <select className="select-input" value={sortMode} onChange={(event) => handleSortChange(event.target.value as SortMode)}>
            {sortOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>

          {activeTab === "modworkshop" && (
            <select className="select-input" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
              {modworkshopCategories.map((category) => (
                <option key={category} value={category}>{category === "all" ? "All ModWorkshop categories/tags" : category}</option>
              ))}
            </select>
          )}

          <form
            className="source-search-form"
            onSubmit={(event) => {
              event.preventDefault();
              searchActiveSource();
            }}
          >
            <input
              className="setting-input"
              value={sourceSearchQuery}
              onChange={(event) => setSourceSearchQuery(event.target.value)}
              placeholder={activeTab === "nexus" ? "Search Nexus Mods..." : "Search ModWorkshop..."}
            />
            <button className="ghost-button" type="submit" disabled={sourceSearching}>
              {sourceSearching ? "Searching..." : "Search"}
            </button>
          </form>

          {activeTab === "nexus" && (
            <button className="ghost-button" type="button" onClick={() => {
              setSortMode("updated");
              setActiveNexusSearch("");
              void loadPage("nexus", true);
            }}>
              Nexus Updated
            </button>
          )}

          <input className="setting-input" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={`Filter loaded ${sourceLabel(activeTab)} mods...`} />

          <button className="ghost-button" type="button" onClick={refresh}>Refresh</button>
          {activeTab === "modworkshop" && <button className="ghost-button" type="button" onClick={testModWorkshopLive} disabled={loadingSource !== null}>MW Route Test</button>}
        </div>
      </div>

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
                <strong>{mod.name}</strong>
                <span>{sourceLabel(mod.source)}</span>
              </div>

              <p className="source-card-description">{shortCardDescription(mod)}</p>

              <div className="source-mod-meta">
                <span>by {mod.author ?? "Unknown"}</span>
                {mod.version && <span>v{mod.version}</span>}
                {sourceUpdatedLabel(mod) && <span>{sourceUpdatedLabel(mod)}</span>}
                <span>ID {mod.sourceId}</span>
              </div>

              <div className="source-tag-row visible-tags">
                {sourceMatches[`${mod.source}-${mod.sourceId}`]?.installed && <span className="status-pill installed-pill">Installed</span>}
                {(mod.tags?.length ? mod.tags : mergedCardTags(mod)).slice(0, 8).map((tag) => <span className="status-pill tag-pill" key={tag}>{tag}</span>)}
                {(mod.tags?.length ?? 0) === 0 && <span className="status-pill tag-pill">No tags cached</span>}
              </div>

              <div className="source-card-actions">
                {sourceMatches[`${mod.source}-${mod.sourceId}`]?.installed && sourceMatches[`${mod.source}-${mod.sourceId}`]?.updateAvailable ? (
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
                <details className="card-more-menu">
                  <summary aria-label="More options">⋯</summary>
                  <div>
                    <button type="button" onClick={() => openWebsite(mod.pageUrl)}>Website</button>
                    <button type="button" onClick={() => openMod(mod)}>Open details</button>
                  </div>
                </details>
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
          selectedFileIds={selectedFileIds}
          setSelectedFileIds={setSelectedFileIds}
          installingKey={installingKey}
          onClose={() => setInstallPickerMod(null)}
          onInstallOne={stageFile}
          onInstallSelected={installSelected}
        />
      )}

      {pendingDelete && (
        <div className="confirm-overlay" role="dialog" aria-modal="true">
          <div className="confirm-panel">
            <p className="eyebrow">Confirm delete</p>
            <h2>Delete {pendingDelete.title}?</h2>
            <p>Tsuki will move these files out of ~mods into the uninstalled holding folder.</p>
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
  selectedFileIds,
  setSelectedFileIds,
  installingKey,
  onClose,
  onInstallOne,
  onInstallSelected,
}: {
  mod: SourceModDetail;
  selectedFileIds: string[];
  setSelectedFileIds: Dispatch<SetStateAction<string[]>>;
  installingKey: string | null;
  onClose: () => void;
  onInstallOne: (mod: SourceModDetail, file: SourceModFile) => void;
  onInstallSelected: () => void;
}) {
  const files = installableFiles(mod.files);

  return (
    <div className="image-preview-overlay safe-overlay" role="dialog" aria-modal="true">
      <div className="install-preview-panel quick-install-panel">
        <div className="image-preview-header">
          <strong>Install Files: {mod.name}</strong>
          <button className="ghost-button compact" type="button" onClick={onClose}>Close</button>
        </div>

        <div className="quick-install-actions">
          <button className="ghost-button compact" type="button" onClick={() => setSelectedFileIds(files.map((file) => file.id))}>Select All</button>
          <button className="ghost-button compact" type="button" onClick={() => setSelectedFileIds([])}>Select None</button>
          <button className="ghost-button compact install-button" type="button" onClick={onInstallSelected} disabled={installingKey !== null || selectedFileIds.length === 0}>
            {installingKey ? "Installing..." : `Install Selected (${selectedFileIds.length})`}
          </button>
        </div>

        <div className="quick-file-list">
          {files.map((file) => {
            const key = fileKey(mod, file);
            const checked = selectedFileIds.includes(file.id);

            return (
              <div className="quick-file-row" key={file.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={checked}
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
                    <small>{file.version ?? "Unknown version"} · {file.sizeLabel ?? "Unknown size"}</small>
                  </span>
                </label>

                <button className="ghost-button compact" type="button" onClick={() => onInstallOne(mod, file)} disabled={installingKey !== null}>
                  {installingKey === key ? "Installing..." : "Install"}
                </button>

                <MiniProgress active={installingKey === key} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

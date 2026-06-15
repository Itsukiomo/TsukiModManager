import "./InstalledPage.css";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PakModFile, PakScanResult } from "../../models/mod";
import type { InstalledSourceMatch, ModSourceKind, SourceModDetail, SourceModSummary, SourceModFile, StagedDownloadResult, InstallApplyResult, SourceUpdateStatus } from "../../models/source";

type InstalledView = "all" | "matched" | "updates" | "unmatched" | "raw";
type SortMode = "smart" | "name" | "modified" | "size" | "enabled" | "disabled";

interface CachedSourceMods {
  mods?: SourceModSummary[];
  savedAt?: number;
  version?: string;
  page?: number;
  hasMore?: boolean;
}

const INSTALLED_ENRICH_CACHE_KEY = "tsuki-source-cache:v0.44:installed:index";

const UNPAIRABLE_GROUPS_KEY = "tsuki-installed-unpairable-groups:v0.90-state-first";

const REJECTED_PAIRINGS_KEY = "tsuki-rejected-pairings:v0.90-state-first";
const CUSTOM_GROUPS_KEY = "tsuki-custom-installed-groups:v0.90-state-first";
const PAIR_STATE_CACHE_KEY = "tsuki-installed-pair-ledger:v1";

const TSUKI_RECEIPT_UPDATE_CACHE_KEY = "tsuki-receipt-update-check:v1";

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
    // Optional cache.
  }
}


const PAIR_REPAIR_CACHE_KEYS = [
  "tsuki-installed-pair-state:v0.51",
  "tsuki-installed-pair-state:v0.84-proof-first",
  "tsuki-installed-pair-state:v0.85-one-to-one",
  "tsuki-installed-pair-state:v0.86-fast",
  "tsuki-installed-pair-state:v0.87-index",
  "tsuki-installed-pair-state:v0.88-auto-pair",
  "tsuki-installed-pair-state:v0.88-stable",
  PAIR_STATE_CACHE_KEY,
  "tsuki-rejected-pairings:v0.44",
  "tsuki-rejected-pairings:v0.84-proof-first",
  "tsuki-rejected-pairings:v0.85-one-to-one",
  "tsuki-rejected-pairings:v0.86-fast",
  "tsuki-rejected-pairings:v0.88-auto-pair",
  "tsuki-rejected-pairings:v0.88-stable",
  REJECTED_PAIRINGS_KEY,
  "tsuki-custom-installed-groups:v0.44",
  "tsuki-custom-installed-groups:v0.84-proof-first",
  "tsuki-custom-installed-groups:v0.85-one-to-one",
  "tsuki-custom-installed-groups:v0.86-fast",
  "tsuki-custom-installed-groups:v0.88-auto-pair",
  "tsuki-custom-installed-groups:v0.88-stable",
  CUSTOM_GROUPS_KEY,
  "tsuki-installed-unpairable-groups:v0.44",
  "tsuki-installed-unpairable-groups:v0.84-proof-first",
  "tsuki-installed-unpairable-groups:v0.85-one-to-one",
  "tsuki-installed-unpairable-groups:v0.86-fast",
  "tsuki-installed-unpairable-groups:v0.88-auto-pair",
  "tsuki-installed-unpairable-groups:v0.88-stable",
  UNPAIRABLE_GROUPS_KEY,
];

function removeLocalStorageKeys(keys: string[]) {
  for (const key of [...new Set(keys)]) {
    window.localStorage.removeItem(key);
  }
}

function loadStringList(key: string) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function saveStringList(key: string, values: string[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify([...new Set(values)]));
  } catch {
    // Optional cache.
  }
}

function loadUnpairableGroups() {
  return loadStringList(UNPAIRABLE_GROUPS_KEY);
}

function saveUnpairableGroups(keys: string[]) {
  saveStringList(UNPAIRABLE_GROUPS_KEY, keys);
}

function pruneMissingSkippedGroups(keys: string[], groups: InstalledGroup[]) {
  const liveKeys = new Set(groups.map((group) => group.key));
  return keys.filter((key) => liveKeys.has(key));
}


function saveInstalledEnrichedSourceCache(mods: SourceModSummary[]) {
  try {
    window.localStorage.setItem(
      INSTALLED_ENRICH_CACHE_KEY,
      JSON.stringify({
        version: "v0.44",
        savedAt: Date.now(),
        page: 1,
        hasMore: false,
        mods,
      }),
    );
  } catch {
    // Cache is optional.
  }
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

function sourceSummaryFromInstalledState(record: InstalledStateRecord): SourceModSummary | null {
  if (!record.source || !record.sourceModId && !record.id) return null;

  const sourceId = record.sourceModId ?? record.id;
  const fileAliases = (record.files ?? [])
    .map((file) => file.fileName)
    .filter((fileName) => fileName && fileName.trim().length > 0);

  return {
    source: record.source as ModSourceKind,
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
    shortDescription: [`Installed by Tsuki receipt ${record.receiptId ?? record.uid}`, ...fileAliases].join(" "),
    tags: [...new Set([record.location, record.fileType, record.filename, ...fileAliases].filter(Boolean))],
  };
}

interface CachedPairState {
  savedAt: number;
  fileSignature: string;
  sourceMods: SourceModSummary[];
  matches: Record<string, InstalledSourceMatch>;
}

function installedFileSignature(files: PakModFile[]) {
  return files
    .map((file) => `${enabledFileName(file.fileName).toLowerCase()}|${file.sizeBytes}`)
    .sort()
    .join("::");
}

function stablePairMatches(matches: Record<string, InstalledSourceMatch>) {
  return Object.fromEntries(
    Object.entries(matches).filter(([, match]) => {
      if (!match.installed) return false;
      return ["receipt", "receipt-hash", "source-id", "proof-filename"].includes(match.matchKind);
    }),
  ) as Record<string, InstalledSourceMatch>;
}

function savePairState(sourceMods: SourceModSummary[], matches: Record<string, InstalledSourceMatch>, files: PakModFile[]) {
  try {
    const payload: CachedPairState = {
      savedAt: Date.now(),
      fileSignature: installedFileSignature(files),
      sourceMods,
      matches: stablePairMatches(matches),
    };

    window.localStorage.setItem(PAIR_STATE_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Optional cache.
  }
}

function loadPairState(files: PakModFile[]): CachedPairState | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PAIR_STATE_CACHE_KEY) ?? "{}") as CachedPairState;

    if (!Array.isArray(parsed.sourceMods) || !parsed.matches || !parsed.fileSignature) return null;
    if (parsed.fileSignature !== installedFileSignature(files)) return null;

    parsed.matches = stablePairMatches(parsed.matches);

    return parsed;
  } catch {
    return null;
  }
}

interface InstalledGroup {
  key: string;
  label: string;
  files: PakModFile[];
  modifiedUnix: number;
  sizeBytes: number;
  enabled: boolean;
}

interface PendingDelete {
  title: string;
  fileNames: string[];
  busyId: string;
}

interface PairedInstalledMod {
  sourceMod: SourceModSummary;
  match: InstalledSourceMatch;
  files: PakModFile[];
  group: InstalledGroup | null;
}

function sourceLabel(source: string) {
  return source === "modworkshop" ? "ModWorkshop" : "Nexus";
}

function sourceAccent(source: string) {
  return source === "modworkshop" ? "MW" : "NX";
}

function sourceKey(mod: SourceModSummary) {
  return `${mod.source}-${mod.sourceId}`;
}

function sourceImageUrl(mod?: SourceModSummary | SourceModDetail | null) {
  return mod?.thumbnailUrl || mod?.bannerUrl || null;
}

function mergeSourceSummary(existing: SourceModSummary | undefined, incoming: SourceModSummary) {
  if (!existing) return incoming;

  return {
    ...existing,
    ...incoming,
    thumbnailUrl: incoming.thumbnailUrl || existing.thumbnailUrl,
    bannerUrl: incoming.bannerUrl || existing.bannerUrl,
    author: incoming.author || existing.author,
    version: incoming.version || existing.version,
    pageUrl: incoming.pageUrl || existing.pageUrl,
    updatedAt: incoming.updatedAt || existing.updatedAt,
    shortDescription: incoming.shortDescription || existing.shortDescription,
    tags: [...new Set([...(existing.tags ?? []), ...(incoming.tags ?? [])])],
  };
}



function yieldToUi(ms = 25) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function reportTaskProgress(label: string, progress: number | null = null, detail = "") {
  window.dispatchEvent(new CustomEvent("tsuki-task-progress", {
    detail: {
      active: true,
      label,
      detail,
      progress,
    },
  }));
}

function clearTaskProgress() {
  window.dispatchEvent(new CustomEvent("tsuki-task-progress", {
    detail: {
      active: false,
      label: "",
      detail: "",
      progress: null,
    },
  }));
}

function clearTaskProgressSoon(ms = 700) {
  window.setTimeout(clearTaskProgress, ms);
}

function finishTaskProgress(label: string, detail = "Done.", ms = 800) {
  reportTaskProgress(label, 100, detail);
  clearTaskProgressSoon(ms);
}

function shouldKeepExistingPairMatch(existing: InstalledSourceMatch | undefined, incoming: InstalledSourceMatch) {
  if (!existing?.installed) return false;
  if (incoming.installed) return false;

  return ["receipt", "receipt-hash", "source-id", "proof-filename"].includes(existing.matchKind);
}

function mergePairResultsSafely(
  previous: Record<string, InstalledSourceMatch>,
  incoming: InstalledSourceMatch[],
) {
  const next: Record<string, InstalledSourceMatch> = { ...previous };
  let keptExisting = 0;

  for (const match of incoming) {
    const key = `${match.source}-${match.sourceId}`;

    if (shouldKeepExistingPairMatch(previous[key], match)) {
      keptExisting += 1;
      continue;
    }

    next[key] = match;
  }

  return { next, keptExisting };
}

function pruneNumericMismatchPairMatches(
  mods: SourceModSummary[],
  previous: Record<string, InstalledSourceMatch>,
) {
  const modMap = new Map(mods.map((mod) => [sourceKey(mod), mod]));
  const next: Record<string, InstalledSourceMatch> = {};
  let removed = 0;

  for (const [key, match] of Object.entries(previous)) {
    const mod = modMap.get(key);
    const isProofPair = match.installed && ["proof-filename", "source-id"].includes(match.matchKind);

    if (mod && isProofPair && sourceNumbersConflictFiles(mod, match.matchedFiles ?? [])) {
      removed += 1;
      continue;
    }

    next[key] = match;
  }

  return { next, removed };
}



function recordRuntimeDiagnostic(label: string, status: string, reason: string, details: string[] = []) {
  void invoke<string>("record_runtime_process_diagnostic", {
    label,
    status,
    reason,
    details,
  }).catch(() => "");
}


function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;

  for (const unit of units) {
    if (value < 1024) return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
    value /= 1024;
  }

  return `${value.toFixed(1)} TB`;
}

function formatDateFromUnix(seconds?: number | null) {
  if (!seconds) return "Unknown";
  return new Date(seconds * 1000).toLocaleDateString();
}

function splitCamel(input: string) {
  return input.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Za-z])(\d)/g, "$1 $2");
}

function enabledFileName(fileName: string) {
  return fileName.replace(/\.disabled$/i, "");
}

function normalizeInstalledName(fileName: string) {
  let value = splitCamel(enabledFileName(fileName)).toLowerCase();

  value = value.replace(/\.(pak|ucas|utoc)$/i, "");
  value = value.replace(/^\d+[_\-\s]+/, "");
  value = value.replace(/[_\-.]+p$/i, "");
  value = value.replace(/[^a-z0-9]+/g, " ");

  const stop = new Set([
    "the",
    "and",
    "for",
    "payday",
    "payday3",
    "pd3",
    "pak",
    "mod",
    "mods",
    "file",
    "files",
    "main",
    "final",
    "latest",
    "version",
    "windows",
    "win64",
  ]);

  return value
    .split(/\s+/)
    .filter((token) => token.length > 1)
    .filter((token) => !stop.has(token))
    .filter((token) => !/^\d+$/.test(token) || token.length <= 4)
    .join(" ");
}

function compact(value: string) {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function stripPriorityAndExtensionForNumbers(value: string) {
  return enabledFileName(value)
    .replace(/\.(pak|ucas|utoc|zip|rar|7z)$/i, "")
    .replace(/^\d+[_\-\s]+/, "")
    .replace(/[_\-.]+p$/i, "");
}

function meaningfulNumberTokens(value: string) {
  const text = stripPriorityAndExtensionForNumbers(value).toLowerCase();
  const found = [...text.matchAll(/\d+/g)]
    .map((match) => match[0])
    .filter((token) => token.length <= 4)
    .filter((token) => token !== "0");

  return [...new Set(found)];
}

function numericTokensCompatible(sourceValue: string, fileValues: string[]) {
  const sourceNumbers = meaningfulNumberTokens(sourceValue);
  const fileNumbers = [...new Set(fileValues.flatMap((value) => meaningfulNumberTokens(value)))];

  if (sourceNumbers.length === 0 || fileNumbers.length === 0) return true;

  return fileNumbers.some((value) => sourceNumbers.includes(value));
}

function sourceNumbersConflictGroup(mod: SourceModSummary, group: InstalledGroup) {
  return !numericTokensCompatible(mod.name, group.files.map((file) => file.fileName));
}

function sourceNumbersConflictFiles(mod: SourceModSummary, files: string[]) {
  return !numericTokensCompatible(mod.name, files);
}



function inferModWorkshopId(group: InstalledGroup) {
  const ids: string[] = [];

  for (const file of group.files) {
    const baseName = enabledFileName(file.fileName).replace(/\.(pak|ucas|utoc)$/i, "");
    const matches = [...baseName.matchAll(/(?:^|[_\-\s])(\d{4,6})(?=$|[_\-\s])/g)];

    for (const match of matches) {
      const id = match[1];

      // Ignore 4-digit years and tiny priority-ish prefixes.
      if (/^20\d\d$/.test(id)) continue;
      ids.push(id);
    }
  }

  return ids.length > 0 ? ids[ids.length - 1] : null;
}

function installedSearchLabel(group: InstalledGroup) {
  return group.label
    .replace(/\b(pakchunk|mods?|payday3|pd3|the|for|and|p)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchQueriesForGroup(group: InstalledGroup) {
  const queries = new Set<string>();
  const label = installedSearchLabel(group);

  if (label.length >= 3) queries.add(label);

  for (const file of group.files) {
    const base = normalizeInstalledName(file.fileName);
    if (base.length >= 3) queries.add(base);

    const withoutTrailingId = base.replace(/\b\d{4,6}\b/g, " ").replace(/\s+/g, " ").trim();
    if (withoutTrailingId.length >= 3) queries.add(withoutTrailingId);

    const tokens = withoutTrailingId.split(/\s+/).filter(Boolean);

    // Creator prefixes are common in loose PAK files: abkarino_FbiServer_P.pak.
    // Search the core title too, otherwise Nexus/ModWorkshop search gets the wrong phrase.
    if (tokens.length >= 3) {
      queries.add(tokens.slice(1).join(" "));
      queries.add(tokens.slice(-3).join(" "));
      queries.add(tokens.slice(-2).join(" "));
    }

    if (tokens.length === 2) {
      queries.add(tokens.join(" "));
    }
  }

  return [...queries].filter((query) => query.length >= 3).slice(0, 7);
}

function sourceSummaryFromDetail(detail: SourceModDetail): SourceModSummary {
  const fileNames = (detail.files ?? [])
    .map((file) => file.name)
    .filter((name) => name && name.trim().length > 0)
    .slice(0, 24);

  const tags = [...new Set([...(detail.tags ?? []), ...fileNames])];
  const fileAliasText = fileNames.slice(0, 12).join(" ");

  return {
    source: detail.source,
    sourceId: detail.sourceId,
    name: detail.name,
    author: detail.author,
    version: detail.version,
    thumbnailUrl: detail.thumbnailUrl,
    bannerUrl: detail.bannerUrl,
    pageUrl: detail.pageUrl,
    updatedAt: detail.updatedAt,
    downloads: detail.downloads,
    likes: detail.likes,
    shortDescription: [detail.shortDescription, fileAliasText].filter(Boolean).join(" "),
    tags,
  };
}

function cacheAge(savedAt?: number) {
  if (!savedAt) return "unknown";

  const seconds = Math.max(1, Math.floor((Date.now() - savedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function cachedSourcePriority(mod: SourceModSummary) {
  const hasImage = mod.thumbnailUrl || mod.bannerUrl ? 1000 : 0;
  const updated = Number(mod.updatedAt ?? 0) || 0;
  return hasImage + updated;
}

function loadSourceModsFromCache(limit = 550) {
  const mods = new Map<string, SourceModSummary>();
  let newestCache = 0;
  let cacheBuckets = 0;

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith("tsuki-source-cache:")) continue;

    // Ignore older auto-installed source indexes. They may contain experimental aliases
    // from previous builds that caused false positives. Normal Browse caches still load.
    if (key.includes(":installed:index") && key !== INSTALLED_ENRICH_CACHE_KEY) continue;

    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? "{}") as CachedSourceMods;
      if (!Array.isArray(parsed.mods)) continue;

      cacheBuckets += 1;
      newestCache = Math.max(newestCache, parsed.savedAt ?? 0);

      for (const mod of parsed.mods) {
        if (!mod?.source || !mod?.sourceId || !mod?.name) continue;
        mods.set(`${mod.source}-${mod.sourceId}`, mod);
      }
    } catch {
      // Ignore broken cache bucket.
    }
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(PAIR_STATE_CACHE_KEY) ?? "{}") as CachedPairState;

    if (Array.isArray(parsed.sourceMods)) {
      cacheBuckets += 1;
      newestCache = Math.max(newestCache, parsed.savedAt ?? 0);

      for (const mod of parsed.sourceMods) {
        if (!mod?.source || !mod?.sourceId || !mod?.name) continue;
        mods.set(`${mod.source}-${mod.sourceId}`, mod);
      }
    }
  } catch {
    // Pair cache is optional.
  }

  const capped = [...mods.values()]
    .sort((a, b) => cachedSourcePriority(b) - cachedSourcePriority(a))
    .slice(0, limit);

  return { mods: capped, newestCache, cacheBuckets };
}

function groupInstalledFiles(files: PakModFile[]): InstalledGroup[] {
  const groups = new Map<string, PakModFile[]>();

  for (const file of files) {
    const key = compact(normalizeInstalledName(file.fileName)) || enabledFileName(file.fileName).toLowerCase();
    const current = groups.get(key) ?? [];
    current.push(file);
    groups.set(key, current);
  }

  return [...groups.entries()].map(([key, group]) => {
    const fallbackName = group[0]?.fileName ?? key;
    const label = normalizeInstalledName(fallbackName) || enabledFileName(fallbackName) || key;

    return {
      key,
      label,
      files: group.sort((a, b) => a.fileName.localeCompare(b.fileName)),
      modifiedUnix: Math.max(...group.map((file) => file.modifiedUnix ?? 0)),
      sizeBytes: group.reduce((total, file) => total + file.sizeBytes, 0),
      enabled: group.some((file) => file.enabled),
    };
  });
}

function mergeInstalledGroups(inputGroups: InstalledGroup[], keyPrefix: string): InstalledGroup {
  const files = inputGroups.flatMap((group) => group.files);
  const labels = [...new Set(inputGroups.map((group) => group.label))];

  return {
    key: `${keyPrefix}:${inputGroups.map((group) => group.key).join("+")}`,
    label: labels.slice(0, 3).join(" + "),
    files: files.sort((a, b) => a.fileName.localeCompare(b.fileName)),
    modifiedUnix: Math.max(...files.map((file) => file.modifiedUnix ?? 0), 0),
    sizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    enabled: files.some((file) => file.enabled),
  };
}

function groupIsPairedByMatches(group: InstalledGroup, matchesToCheck: Record<string, InstalledSourceMatch>, sourceModsToCheck: SourceModSummary[]) {
  const groupFileNames = new Set(group.files.map((file) => file.fileName.toLowerCase()));

  for (const mod of sourceModsToCheck) {
    const match = matchesToCheck[sourceKey(mod)];
    if (!match?.installed) continue;
    if (match.matchKind !== "receipt" && match.matchKind !== "receipt-hash" && match.confidence < 86) continue;

    for (const matchedFile of match.matchedFiles) {
      if (groupFileNames.has(matchedFile.toLowerCase())) {
        return true;
      }
    }
  }

  return false;
}

function scoreSourceForGroup(mod: SourceModSummary, group: InstalledGroup) {
  if (sourceNumbersConflictGroup(mod, group)) {
    return 0;
  }
  const haystackRaw = [
    mod.name,
    mod.author ?? "",
    mod.shortDescription ?? "",
    ...(mod.tags ?? []),
  ].join(" ").toLowerCase();
  const haystackCompact = compact(haystackRaw);
  const haystackTokens = new Set(normalizeInstalledName(haystackRaw).split(/\s+/).filter((token) => token.length >= 2));

  const queries = searchQueriesForGroup(group)
    .map((query) => compact(query))
    .filter((query) => query.length >= 4);

  let score = 0;
  for (const query of queries) {
    if (haystackCompact.includes(query)) score += query.length >= 8 ? 80 : 45;
  }

  for (const file of group.files) {
    const baseName = normalizeInstalledName(file.fileName);
    const base = compact(baseName);
    if (base.length >= 6 && haystackCompact.includes(base)) score += 100;

    const tokens = baseName.split(/\s+/).filter((token) => token.length >= 2);
    const common = tokens.filter((token) => haystackTokens.has(token));

    if (common.length >= 2) {
      const coverage = common.length / Math.max(tokens.length, 1);
      if (coverage >= 0.55 || tokens.length <= common.length + 1) {
        score += 90;
      }
    }
  }

  return score;
}

function sourceIdAppearsInGroup(mod: SourceModSummary, group: InstalledGroup) {
  const id = String(mod.sourceId ?? "").trim();
  if (id.length < 3) return false;

  return group.files.some((file) => {
    const text = `${file.fileName} ${file.fullPath ?? ""}`.toLowerCase();
    return text.includes(id.toLowerCase());
  });
}

function sourceNameDirectlyMatchesGroup(mod: SourceModSummary, group: InstalledGroup) {
  if (sourceNumbersConflictGroup(mod, group)) return false;
  const sourceName = normalizeInstalledName(mod.name);
  const sourceCompact = compact(sourceName);

  return group.files.some((file) => {
    const fileName = normalizeInstalledName(file.fileName);
    const fileCompact = compact(fileName);

    if (fileCompact.length >= 6 && sourceCompact.includes(fileCompact)) return true;
    if (sourceCompact.length >= 6 && fileCompact.includes(sourceCompact)) return true;

    const fileTokens = fileName.split(/\s+/).filter((token) => token.length >= 3);
    const sourceTokens = new Set(sourceName.split(/\s+/).filter((token) => token.length >= 3));
    const shared = fileTokens.filter((token) => sourceTokens.has(token));

    return shared.length >= 2 && shared.length / Math.max(fileTokens.length, 1) >= 0.66;
  });
}

function claimedFileKeysFromMatches(matches: Record<string, InstalledSourceMatch>) {
  const claimed = new Set<string>();

  for (const match of Object.values(matches)) {
    if (!match.installed) continue;

    for (const file of match.matchedFiles ?? []) {
      claimed.add(fileNameKey(file));
    }
  }

  return claimed;
}

function directPairMatchesFromGroups(
  mods: SourceModSummary[],
  installedGroups: InstalledGroup[],
  previousMatches: Record<string, InstalledSourceMatch>,
  sourceFilter: ModSourceKind | "all" = "all",
) {
  const claimed = claimedFileKeysFromMatches(previousMatches);
  const candidates: Array<{
    mod: SourceModSummary;
    group: InstalledGroup;
    score: number;
    reason: string;
  }> = [];

  for (const mod of mods) {
    if (sourceFilter !== "all" && mod.source !== sourceFilter) continue;

    for (const group of installedGroups) {
      if (sourceNumbersConflictGroup(mod, group)) continue;

      const groupFileKeys = group.files.map((file) => fileNameKey(file.fileName));
      if (groupFileKeys.some((key) => claimed.has(key))) continue;

      let score = scoreSourceForGroup(mod, group);
      let reason = `frontend score ${score}`;

      if (sourceIdAppearsInGroup(mod, group)) {
        score = Math.max(score, 99);
        reason = `source id ${mod.sourceId} appears in installed filename`;
      }

      if (sourceNameDirectlyMatchesGroup(mod, group)) {
        score = Math.max(score, 96);
        reason = "installed pak stem directly matches source title";
      }

      const threshold = mod.source === "modworkshop" ? 87 : 90;
      if (score >= threshold) {
        candidates.push({ mod, group, score: Math.min(100, score), reason });
      }
    }
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.group.label.localeCompare(b.group.label);
  });

  const grouped = new Map<string, {
    mod: SourceModSummary;
    score: number;
    reason: string;
    groups: InstalledGroup[];
  }>();
  const usedGroups = new Set<string>();

  for (const candidate of candidates) {
    if (usedGroups.has(candidate.group.key)) continue;

    const key = sourceKey(candidate.mod);
    const existing = grouped.get(key);

    if (existing) {
      existing.groups.push(candidate.group);
      existing.score = Math.max(existing.score, candidate.score);
      if (!existing.reason.includes(candidate.reason)) {
        existing.reason = `${existing.reason}; ${candidate.reason}`;
      }
    } else {
      grouped.set(key, {
        mod: candidate.mod,
        score: candidate.score,
        reason: candidate.reason,
        groups: [candidate.group],
      });
    }

    usedGroups.add(candidate.group.key);
  }

  const matches: InstalledSourceMatch[] = [];

  for (const item of grouped.values()) {
    const files = item.groups.flatMap((group) => group.files.map((file) => file.fileName));
    const newestModified = Math.max(...item.groups.map((group) => group.modifiedUnix).filter(Boolean), 0);
    const enabled = item.groups.some((group) => group.enabled);

    matches.push({
      source: item.mod.source,
      sourceId: item.mod.sourceId,
      installed: true,
      enabled,
      updateAvailable: false,
      confidence: item.score,
      reason: `${item.reason}; frontend direct local proof grouped ${files.length} installed file(s)`,
      matchedFiles: files,
      installedModifiedUnix: newestModified || null,
      sourceUpdatedAt: item.mod.updatedAt ?? null,
      sourceUpdatedUnix: Number(item.mod.updatedAt) || null,
      matchKind: "proof-filename",
    });
  }

  return matches;
}




function pairFilesFromMatch(match: InstalledSourceMatch, groups: InstalledGroup[]) {
  const matched = new Set(match.matchedFiles.map(fileNameKey));

  const directGroups = groups.filter((group) => {
    return group.files.some((file) => matched.has(fileNameKey(file.fileName)) || matched.has(fileNameKey(file.fullPath)));
  });

  if (directGroups.length > 1) {
    return mergeInstalledGroups(directGroups, `${match.source}-${match.sourceId}`);
  }

  if (directGroups.length === 1) return directGroups[0];

  const compactMatched = match.matchedFiles.map((file) => compact(normalizeInstalledName(file)));
  const fuzzyGroups = groups.filter((group) => {
    return compactMatched.some((value) => {
      return value && (group.key.includes(value) || value.includes(group.key));
    });
  });

  if (fuzzyGroups.length > 1) {
    return mergeInstalledGroups(fuzzyGroups, `${match.source}-${match.sourceId}:fuzzy`);
  }

  return fuzzyGroups[0] ?? null;
}


function pairingGuardKey(sourceMod: SourceModSummary, match: InstalledSourceMatch, group: InstalledGroup | null) {
  const groupKey = group?.key ?? match.matchedFiles.slice().sort().join("|") ?? "unknown";
  return `${sourceKey(sourceMod)}=>${groupKey}`;
}

function itemEnabled(item: PairedInstalledMod) {
  if (item.group) return item.group.enabled;
  if (item.match.matchKind === "receipt") return item.match.enabled !== false;
  return item.files.some((file) => file.enabled) ?? true;
}

function newestSourceFiles(files: SourceModFile[]) {
  return [...files].sort((a, b) => String(b.uploadedAt ?? "").localeCompare(String(a.uploadedAt ?? "")));
}

function isImageAssetSourceFile(file: SourceModFile) {
  const text = `${file.name} ${file.downloadUrl ?? ""}`.toLowerCase().split("?")[0];

  return [".webp", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".avif", ".ico", ".bmp"].some((extension) => text.endsWith(extension))
    || text.includes("/images/")
    || text.includes("/image/")
    || text.includes("/media/")
    || text.includes("/thumbnail")
    || file.name.toLowerCase().startsWith("thumbnail_");
}

function isInstallableSourceFile(file: SourceModFile) {
  if (isImageAssetSourceFile(file)) return false;

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

  return Boolean(file.id && file.id !== "unknown" && !file.id.startsWith("image-"));
}

function installableSourceFiles(files: SourceModFile[]) {
  return newestSourceFiles(files).filter(isInstallableSourceFile);
}

function limitList<T>(items: T[], limit: number) {
  return items.length > limit ? items.slice(0, limit) : items;
}

function fileNameKey(value: string) {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return (parts.length > 0 ? parts[parts.length - 1] : value).toLowerCase();
}


function isPayday3SourceCandidate(mod: SourceModSummary) {
  const text = [
    mod.name,
    mod.shortDescription ?? "",
    mod.pageUrl ?? "",
    ...(mod.tags ?? []),
  ].join(" ").toLowerCase();

  const foreignMarkers = [
    "raid: world war ii",
    "raid world war ii",
    "raid ww2",
    "world war ii mods",
    "payday 2",
    "pd2 mods",
    "ready or not",
    "left 4 dead",
    "blade & sorcery",
  ];

  if (foreignMarkers.some((marker) => text.includes(marker))) return false;

  if (mod.source === "nexus") {
    return mod.pageUrl?.toLowerCase().includes("/payday3/") ?? true;
  }

  if (mod.source === "modworkshop") {
    return text.includes("payday 3") || text.includes("payday3") || text.includes("pd3") || (mod.tags ?? []).some((tag) => tag.toLowerCase() === "payday 3");
  }

  return true;
}

function filterPayday3SourceMods(mods: SourceModSummary[]) {
  return mods.filter(isPayday3SourceCandidate);
}

function installedFileBaseName(value: string) {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : value;
}

function installedFileShortPath(value: string) {
  const parts = value.split(/[\\/]/).filter(Boolean);

  const win64Index = parts.findIndex((part) => part.toLowerCase() === "win64");
  if (win64Index >= 0) return parts.slice(win64Index).join("\\");

  const modsIndex = parts.findIndex((part) => part === "~mods");
  if (modsIndex >= 0) return parts.slice(modsIndex).join("\\");

  const paydayIndex = parts.findIndex((part) => part.toLowerCase() === "payday3");
  if (paydayIndex >= 0) return parts.slice(Math.max(paydayIndex, parts.length - 5)).join("\\");

  return parts.slice(-4).join("\\") || value;
}


function sortPaired(items: PairedInstalledMod[], sortMode: SortMode) {
  return [...items].sort((a, b) => {
    if (sortMode === "modified") return (b.group?.modifiedUnix ?? 0) - (a.group?.modifiedUnix ?? 0);
    if (sortMode === "size") return (b.group?.sizeBytes ?? 0) - (a.group?.sizeBytes ?? 0);
    if (sortMode === "enabled") {
      const enabledCompare = Number(itemEnabled(b)) - Number(itemEnabled(a));
      if (enabledCompare !== 0) return enabledCompare;
      return a.sourceMod.name.localeCompare(b.sourceMod.name);
    }
    if (sortMode === "disabled") {
      const disabledCompare = Number(!itemEnabled(b)) - Number(!itemEnabled(a));
      if (disabledCompare !== 0) return disabledCompare;
      return a.sourceMod.name.localeCompare(b.sourceMod.name);
    }

    if (sortMode === "smart") {
      // Smart should not move cards just because a mod was toggled on/off.
      // Toggled mods stay in-place unless the user explicitly picks On/Off sort.
      if (a.match.updateAvailable !== b.match.updateAvailable) {
        return Number(b.match.updateAvailable) - Number(a.match.updateAvailable);
      }

      if (a.match.confidence !== b.match.confidence) return b.match.confidence - a.match.confidence;
    }

    return a.sourceMod.name.localeCompare(b.sourceMod.name);
  });
}



export function InstalledPage() {
  const [scanResult, setScanResult] = useState<PakScanResult | null>(null);
  const [sourceMods, setSourceMods] = useState<SourceModSummary[]>([]);
  const [matches, setMatches] = useState<Record<string, InstalledSourceMatch>>({});
  const [status, setStatus] = useState("Ready to scan installed mods.");
  const [pairingStatus, setPairingStatus] = useState("Open Browse first so Tsuki has source cards to pair.");
  const [sourceCacheAge, setSourceCacheAge] = useState("unknown");
  const [sourceCacheBuckets, setSourceCacheBuckets] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [view, setView] = useState<InstalledView>("all");
  const [sortMode, setSortMode] = useState<SortMode>("smart");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [selectedSourceMod, setSelectedSourceMod] = useState<SourceModDetail | null>(null);
  const [selectedSourceMatch, setSelectedSourceMatch] = useState<InstalledSourceMatch | null>(null);
  const [detailLoadingKey, setDetailLoadingKey] = useState<string | null>(null);
  const [searchPairLimit, setSearchPairLimit] = useState(10);
  const [nexusIndexing, setNexusIndexing] = useState(false);
  const [backgroundPairing, setBackgroundPairing] = useState(false);
  const [autoPairEnabled] = useState(false);
  const [autoPairStatus, setAutoPairStatus] = useState("Pair Ledger v1 active. Broad Auto Pair is disabled; use Try Pair on a selected mod.");
  const [sourceUpdates, setSourceUpdates] = useState<SourceUpdateStatus[]>(() => readReceiptUpdateCheckCache()?.updates ?? []);
  const [updatesBusy, setUpdatesBusy] = useState(false);
  const [receiptUpdateCache, setReceiptUpdateCache] = useState<ReceiptUpdateCheckCache | null>(() => readReceiptUpdateCheckCache());
  const [unpairableGroups, setUnpairableGroups] = useState<string[]>(() => loadUnpairableGroups());
  const [rejectedPairings, setRejectedPairings] = useState<string[]>(() => loadStringList(REJECTED_PAIRINGS_KEY));
  const [customGroups, setCustomGroups] = useState<string[]>(() => loadStringList(CUSTOM_GROUPS_KEY));
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const autoPairTimerRef = useRef<number | null>(null);
  const pairingBusyRef = useRef(false);

  const rawFiles = scanResult?.pakMods ?? [];
  const groups = useMemo(() => groupInstalledFiles(rawFiles), [rawFiles]);

  useEffect(() => {
    const pruned = pruneMissingSkippedGroups(unpairableGroups, groups);
    if (pruned.length !== unpairableGroups.length) {
      setUnpairableGroups(pruned);
      saveUnpairableGroups(pruned);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.length]);

  useEffect(() => {
    const onReceiptUpdateCheck = () => {
      const cached = readReceiptUpdateCheckCache();
      setReceiptUpdateCache(cached);
      setSourceUpdates(cached?.updates ?? []);
    };

    window.addEventListener("tsuki-receipt-update-check", onReceiptUpdateCheck);
    onReceiptUpdateCheck();

    return () => window.removeEventListener("tsuki-receipt-update-check", onReceiptUpdateCheck);
  }, []);

  const updateStatusBySourceKey = useMemo(() => {
    const map = new Map<string, SourceUpdateStatus>();

    for (const update of sourceUpdates) {
      map.set(`${update.source}-${update.modId}`, update);
    }

    return map;
  }, [sourceUpdates]);

  const pairedMods = useMemo(() => {
    const items: PairedInstalledMod[] = [];

    for (const sourceMod of filterPayday3SourceMods(sourceMods)) {
      const match = matches[`${sourceMod.source}-${sourceMod.sourceId}`];
      if (!match?.installed) continue;

      const group = pairFilesFromMatch(match, groups);
      const guardKey = pairingGuardKey(sourceMod, match, group);

      if (rejectedPairings.includes(guardKey)) continue;
      if (group && customGroups.includes(group.key)) continue;

      // Low-confidence token overlaps created obvious false positives.
      // They can become suggestions later, but they should not count as paired.
      if (match.matchKind !== "receipt" && match.confidence < 86) continue;

      const updateStatus = updateStatusBySourceKey.get(`${sourceMod.source}-${sourceMod.sourceId}`);
      const matchWithUpdates = updateStatus
        ? {
            ...match,
            updateAvailable: updateStatus.updateAvailable,
            sourceUpdatedAt: updateStatus.latestVersion ?? match.sourceUpdatedAt,
          }
        : match;

      items.push({
        sourceMod,
        match: matchWithUpdates,
        group,
        files: group?.files ?? [],
      });
    }

    const query = searchQuery.trim().toLowerCase();
    const filtered = items.filter((item) => {
      if (!query) return true;

      return (
        item.sourceMod.name.toLowerCase().includes(query) ||
        (item.sourceMod.author ?? "").toLowerCase().includes(query) ||
        item.match.matchedFiles.some((file) => file.toLowerCase().includes(query))
      );
    });

    return sortPaired(filtered, sortMode);
  }, [customGroups, groups, matches, rejectedPairings, searchQuery, sortMode, sourceMods, updateStatusBySourceKey]);

  const pairedFileNames = useMemo(() => {
    const names = new Set<string>();

    for (const item of pairedMods) {
      for (const file of item.files) {
        names.add(fileNameKey(file.fileName));
        names.add(fileNameKey(file.fullPath));
      }

      for (const fileName of item.match.matchedFiles) {
        names.add(fileNameKey(fileName));
      }
    }

    return names;
  }, [pairedMods]);

  const pairedGroupKeys = useMemo(() => {
    return new Set(pairedMods.map((item) => item.group?.key).filter((key): key is string => Boolean(key)));
  }, [pairedMods]);

  const allUnmatchedGroups = useMemo(() => {
    return groups.filter((group) => {
      if (pairedGroupKeys.has(group.key)) return false;
      return !group.files.some((file) => pairedFileNames.has(fileNameKey(file.fileName)) || pairedFileNames.has(fileNameKey(file.fullPath)));
    });
  }, [groups, pairedFileNames, pairedGroupKeys]);

  const unmatchedGroups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return allUnmatchedGroups
      .filter((group) => {
        if (!query) return true;
        return (
          group.label.toLowerCase().includes(query) ||
          group.files.some((file) => file.fileName.toLowerCase().includes(query))
        );
      })
      .sort((a, b) => {
        if (sortMode === "modified") return b.modifiedUnix - a.modifiedUnix;
        if (sortMode === "size") return b.sizeBytes - a.sizeBytes;
        if (sortMode === "enabled") {
          const enabledCompare = Number(b.enabled) - Number(a.enabled);
          if (enabledCompare !== 0) return enabledCompare;
        }
        if (sortMode === "disabled") {
          const disabledCompare = Number(!b.enabled) - Number(!a.enabled);
          if (disabledCompare !== 0) return disabledCompare;
        }
        return a.label.localeCompare(b.label);
      });
  }, [allUnmatchedGroups, searchQuery, sortMode]);

  const autoPairQueue = useMemo(() => {
    return allUnmatchedGroups.filter((group) => !unpairableGroups.includes(group.key) && !customGroups.includes(group.key));
  }, [allUnmatchedGroups, customGroups, unpairableGroups]);

  const visiblePaired = useMemo(() => {
    if (view === "updates") return pairedMods.filter((item) => item.match.updateAvailable);
    return pairedMods;
  }, [pairedMods, view]);

  const selectedSet = useMemo(() => new Set(selectedKeys), [selectedKeys]);

  function pairedSelectionKey(item: PairedInstalledMod) {
    return `pair:${item.sourceMod.source}-${item.sourceMod.sourceId}`;
  }

  function groupSelectionKey(group: InstalledGroup) {
    return `group:${group.key}`;
  }

  const visibleSelectionKeys = useMemo(() => {
    const keys: string[] = [];

    if (view === "all" || view === "matched" || view === "updates") {
      keys.push(...visiblePaired.map(pairedSelectionKey));
    }

    if (view === "all" || view === "unmatched") {
      keys.push(...unmatchedGroups.map(groupSelectionKey));
    }

    return keys;
  }, [unmatchedGroups, view, visiblePaired]);

  const selectedFileNames = useMemo(() => {
    const files = new Set<string>();

    for (const item of pairedMods) {
      if (!selectedSet.has(pairedSelectionKey(item))) continue;
      for (const file of item.match.matchedFiles) files.add(file);
    }

    for (const group of groups) {
      if (!selectedSet.has(groupSelectionKey(group))) continue;
      for (const file of group.files) files.add(file.fileName);
    }

    return [...files];
  }, [groups, pairedMods, selectedSet]);

  function toggleSelected(key: string) {
    setSelectedKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }

  function selectVisibleCards() {
    setSelectedKeys((current) => [...new Set([...current, ...visibleSelectionKeys])]);
  }

  function clearSelectedCards() {
    setSelectedKeys([]);
  }

  const updateCount = pairedMods.filter((item) => item.match.updateAvailable).length;
  const enabledGroups = groups.filter((group) => group.enabled).length;
  const disabledGroups = groups.length - enabledGroups;

  function sourceImageForCard(mod: SourceModSummary) {
    const direct = sourceImageUrl(mod);
    if (direct) return direct;

    const exact = sourceMods.find((candidate) => (
      candidate.source === mod.source
      && candidate.sourceId === mod.sourceId
      && sourceImageUrl(candidate)
    ));

    if (exact) return sourceImageUrl(exact);

    const nameKey = compact(normalizeInstalledName(mod.name));
    if (nameKey.length >= 5) {
      const byName = sourceMods.find((candidate) => (
        candidate.source === mod.source
        && compact(normalizeInstalledName(candidate.name)) === nameKey
        && sourceImageUrl(candidate)
      ));

      if (byName) return sourceImageUrl(byName);
    }

    return null;
  }

  function mergeSourceCards(incoming: SourceModSummary[]) {
    if (incoming.length === 0) return;

    setSourceMods((current) => {
      const map = new Map(current.map((mod) => [sourceKey(mod), mod]));

      for (const mod of incoming) {
        map.set(sourceKey(mod), mergeSourceSummary(map.get(sourceKey(mod)), mod));
      }

      const next = [...map.values()];
      saveInstalledEnrichedSourceCache(next);
      return next;
    });
  }

  async function repairInstalledThumbnails() {
    if (busyKey || enriching || nexusIndexing || backgroundPairing || updatesBusy) {
      setPairingStatus("Another Installed task is already running.");
      return;
    }

    const targets = pairedMods
      .filter((item) => !sourceImageForCard(item.sourceMod))
      .slice(0, 24);

    if (targets.length === 0) {
      setPairingStatus("Installed thumbnails already look filled for the visible paired cards.");
      return;
    }

    setBusyKey("repair-thumbnails");
    setPairingStatus(`Repairing thumbnails for ${targets.length} paired card(s)...`);
    reportTaskProgress("Repair thumbnails", 8, "Loading source detail images...");

    try {
      const repaired: SourceModSummary[] = [];

      for (let index = 0; index < targets.length; index += 1) {
        const item = targets[index];
        const progress = 12 + Math.round(((index + 1) / targets.length) * 76);

        reportTaskProgress("Repair thumbnails", progress, `${index + 1}/${targets.length}: ${item.sourceMod.name}`);
        await yieldToUi();

        try {
          const detail =
            item.sourceMod.source === "nexus"
              ? await invoke<SourceModDetail>("fetch_nexus_mod_detail", { modId: item.sourceMod.sourceId })
              : await invoke<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: item.sourceMod.sourceId });

          const summary = sourceSummaryFromDetail(detail);
          if (sourceImageUrl(summary)) repaired.push(summary);
        } catch {
          // Some source pages do not expose images. Keep the clean fallback badge.
        }
      }

      mergeSourceCards(repaired);
      reportTaskProgress("Repair thumbnails", 100, `Filled ${repaired.length}/${targets.length} thumbnail(s).`);
      setPairingStatus(`Thumbnail repair checked ${targets.length} paired card(s), filled ${repaired.length}. Cards without source images now use clean source badges.`);
    } finally {
      setBusyKey(null);
      clearTaskProgressSoon();
    }
  }


  async function checkStateFirstUpdates() {
    setUpdatesBusy(true);
    setStatus("Checking updates for Tsuki-downloaded receipt mods only...");
    try {
      const updates = await invoke<SourceUpdateStatus[]>("check_installed_source_updates");
      writeReceiptUpdateCheckCache(updates, "manual");
      setReceiptUpdateCache(readReceiptUpdateCheckCache());
      setSourceUpdates(updates);
      const count = updates.filter((update) => update.updateAvailable).length;
      setStatus(`Receipt update check complete: ${count}/${updates.length} Tsuki-downloaded mod(s) have updates.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdatesBusy(false);
    }
  }

  async function refreshInstalled(clearWhenDone = true): Promise<PakModFile[]> {
    setStatus("Scanning installed pak files...");

    try {
      const prunePromise = invoke<string>("prune_stale_install_receipts").catch(() => "");
      const scan = await invoke<PakScanResult>("scan_pak_mods");
      reportTaskProgress("Scan Installed", 45, `Found ${scan.pakFileCount} PAK-family file(s).`);
      setScanResult(scan);

      const pairState = loadPairState(scan.pakMods);
      const cache = loadSourceModsFromCache();
      reportTaskProgress("Scan Installed", 72, "Loading source/state records...");
      const [backendIndex, installedState] = await Promise.all([
        invoke<SourceModSummary[]>("list_source_index", { source: null, limit: 600 }).catch(() => []),
        invoke<InstalledStateRecord[]>("list_installed_state_records").catch(() => []),
      ]);
      const sourceMap = new Map<string, SourceModSummary>();

      // State-first: Tsuki-installed mods come from receipts/installed-state first.
      // Browse/source caches are only extra context, not the identity source of truth.
      for (const record of installedState) {
        const summary = sourceSummaryFromInstalledState(record);
        if (summary) sourceMap.set(sourceKey(summary), summary);
      }

      for (const mod of cache.mods) {
        if (!sourceMap.has(sourceKey(mod))) sourceMap.set(sourceKey(mod), mod);
      }

      for (const mod of backendIndex) {
        if (!sourceMap.has(sourceKey(mod))) sourceMap.set(sourceKey(mod), mod);
      }

      if (pairState?.sourceMods?.length) {
        for (const mod of pairState.sourceMods) {
          if (!sourceMap.has(sourceKey(mod))) sourceMap.set(sourceKey(mod), mod);
        }
      }

      const indexedSources = filterPayday3SourceMods([...sourceMap.values()]);

      if (pairState) {
        setSourceMods(filterPayday3SourceMods(pairState.sourceMods));
        setMatches(pairState.matches);
        setSourceCacheAge(cacheAge(pairState.savedAt));
        setSourceCacheBuckets(cache.cacheBuckets + 1);
        setPairingStatus(`Loaded cached pair state from ${cacheAge(pairState.savedAt)} ago. No background re-pairing was started.`);
      } else if (indexedSources.length > 0) {
        setSourceMods(filterPayday3SourceMods(indexedSources));
        setMatches({});
        setSourceCacheAge(cacheAge(cache.newestCache));
        setSourceCacheBuckets(cache.cacheBuckets + (backendIndex.length > 0 ? 1 : 0));
        setPairingStatus(`Loaded ${indexedSources.length} source/state records. Press Re-pair/Search Pair when you actually want matching work.`);
      } else {
        setPairingStatus("No source cache found yet. Browse mods first, or use Auto Pair manually.");
      }

      await prunePromise;
      reportTaskProgress("Scan Installed", 100, "Installed library loaded.");
      setStatus(`Found ${scan.pakFileCount} pak-related files. UI loaded without background pairing.`);
      return scan.pakMods;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      return rawFiles;
    } finally {
      if (clearWhenDone) finishTaskProgress("Scan Installed", "Installed library loaded.");
    }
  }

  async function runPairing(nextSourceMods: SourceModSummary[], filesForStatus = rawFiles): Promise<Record<string, InstalledSourceMatch>> {
    if (pairingBusyRef.current) {
      setPairingStatus("Pairing is already running. Skipped duplicate request.");
      return matches;
    }

    pairingBusyRef.current = true;

    const cachedPairState = loadPairState(filesForStatus);

    if (cachedPairState) {
      const sourceMap = new Map(nextSourceMods.map((mod) => [sourceKey(mod), mod]));

      for (const mod of cachedPairState.sourceMods) {
        sourceMap.set(sourceKey(mod), mod);
      }

      const mergedSources = [...sourceMap.values()];
      setSourceMods(mergedSources);
      setMatches(cachedPairState.matches);
      setPairingStatus(`Loaded stable cached pair state from ${cacheAge(cachedPairState.savedAt)} ago. Re-pairing only because you requested it...`);
      nextSourceMods = mergedSources;
    }

    if (nextSourceMods.length === 0) {
      if (cachedPairState) {
        setSourceMods(cachedPairState.sourceMods);
        setMatches(cachedPairState.matches);
        setPairingStatus(`Loaded cached pair state from ${cacheAge(cachedPairState.savedAt)} ago. Auto Pair can refresh later.`);
        pairingBusyRef.current = false;
        finishTaskProgress("Pair Installed", "Loaded cached pair state.");
        return cachedPairState.matches;
      }

      setPairingStatus("No source cache found yet. Auto Pair will rebuild pairings slowly.");
      setMatches({});
      pairingBusyRef.current = false;
      finishTaskProgress("Pair Installed", "No source cache found.");
      return {};
    }

    const cappedSourceMods = nextSourceMods.slice(0, 550);

    if (nextSourceMods.length > cappedSourceMods.length) {
      setPairingStatus(`Pairing first ${cappedSourceMods.length}/${nextSourceMods.length} cached source cards for speed. Auto Pair can search missing mods later.`);
    } else {
      setPairingStatus(`Pairing ${cappedSourceMods.length} source cards against ${filesForStatus.length} installed files...`);
    }

    reportTaskProgress("Pair Installed", 35, `Checking ${cappedSourceMods.length} source cards...`);
    await yieldToUi(1);

    try {
      const result = await invoke<InstalledSourceMatch[]>("match_installed_source_mods", {
        sourceMods: cappedSourceMods,
      });

      reportTaskProgress("Pair Installed", 62, "Running direct local filename proof pass...");
      const directResult = directPairMatchesFromGroups(cappedSourceMods, groups, matches, "all");
      const combinedResult = [...result, ...directResult];
      const cleanedExisting = pruneNumericMismatchPairMatches(cappedSourceMods, matches);

      const { next, keptExisting } = mergePairResultsSafely(cleanedExisting.next, combinedResult);

      reportTaskProgress("Pair Installed", 78, "Saving matched pair state...");
      setMatches(next);
      savePairState(cappedSourceMods, next, filesForStatus);
      saveInstalledEnrichedSourceCache(cappedSourceMods);

      const installed = Object.values(next).filter((match) => match.installed).length;
      const updates = Object.values(next).filter((match) => match.updateAvailable).length;

      reportTaskProgress("Pair Installed", 100, `Paired ${installed} source card(s).`);
      setPairingStatus(`Proof-paired ${installed}/${cappedSourceMods.length} source cards. Direct local proof added ${directResult.length} source pair(s). Removed ${cleanedExisting.removed} numeric mismatch pair(s). ${updates} possible updates. Preserved ${keptExisting} proven old pair(s).`);
      pairingBusyRef.current = false;
      clearTaskProgressSoon();
      return next;
    } catch (error) {
      pairingBusyRef.current = false;
      clearTaskProgressSoon();
      setPairingStatus(error instanceof Error ? error.message : String(error));
      return {};
    }
  }

  function repairPairingCache() {
    try {
      removeLocalStorageKeys(PAIR_REPAIR_CACHE_KEYS);
      setMatches({});
      setRejectedPairings([]);
      setCustomGroups([]);
      setUnpairableGroups([]);
      setPairingStatus("Cleared old pairing cache/skips. Running one requested re-pair...");
      void refreshPairing(rawFiles);
    } catch {
      setPairingStatus("Could not clear local pairing cache.");
    }
  }

  async function diagnoseModWorkshopPairing() {
    setBusyKey("diagnose-modworkshop-pairing");
    setPairingStatus("Running ModWorkshop pairing diagnostics once. Debug Report will reuse this cached result so the app does not lag.");

    try {
      const result = await invoke<string>("diagnose_modworkshop_pairing");
      setPairingStatus(result);
    } catch (error) {
      setPairingStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function removeRaidWw2BadInstall() {
    setBusyKey("remove-raid-ww2");

    try {
      const result = await invoke<string>("remove_raid_ww2_bad_install");
      setStatus(result);
      setPairingStatus("Removed the known bad RAID: World War II ModWorkshop install, then refreshed installed state.");
      await refreshInstalled();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function syncInstalledLibrary() {
    if (busyKey || enriching || nexusIndexing || backgroundPairing || updatesBusy || pairingBusyRef.current) {
      setPairingStatus("Another Installed task is already running.");
      return;
    }

    setBusyKey("sync-installed");
    setStatus("Syncing installed library...");
    setPairingStatus("Sync Installed: scan files → load source records → repair safe pairs.");
    reportTaskProgress("Sync Installed", 8, "Starting installed sync...");

    try {
      const files = await refreshInstalled(false);
      reportTaskProgress("Sync Installed", 58, "Pairing installed mods...");
      await refreshPairing(files);
      setStatus("Installed library synced.");
      setPairingStatus("Sync complete. Use Advanced only for diagnostics, cleanup, or special repairs.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
      clearTaskProgressSoon();
    }
  }


  async function refreshPairing(filesForStatus = rawFiles, liveSearch: ModSourceKind | "all" | "none" = "none") {
    reportTaskProgress("Pair Installed", 12, "Loading source index, cache, and state records...");
    const cache = loadSourceModsFromCache();
    const pairState = loadPairState(filesForStatus);
    const [backendIndex, installedState] = await Promise.all([
      invoke<SourceModSummary[]>("list_source_index", { source: null, limit: 900 }).catch(() => []),
      invoke<InstalledStateRecord[]>("list_installed_state_records").catch(() => []),
    ]);
    const sourceMap = new Map<string, SourceModSummary>();

    for (const record of installedState) {
      const summary = sourceSummaryFromInstalledState(record);
      if (summary) sourceMap.set(sourceKey(summary), summary);
    }

    for (const mod of cache.mods) {
      if (!sourceMap.has(sourceKey(mod))) sourceMap.set(sourceKey(mod), mod);
    }

    for (const mod of backendIndex) {
      if (!sourceMap.has(sourceKey(mod))) sourceMap.set(sourceKey(mod), mod);
    }

    if (pairState) {
      for (const mod of pairState.sourceMods) {
        if (!sourceMap.has(sourceKey(mod))) sourceMap.set(sourceKey(mod), mod);
      }

      setMatches(pairState.matches);
    }

    if (liveSearch !== "none") {
      const limit = liveSearch === "all" ? Math.max(searchPairLimit, 42) : Math.max(searchPairLimit, 28);
      await liveSearchGroupsIntoSourceMap(liveSearch, sourceMap, limit, liveSearch === "all" ? "Pair All" : `Pair ${liveSearch === "modworkshop" ? "Workshop" : "Nexus"}`);
    }

    const nextMods = filterPayday3SourceMods([...sourceMap.values()]);
    setSourceMods(nextMods);
    setSourceCacheAge(cacheAge(Math.max(cache.newestCache, pairState?.savedAt ?? 0)));
    setSourceCacheBuckets(cache.cacheBuckets + (pairState ? 1 : 0) + (backendIndex.length > 0 ? 1 : 0));

    reportTaskProgress("Pair Installed", 25, `Loaded ${nextMods.length} source card(s).`);
    await runPairing(nextMods, filesForStatus);
  }

  async function pairSource(source: ModSourceKind) {
    if (busyKey || enriching || nexusIndexing || backgroundPairing || updatesBusy || pairingBusyRef.current) {
      setPairingStatus("Another Installed task is already running.");
      return;
    }

    const label = source === "modworkshop" ? "Workshop" : "Nexus";
    const busyId = `pair-${source}`;
    setBusyKey(busyId);
    setPairingStatus(`Pair ${label}: loading installed files and source cards...`);
    reportTaskProgress(`Pair ${label}`, 5, "Preparing source-specific pairing...");

    try {
      const files = rawFiles.length > 0 ? rawFiles : await refreshInstalled(false);
      reportTaskProgress(`Pair ${label}`, 22, "Loading source index...");
      const cache = loadSourceModsFromCache();
      const pairState = loadPairState(files);
      const [backendIndex, installedState] = await Promise.all([
        invoke<SourceModSummary[]>("list_source_index", { source, limit: 900 }).catch(() => []),
        invoke<InstalledStateRecord[]>("list_installed_state_records").catch(() => []),
      ]);

      const sourceMap = new Map<string, SourceModSummary>();

      for (const record of installedState) {
        const summary = sourceSummaryFromInstalledState(record);
        if (summary?.source === source) sourceMap.set(sourceKey(summary), summary);
      }

      for (const mod of cache.mods) {
        if (mod.source === source && !sourceMap.has(sourceKey(mod))) sourceMap.set(sourceKey(mod), mod);
      }

      for (const mod of backendIndex) {
        if (mod.source === source && !sourceMap.has(sourceKey(mod))) sourceMap.set(sourceKey(mod), mod);
      }

      if (pairState?.sourceMods?.length) {
        for (const mod of pairState.sourceMods) {
          if (mod.source === source && !sourceMap.has(sourceKey(mod))) sourceMap.set(sourceKey(mod), mod);
        }
      }

      const liveStats = await liveSearchGroupsIntoSourceMap(source, sourceMap, Math.max(searchPairLimit, source === "modworkshop" ? 42 : 24), `Pair ${label}`);

      const sourceOnly = filterPayday3SourceMods([...sourceMap.values()]).filter((mod) => mod.source === source);
      const mergedSources = filterPayday3SourceMods([...sourceMods, ...sourceOnly]);
      const dedupedSources = [...new Map(mergedSources.map((mod) => [sourceKey(mod), mod])).values()];

      setSourceMods(dedupedSources);
      setSourceCacheAge(cacheAge(Math.max(cache.newestCache, pairState?.savedAt ?? 0)));
      setSourceCacheBuckets(cache.cacheBuckets + (backendIndex.length > 0 ? 1 : 0) + (pairState ? 1 : 0));

      if (sourceOnly.length === 0) {
        setPairingStatus(`Pair ${label}: no ${label} source cards found. Open Browse and load ${label} first.`);
        reportTaskProgress(`Pair ${label}`, 100, "No source cards found.");
        clearTaskProgressSoon();
        return;
      }

      reportTaskProgress(`Pair ${label}`, 48, `Matching ${sourceOnly.length} ${label} card(s)...`);

      const result = await invoke<InstalledSourceMatch[]>("match_installed_source_mods", {
        sourceMods: sourceOnly.slice(0, 900),
      });

      reportTaskProgress(`Pair ${label}`, 70, "Running direct local filename proof pass...");
      const directResult = directPairMatchesFromGroups(sourceOnly, groups, matches, source);
      const combinedResult = [...result, ...directResult];
      const cleanedExisting = pruneNumericMismatchPairMatches(sourceOnly, matches);

      reportTaskProgress(`Pair ${label}`, 84, "Merging pair results...");
      const { next: nextMatches, keptExisting } = mergePairResultsSafely(cleanedExisting.next, combinedResult);

      setMatches(nextMatches);
      savePairState(dedupedSources, nextMatches, files);
      saveInstalledEnrichedSourceCache(dedupedSources);

      const paired = result.filter((match) => match.installed).length;
      const candidates = result.filter((match) => !match.installed && match.confidence >= 60).length;
      reportTaskProgress(`Pair ${label}`, 100, `Paired ${paired}/${result.length}.`);
      setPairingStatus(`Pair ${label} complete: paired ${paired}/${combinedResult.length}. Direct local proof added ${directResult.length} source pair(s). Removed ${cleanedExisting.removed} numeric mismatch pair(s). Live searched ${liveStats.checked} file group(s), found ${liveStats.foundById + liveStats.foundBySearch} source hit(s). Preserved ${keptExisting} proven old pair(s). ${candidates} manual candidate(s) stayed unpaired.`);
      if (source === "modworkshop") {
        void invoke<string>("diagnose_modworkshop_pairing").catch(() => "");
      }
    } catch (error) {
      setPairingStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
      clearTaskProgressSoon();
    }
  }

  async function pairAllSources() {
    if (busyKey || enriching || nexusIndexing || backgroundPairing || updatesBusy || pairingBusyRef.current) {
      setPairingStatus("Another Installed task is already running.");
      return;
    }

    setBusyKey("pair-all");
    setPairingStatus("Pair All: loading installed files and all source cards...");
    reportTaskProgress("Pair All", 5, "Preparing all-source pairing...");

    try {
      const files = rawFiles.length > 0 ? rawFiles : await refreshInstalled(false);
      reportTaskProgress("Pair All", 28, "Loading Nexus + ModWorkshop source index...");
      await refreshPairing(files, "all");
      reportTaskProgress("Pair All", 100, "All-source live pairing complete.");
      setPairingStatus("Pair All complete. Use Pair All Workshop or Pair All Nexus if one source still needs a targeted pass.");
      void invoke<string>("diagnose_modworkshop_pairing").catch(() => "");
    } catch (error) {
      setPairingStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
      clearTaskProgressSoon();
    }
  }






  async function fetchSourceDetailForSummary(sourceMod: SourceModSummary) {
    const detail =
      sourceMod.source === "nexus"
        ? await invoke<SourceModDetail>("fetch_nexus_mod_detail", { modId: sourceMod.sourceId })
        : await invoke<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: sourceMod.sourceId });

    return {
      ...detail,
      tags: Array.isArray(detail.tags) ? detail.tags : [],
      files: Array.isArray(detail.files) ? detail.files : [],
      images: Array.isArray(detail.images) ? detail.images : [],
      stats: Array.isArray(detail.stats) ? detail.stats : [],
    };
  }

  async function enrichCandidateDetailsForGroup(_group: InstalledGroup, sourceMap: Map<string, SourceModSummary>, candidates: SourceModSummary[], limit = 8) {
    let enriched = 0;

    for (const candidate of candidates.slice(0, limit)) {
      try {
        const detail = await fetchSourceDetailForSummary(candidate);
        const summary = sourceSummaryFromDetail(detail);
        sourceMap.set(sourceKey(summary), summary);
        enriched += 1;
      } catch {
        // Details are optional. Search results can still be used.
      }

      await yieldToUi(20);
    }

    return enriched;
  }

  function candidatesForGroup(group: InstalledGroup, modsForSearch: SourceModSummary[], minScore = 25, limit = 50) {
    return modsForSearch
      .map((mod) => ({ mod, score: scoreSourceForGroup(mod, group) }))
      .filter((item) => item.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.mod);
  }

  
  function bestScoredCandidateForGroup(group: InstalledGroup, candidates: SourceModSummary[]) {
    return candidates
      .map((mod) => ({ mod, score: scoreSourceForGroup(mod, group) }))
      .sort((a, b) => b.score - a.score)
      [0] ?? null;
  }

function bestProofMatchForGroup(group: InstalledGroup, matched: InstalledSourceMatch[], candidates: SourceModSummary[]) {
    const candidateKeys = new Set(candidates.map((mod) => `${mod.source}-${mod.sourceId}`));
    const groupFiles = new Set(group.files.map((file) => file.fileName.toLowerCase()));

    return matched
      .filter((match) => match.installed && match.confidence >= 86)
      .filter((match) => candidateKeys.has(`${match.source}-${match.sourceId}`))
      .filter((match) => match.matchedFiles.some((fileName) => groupFiles.has(fileName.toLowerCase())))
      .sort((a, b) => b.confidence - a.confidence)
      [0] ?? null;
  }

  async function searchGroupIntoSourceMap(group: InstalledGroup, sourceMap: Map<string, SourceModSummary>, sourceFilter: ModSourceKind | "all" = "all") {
    let foundById = 0;
    let foundBySearch = 0;
    let failed = 0;

    try {
      const indexed = filterPayday3SourceMods(await invoke<SourceModSummary[]>("list_source_index", { source: sourceFilter === "all" ? null : sourceFilter, limit: 900 }));
      const scored = indexed
        .map((mod) => ({ mod, score: scoreSourceForGroup(mod, group) }))
        .filter((item) => item.score >= 80)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);

      for (const item of scored) {
        sourceMap.set(sourceKey(item.mod), item.mod);
      }

      foundBySearch += scored.length;
    } catch {
      // Source index is optional.
    }

    const id = sourceFilter !== "nexus" ? inferModWorkshopId(group) : null;

    if (id && !sourceMap.has(`modworkshop-${id}`)) {
      try {
        const detail = await invoke<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: id });
        const summary = sourceSummaryFromDetail(detail);
        const labelCompact = compact(group.label);
        const summaryCompact = compact(normalizeInstalledName(summary.name));

        if (
          summary.sourceId === id ||
          (labelCompact.length >= 4 && summaryCompact.includes(labelCompact)) ||
          (summaryCompact.length >= 4 && labelCompact.includes(summaryCompact))
        ) {
          sourceMap.set(sourceKey(summary), summary);
          foundById += 1;
        }
      } catch {
        failed += 1;
      }

      await yieldToUi();
    }

    const queries = searchQueriesForGroup(group).slice(0, 4);

    for (const query of queries) {
      let queryFound = 0;

      if (sourceFilter !== "nexus") {
        try {
          const results = filterPayday3SourceMods(await invoke<SourceModSummary[]>("search_modworkshop_mods_for_query", { query }));

          for (const result of results.slice(0, 25)) {
            sourceMap.set(sourceKey(result), result);
          }

          queryFound += results.length;
        } catch {
          failed += 1;
        }

        await yieldToUi();
      }

      if (sourceFilter !== "modworkshop") {
        try {
          const nexusResults = filterPayday3SourceMods(await invoke<SourceModSummary[]>("search_nexus_mods_for_query", { query }));

          for (const result of nexusResults.slice(0, 25)) {
            sourceMap.set(sourceKey(result), result);
          }

          queryFound += nexusResults.length;
        } catch {
          failed += 1;
        }

        await yieldToUi();
      }

      foundBySearch += queryFound;

      if (queryFound > 0) break;
      await yieldToUi();
    }

    // Network search happens only for selected Try Pair / Search Pair, not light automatic pairing.
    // Full Nexus ID sweeps are still blocked from automatic pairing.

    return {
      found: foundById + foundBySearch,
      foundById,
      foundBySearch,
      failed,
    };
  }

  function livePairTargets(limit: number) {
    const targetPool = allUnmatchedGroups.length > 0 ? allUnmatchedGroups : groups;

    return targetPool
      .filter((group) => !unpairableGroups.includes(group.key))
      .slice(0, Math.max(0, limit));
  }

  async function liveSearchGroupsIntoSourceMap(
    sourceFilter: ModSourceKind | "all",
    sourceMap: Map<string, SourceModSummary>,
    limit: number,
    label: string,
  ) {
    const targets = livePairTargets(limit);
    const sourceLabel = sourceFilter === "all" ? "sources" : sourceFilter === "modworkshop" ? "Workshop" : "Nexus";
    let foundById = 0;
    let foundBySearch = 0;
    let failed = 0;

    if (targets.length === 0) {
      return { checked: 0, foundById, foundBySearch, failed };
    }

    for (let index = 0; index < targets.length; index += 1) {
      const group = targets[index];
      const progress = 32 + Math.round(((index + 1) / targets.length) * 30);

      reportTaskProgress(label, progress, `Live searching ${sourceLabel} ${index + 1}/${targets.length}: ${group.label}`);
      setPairingStatus(`${label}: live searching ${sourceLabel} ${index + 1}/${targets.length}: ${group.label}`);
      await yieldToUi();

      const result = await searchGroupIntoSourceMap(group, sourceMap, sourceFilter);
      foundById += result.foundById;
      foundBySearch += result.foundBySearch;
      failed += result.failed;

      if ((index + 1) % 4 === 0 || index === targets.length - 1) {
        const nextMods = filterPayday3SourceMods([...sourceMap.values()]);
        setSourceMods(nextMods);
        saveInstalledEnrichedSourceCache(nextMods);
        await yieldToUi(35);
      }
    }

    return { checked: targets.length, foundById, foundBySearch, failed };
  }



  async function enrichUnmatchedFromFilenames() {
    const sourceMap = new Map(filterPayday3SourceMods(sourceMods).map((mod) => [sourceKey(mod), mod]));
    const targetGroups = (allUnmatchedGroups.length > 0 ? allUnmatchedGroups : groups)
      .filter((group) => !unpairableGroups.includes(group.key))
      .slice(0, searchPairLimit);

    if (targetGroups.length === 0) {
      setPairingStatus("No unmatched groups to search. Clear skipped if you want to retry unpairable groups.");
      return;
    }

    setEnriching(true);
    setBusyKey("enrich");

    try {
      let foundById = 0;
      let foundBySearch = 0;
      let failed = 0;
      const newlyUnpairable = new Set(unpairableGroups);

      for (let index = 0; index < targetGroups.length; index += 1) {
        const group = targetGroups[index];

        setPairingStatus(`Search Pair ${index + 1}/${targetGroups.length}: ${group.label}`);
        await yieldToUi();

        const result = await searchGroupIntoSourceMap(group, sourceMap);
        reportTaskProgress("Search Pair", 35 + Math.round(((index + 1) / targetGroups.length) * 45), "Source candidates loaded.");

        foundById += result.foundById;
        foundBySearch += result.foundBySearch;
        failed += result.failed;

        if (result.found === 0) {
          newlyUnpairable.add(group.key);
        }

        const nextMods = [...sourceMap.values()];
        setSourceMods(nextMods);
        saveInstalledEnrichedSourceCache(nextMods);

        if ((index + 1) % 2 === 0 || index === targetGroups.length - 1) {
          await runPairing(nextMods, rawFiles);
          await yieldToUi(50);
        }
      }

      const skipped = [...newlyUnpairable];
      setUnpairableGroups(skipped);
      saveUnpairableGroups(skipped);

      const nextMods = [...sourceMap.values()];
      setSourceMods(nextMods);
      saveInstalledEnrichedSourceCache(nextMods);
      setSourceCacheAge("just now");
      setSourceCacheBuckets((current) => Math.max(current, 1));

      await runPairing(nextMods, rawFiles);

      const remaining = Math.max(0, unmatchedGroups.filter((group) => !newlyUnpairable.has(group.key)).length - searchPairLimit);
      setPairingStatus(
        `Search Pair checked ${targetGroups.length} groups: ${foundById} ID hits, ${foundBySearch} search hits${failed ? `, ${failed} failed` : ""}${remaining ? `. ${remaining} still queued.` : "."}`,
      );
      finishTaskProgress("Search Pair", "Search pairing complete.");
    } finally {
      setEnriching(false);
      setBusyKey(null);
    }
  }

  function markGroupCustom(group: InstalledGroup | null) {
    if (!group) {
      setStatus("No installed group was attached to that card.");
      return;
    }

    const nextCustom = [...new Set([...customGroups, group.key])];
    const nextSkipped = [...new Set([...unpairableGroups, group.key])];

    setCustomGroups(nextCustom);
    saveStringList(CUSTOM_GROUPS_KEY, nextCustom);
    setUnpairableGroups(nextSkipped);
    saveUnpairableGroups(nextSkipped);
    setStatus(`${group.label} marked as Custom/Local. It will not auto-pair.`);
  }

  function clearPairingGuards() {
    setRejectedPairings([]);
    setCustomGroups([]);
    saveStringList(REJECTED_PAIRINGS_KEY, []);
    saveStringList(CUSTOM_GROUPS_KEY, []);
    setStatus("Cleared rejected pairings and custom/local marks.");
  }

  async function buildNexusIndex() {
    setNexusIndexing(true);
    setBusyKey("nexus-index");
    reportTaskProgress("Rebuild Nexus", 8, "Loading ordered Nexus feeds...");
    setPairingStatus("Rebuilding Nexus cache from GraphQL/ordered Nexus feeds. No raw ID sweep.");

    try {
      const nexusMods = await invoke<SourceModSummary[]>("build_nexus_payday3_index", { maxId: 0 });
      reportTaskProgress("Rebuild Nexus", 72, `Loaded ${nexusMods.length} cards; merging cache...`);
      const sourceMap = new Map(filterPayday3SourceMods(sourceMods).map((mod) => [sourceKey(mod), mod]));

      for (const mod of nexusMods) {
        sourceMap.set(sourceKey(mod), mod);
      }

      const nextMods = [...sourceMap.values()];
      setSourceMods(nextMods);
      saveInstalledEnrichedSourceCache(nextMods);
      setSourceCacheAge("just now");
      setSourceCacheBuckets((current) => Math.max(current, 1));

      savePairState(nextMods, matches, rawFiles);

      setPairingStatus(`Rebuilt Nexus cache with ${nexusMods.length} ordered source cards. Existing matches were preserved; use Try Pair/Search Pair for targeted pairing.`);
    } catch (error) {
      setPairingStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setNexusIndexing(false);
      setBusyKey(null);
      clearTaskProgress();
    }
  }


  function mergeMatchArray(result: InstalledSourceMatch[]) {
    const next: Record<string, InstalledSourceMatch> = { ...matches };

    for (const match of result) {
      next[`${match.source}-${match.sourceId}`] = match;
    }

    setMatches(next);
    savePairState(sourceMods, next, rawFiles);
    return next;
  }

  function candidateSourceModsForGroup(group: InstalledGroup, limit = 12) {
    return sourceMods
      .map((mod) => ({ mod, score: scoreSourceForGroup(mod, group) }))
      .filter((item) => item.score >= 80)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.mod);
  }

  async function runBackgroundPairStep(reason = "Light Auto Pair") {
    if (backgroundPairing || enriching || nexusIndexing || pairingBusyRef.current) return;

    const group = autoPairQueue[0];

    if (!group) {
      setAutoPairStatus(allUnmatchedGroups.length === 0 ? "Light Auto Pair idle: everything is paired." : "Light Auto Pair idle: only saved skipped groups remain.");
      return;
    }

    const candidates = candidateSourceModsForGroup(group, 10);

    if (candidates.length === 0) {
      const skipped = [...new Set([...unpairableGroups, group.key])];
      setUnpairableGroups(skipped);
      saveUnpairableGroups(skipped);
      setAutoPairStatus(`${reason}: no cached proof candidates for ${group.label}. Saved as skipped so it will not retry on relaunch.`);
      return;
    }

    setBackgroundPairing(true);
    setBusyKey("light-auto-pair");
    setAutoPairStatus(`${reason}: cache-checking ${group.label} against ${candidates.length} candidate(s).`);

    try {
      await yieldToUi(120);

      const result = await invoke<InstalledSourceMatch[]>("match_installed_source_mods", {
        sourceMods: candidates,
      });

      const nextMatches = mergeMatchArray(result);
      const pairedNow = groupIsPairedByMatches(group, nextMatches, candidates);

      if (pairedNow) {
        const skipped = unpairableGroups.filter((key) => key !== group.key);
        setUnpairableGroups(skipped);
        saveUnpairableGroups(skipped);
        setAutoPairStatus(`${reason}: paired ${group.label} from cache.`);
      } else {
        const skipped = [...new Set([...unpairableGroups, group.key])];
        setUnpairableGroups(skipped);
        saveUnpairableGroups(skipped);
        setAutoPairStatus(`${reason}: candidates failed proof matching for ${group.label}. Saved as skipped.`);
      }
    } catch (error) {
      setAutoPairStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBackgroundPairing(false);
      setBusyKey(null);
    }
  }

  async function tryPairGroup(group: InstalledGroup) {
    const sourceMap = new Map(filterPayday3SourceMods(sourceMods).map((mod) => [sourceKey(mod), mod]));
    const withoutCurrentSkip = unpairableGroups.filter((key) => key !== group.key);
    setUnpairableGroups(withoutCurrentSkip);
    saveUnpairableGroups(withoutCurrentSkip);
    setBusyKey(`try-pair-${group.key}`);
    reportTaskProgress("Try Pair", 10, group.label);
    setPairingStatus(`Trying selected pair for ${group.label}...`);

    try {
      const result = await searchGroupIntoSourceMap(group, sourceMap);
      const nextMods = [...sourceMap.values()];
      const candidates = nextMods
        .map((mod) => ({ mod, score: scoreSourceForGroup(mod, group) }))
        .filter((item) => item.score >= 35)
        .sort((a, b) => b.score - a.score)
        .slice(0, 40)
        .map((item) => item.mod);

      await enrichCandidateDetailsForGroup(group, sourceMap, candidates, 8);
      const enrichedMods = [...sourceMap.values()];
      const enrichedCandidates = candidatesForGroup(group, enrichedMods, 25, 50);

      setSourceMods(enrichedMods);
      saveInstalledEnrichedSourceCache(enrichedMods);

      if (enrichedCandidates.length === 0 && result.found === 0) {
        const skipped = [...new Set([...unpairableGroups, group.key])];
        setUnpairableGroups(skipped);
        saveUnpairableGroups(skipped);
        setPairingStatus(`${group.label}: no source candidates found. Saved as skipped.`);
        return;
      }

      reportTaskProgress("Reinstall from Tsuki", 38, "Running proof matcher...");
      reportTaskProgress("Try Pair", 72, "Matching local file proof...");
      const matched = await invoke<InstalledSourceMatch[]>("match_installed_source_mods", {
        sourceMods: enrichedCandidates.length > 0 ? enrichedCandidates : enrichedMods.slice(0, 30),
      });
      const nextMatches = mergeMatchArray(matched);
      const pairedNow = Boolean(bestProofMatchForGroup(group, matched, enrichedCandidates)) || groupIsPairedByMatches(group, nextMatches, enrichedCandidates.length > 0 ? enrichedCandidates : enrichedMods);

      if (pairedNow) {
        const skipped = unpairableGroups.filter((key) => key !== group.key);
        setUnpairableGroups(skipped);
        saveUnpairableGroups(skipped);
        setPairingStatus(`${group.label}: paired from selected Try Pair.`);
      } else {
        const skipped = [...new Set([...unpairableGroups, group.key])];
        setUnpairableGroups(skipped);
        saveUnpairableGroups(skipped);
        setPairingStatus(`${group.label}: no proof match. Saved as skipped so it will not loop.`);
      }
    } catch (error) {
      setPairingStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
      clearTaskProgress();
    }
  }

  async function reinstallGroupFromTsuki(group: InstalledGroup) {
    const sourceMap = new Map(filterPayday3SourceMods(sourceMods).map((mod) => [sourceKey(mod), mod]));
    const replaceFileNames = group.files.map((file) => file.fileName);
    const busyId = `reinstall-${group.key}`;

    setBusyKey(busyId);
    reportTaskProgress("Reinstall from Tsuki", 5, `Finding source for ${group.label}...`);
    setPairingStatus(`Reinstall from Tsuki: finding source for ${group.label}...`);

    try {
      const result = await searchGroupIntoSourceMap(group, sourceMap);
      let candidatePool = [...sourceMap.values()];
      let candidates = candidatesForGroup(group, candidatePool, 25, 50);

      reportTaskProgress("Reinstall from Tsuki", 22, "Loading source details for proof...");
      await enrichCandidateDetailsForGroup(group, sourceMap, candidates, 10);
      candidatePool = [...sourceMap.values()];
      candidates = candidatesForGroup(group, candidatePool, 25, 50);

      if (candidates.length === 0 && result.found === 0) {
        setPairingStatus(`${group.label}: no source candidate found. Could not safely reinstall from Tsuki.`);
        recordRuntimeDiagnostic("Reinstall from Tsuki", "blocked", "No source candidate found.", [group.label, `Candidates found: ${candidates.length}`, `Search results found: ${result.found}`]);
        return;
      }

      const matched = await invoke<InstalledSourceMatch[]>("match_installed_source_mods", {
        sourceMods: candidates.length > 0 ? candidates : candidatePool.slice(0, 30),
      });

      const candidateList = candidates.length > 0 ? candidates : candidatePool;
      const proof = bestProofMatchForGroup(group, matched, candidateList);
      const scoredFallback = bestScoredCandidateForGroup(group, candidateList);

      if (!proof && (!scoredFallback || scoredFallback.score < 170)) {
        setPairingStatus(`${group.label}: Tsuki found candidates, but none passed proof matching. Reinstall blocked to avoid replacing it with the wrong mod.`);
        recordRuntimeDiagnostic("Reinstall from Tsuki", "blocked", "Candidates found, but proof matching failed.", [group.label, `Candidates: ${candidateList.map((mod) => `${mod.source}:${mod.sourceId}:${mod.name}`).slice(0, 12).join(" | ")}`]);
        mergeMatchArray(matched);
        return;
      }

      const sourceMod = proof
        ? candidateList.find((mod) => mod.source === proof.source && mod.sourceId === proof.sourceId)
        : scoredFallback?.mod;

      if (!sourceMod) {
        setPairingStatus(`${group.label}: proof match found, but source card was missing. Try Pair once, then retry reinstall.`);
        recordRuntimeDiagnostic("Reinstall from Tsuki", "blocked", "Proof match existed but matching source card was missing.", [group.label]);
        return;
      }

      if (!proof && scoredFallback) {
        setPairingStatus(`${group.label}: using strong selected-candidate fallback (${scoredFallback.score}) for reinstall. This only runs because you clicked Reinstall from Tsuki.`);
      }

      setPairingStatus(`Reinstall from Tsuki: opening ${sourceMod.name}...`);
      const detail = await fetchSourceDetailForSummary(sourceMod);
      const files = installableSourceFiles(detail.files);

      if (files.length === 0) {
        setPairingStatus(`${detail.name}: no installable source files exposed. Open the mod page in Browse and choose manually.`);
        recordRuntimeDiagnostic("Reinstall from Tsuki", "blocked", "Source detail exposed no installable files.", [detail.name, `${detail.source}:${detail.sourceId}`]);
        return;
      }

      const file = files[0];

      reportTaskProgress("Reinstall from Tsuki", 58, `Downloading ${file.name}...`);
      setPairingStatus(`Reinstall from Tsuki: downloading ${detail.name} / ${file.name}...`);
      const staged = await invoke<StagedDownloadResult>("stage_source_file_download", {
        source: detail.source,
        modId: detail.sourceId,
        fileId: file.id,
        fileName: file.name,
        downloadUrl: file.downloadUrl ?? null,
        modName: detail.name,
        description: detail.description,
      });

      if (!staged.canInstallLater) {
        const blocked = staged.entries
          .filter((entry) => entry.blocked)
          .map((entry) => `${entry.archivePath}: ${entry.reason}`)
          .slice(0, 12);

        setPairingStatus(`${detail.name}: downloaded, but no safe installable file was found.`);
        recordRuntimeDiagnostic("Reinstall from Tsuki", "blocked", "Staged download had no safe installable route.", [detail.name, file.name, ...staged.warnings, ...blocked]);
        return;
      }

      reportTaskProgress("Reinstall from Tsuki", 82, "Replacing files and writing receipt...");
      setPairingStatus(`Reinstall from Tsuki: replacing local files and writing receipt...`);
      const applied = await invoke<InstallApplyResult>("install_staged_file_to_game", {
        stagedFilePath: staged.stagedFilePath,
        modName: detail.name,
        source: detail.source,
        modId: detail.sourceId,
        fileId: file.id,
        version: file.version ?? detail.version ?? null,
        author: detail.author ?? null,
        thumbnailUrl: detail.thumbnailUrl ?? null,
        bannerUrl: detail.bannerUrl ?? null,
        pageUrl: detail.pageUrl ?? null,
        description: detail.description,
        replaceFileNames,
      });
      saveInstalledEnrichedSourceCache(candidatePool);
      setPairingStatus(`Reinstalled ${detail.name} through Tsuki: ${applied.installedFiles.length} installed, ${applied.replacedFiles.length} replaced. It should now have a receipt/state record.`);
      recordRuntimeDiagnostic("Reinstall from Tsuki", "success", "Reinstall completed and receipt/state should be available.", [detail.name, `${detail.source}:${detail.sourceId}`, `Installed: ${applied.installedFiles.length}`, `Replaced: ${applied.replacedFiles.length}`]);
      setStatus(`Reinstalled ${detail.name} from ${sourceLabel(detail.source)}.`);
      await refreshInstalled();
    } catch (error) {
      setPairingStatus(error instanceof Error ? error.message : String(error));
      recordRuntimeDiagnostic("Reinstall from Tsuki", "error", error instanceof Error ? error.message : String(error), [group.label]);
    } finally {
      setBusyKey(null);
    }
  }


  function clearUnpairableGroups() {
    setUnpairableGroups([]);
    saveUnpairableGroups([]);
    setPairingStatus("Cleared skipped/unpairable groups. Light Auto Pair and selected Try Pair can retry them.");
  }

  async function setGroupEnabled(group: InstalledGroup, enabled: boolean) {
    setBusyKey(group.key);

    try {
      const result = await invoke<string>("set_pak_mod_files_enabled", {
        fileNames: group.files.map((file) => file.fileName),
        enabled,
      });

      setStatus(result);
      await refreshInstalled();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function uninstallFileNames(fileNames: string[], busyId: string) {
    if (fileNames.length === 0) {
      setStatus("No files were selected for uninstall.");
      return;
    }

    setBusyKey(busyId);

    try {
      const result = await invoke<string>("uninstall_pak_mod_files", {
        fileNames,
      });

      setStatus(result);
      setSelectedSourceMod(null);
      setSelectedSourceMatch(null);
      await refreshInstalled();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function setSourceInstallEnabled(match: InstalledSourceMatch, enabled: boolean) {
    setBusyKey(`receipt-toggle-${match.source}-${match.sourceId}`);

    try {
      const result = await invoke<string>("set_source_install_enabled", {
        source: match.source,
        sourceId: match.sourceId,
        enabled,
      });

      setStatus(result);
      await refreshInstalled();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function uninstallMatch(match: InstalledSourceMatch) {
    setBusyKey(`uninstall-${match.source}-${match.sourceId}`);

    try {
      const result = match.matchKind === "receipt"
        ? await invoke<string>("uninstall_source_install", { source: match.source, sourceId: match.sourceId })
        : await invoke<string>("uninstall_pak_mod_files", { fileNames: match.matchedFiles });

      setStatus(result);
      setSelectedSourceMod(null);
      setSelectedSourceMatch(null);
      await refreshInstalled();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
    }
  }

  function requestDelete(title: string, fileNames: string[], busyId: string) {
    setPendingDelete({ title, fileNames, busyId });
  }

  async function confirmDelete() {
    if (!pendingDelete) return;

    const target = pendingDelete;
    setPendingDelete(null);
    await uninstallFileNames(target.fileNames, target.busyId);
  }

  async function setSelectedFilesEnabled(enabled: boolean) {
    if (selectedFileNames.length === 0) {
      setStatus("No selected files.");
      return;
    }

    setBusyKey(`mass-${enabled ? "enable" : "disable"}`);

    try {
      const result = await invoke<string>("set_pak_mod_files_enabled", {
        fileNames: selectedFileNames,
        enabled,
      });

      setStatus(result);
      clearSelectedCards();
      await refreshInstalled();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
    }
  }

  function requestDeleteSelected() {
    if (selectedFileNames.length === 0) {
      setStatus("No selected files.");
      return;
    }

    requestDelete(`${selectedFileNames.length} selected file(s)`, selectedFileNames, "uninstall-selected");
  }

  async function openPakModsFolder() {
    setStatus("Opening pak mods folder...");

    try {
      const result = await invoke<string>("open_pak_mods_folder");
      setStatus(result);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function openWebsite(pageUrl?: string | null) {
    if (!pageUrl) {
      setStatus("No source page URL available for this match.");
      return;
    }

    try {
      const result = await invoke<string>("open_external_url", { url: pageUrl });
      setStatus(result);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function openInstalledModDetail(sourceMod: SourceModSummary, match?: InstalledSourceMatch) {
    const key = `${sourceMod.source}-${sourceMod.sourceId}`;
    setDetailLoadingKey(key);
    setSelectedSourceMatch(match ?? matches[key] ?? null);
    reportTaskProgress("Open installed mod", 12, sourceMod.name);
    setStatus(`Opening ${sourceMod.name} inside Tsuki...`);

    try {
      reportTaskProgress("Open installed mod", 48, "Loading full source detail...");
      const detail =
        sourceMod.source === "nexus"
          ? await invoke<SourceModDetail>("fetch_nexus_mod_detail", { modId: sourceMod.sourceId })
          : await invoke<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: sourceMod.sourceId });

      reportTaskProgress("Open installed mod", 88, "Rendering detail page...");
      const safeDetail = {
        ...detail,
        tags: Array.isArray(detail.tags) ? detail.tags : [],
        files: Array.isArray(detail.files) ? detail.files : [],
        images: Array.isArray(detail.images) ? detail.images : [],
        stats: Array.isArray(detail.stats) ? detail.stats : [],
      };

      mergeSourceCards([sourceSummaryFromDetail(safeDetail)]);
      setSelectedSourceMod(safeDetail);
      setStatus(`Opened ${detail.name}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailLoadingKey(null);
      clearTaskProgress();
    }
  }

  async function updateInstalledMatch(sourceMod: SourceModSummary, match: InstalledSourceMatch) {
    const key = `update-${sourceMod.source}-${sourceMod.sourceId}`;
    setBusyKey(key);
    setStatus(`Checking update files for ${sourceMod.name}...`);

    try {
      const detail =
        sourceMod.source === "nexus"
          ? await invoke<SourceModDetail>("fetch_nexus_mod_detail", { modId: sourceMod.sourceId })
          : await invoke<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: sourceMod.sourceId });

      const safeDetail = {
        ...detail,
        tags: Array.isArray(detail.tags) ? detail.tags : [],
        files: Array.isArray(detail.files) ? detail.files : [],
        images: Array.isArray(detail.images) ? detail.images : [],
        stats: Array.isArray(detail.stats) ? detail.stats : [],
      };

      const files = installableSourceFiles(safeDetail.files);

      if (files.length === 0) {
        setStatus("No installable update files were exposed by this source.");
        return;
      }

      const file = files[0];

      setStatus(`Downloading update for ${safeDetail.name}...`);

      const staged = await invoke<StagedDownloadResult>("stage_source_file_download", {
        source: safeDetail.source,
        modId: safeDetail.sourceId,
        fileId: file.id,
        fileName: file.name,
        downloadUrl: file.downloadUrl ?? null,
        modName: safeDetail.name,
        description: safeDetail.description,
      });

      if (!staged.canInstallLater) {
        setStatus(`Downloaded update for ${safeDetail.name}, but install is blocked for manual review.`);
        return;
      }

      setStatus(`Installing update for ${safeDetail.name}...`);

      const applied = await invoke<InstallApplyResult>("install_staged_file_to_game", {
        stagedFilePath: staged.stagedFilePath,
        modName: safeDetail.name,
        source: safeDetail.source,
        modId: safeDetail.sourceId,
        fileId: file.id,
        version: file.version ?? safeDetail.version ?? null,
        author: safeDetail.author ?? null,
        thumbnailUrl: safeDetail.thumbnailUrl ?? null,
        bannerUrl: safeDetail.bannerUrl ?? null,
        pageUrl: safeDetail.pageUrl ?? null,
        description: safeDetail.description,
        replaceFileNames: match.matchedFiles,
      });

      setStatus(`Updated ${safeDetail.name}: installed ${applied.installedFiles.length} file(s), replaced ${applied.replacedFiles.length} old file(s).`);
      await refreshInstalled();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
    }
  }

  useEffect(() => {
    void refreshInstalled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (autoPairTimerRef.current !== null) {
      window.clearTimeout(autoPairTimerRef.current);
      autoPairTimerRef.current = null;
    }

    if (!autoPairEnabled) return;

    if (selectedSourceMod || enriching || nexusIndexing || backgroundPairing || rawFiles.length === 0 || sourceMods.length === 0) {
      return;
    }

    if (allUnmatchedGroups.length === 0) {
      setAutoPairStatus("Auto Pair idle: everything is paired.");
      return;
    }

    if (autoPairQueue.length === 0) {
      setAutoPairStatus("Auto Pair idle: only skipped groups remain. Clear Skipped to retry them.");
      return;
    }

    const delay = 18_000;

    autoPairTimerRef.current = window.setTimeout(() => {
      autoPairTimerRef.current = null;
      void runBackgroundPairStep("Light Auto Pair");
    }, delay);

    setAutoPairStatus(`Light Auto Pair queued: ${autoPairQueue.length} groups left. Next cache check in ${Math.round(delay / 1000)}s.`);

    return () => {
      if (autoPairTimerRef.current !== null) {
        window.clearTimeout(autoPairTimerRef.current);
        autoPairTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    autoPairEnabled,
    selectedSourceMod,
    enriching,
    nexusIndexing,
    backgroundPairing,
    rawFiles.length,
    allUnmatchedGroups.length,
    autoPairQueue.length,
    sourceMods.length,
    unpairableGroups.length,
  ]);

  if (selectedSourceMod) {
    return (
      <InstalledSourceDetailPage
        mod={selectedSourceMod}
        match={selectedSourceMatch}
        busyKey={busyKey}
        onBack={() => {
          setSelectedSourceMod(null);
          setSelectedSourceMatch(null);
        }}
        onOpenWebsite={openWebsite}
        onUninstall={(match) => uninstallMatch(match)}
        onToggleReceipt={(match) => setSourceInstallEnabled(match, !(match.enabled !== false))}
        onUpdate={(match) => updateInstalledMatch(selectedSourceMod, match)}
      />
    );
  }

  return (
    <section className="page installed-clean-page">
      <div className="installed-hero">
        <div>
          <p className="eyebrow">Local library</p>
          <h1>Installed Mods</h1>
          <p>
            Simple installed library. Use Sync Installed for the normal scan + safe pairing flow.
            Advanced tools are tucked away unless something breaks.
          </p>
        </div>

        <div className="installed-hero-actions simplified">
          <button
            className="primary-action compact"
            type="button"
            onClick={syncInstalledLibrary}
            disabled={busyKey !== null || enriching || nexusIndexing || backgroundPairing || updatesBusy}
          >
            {busyKey === "sync-installed" ? "Syncing..." : "Sync Installed"}
          </button>
          <button
            className="ghost-button compact"
            type="button"
            onClick={pairAllSources}
            disabled={busyKey !== null || enriching || nexusIndexing || backgroundPairing || updatesBusy}
          >
            {busyKey === "pair-all" ? "Pairing..." : "Pair All"}
          </button>
          <button className="ghost-button compact" type="button" onClick={openPakModsFolder}>
            Open ~mods
          </button>
          <button className="ghost-button compact" type="button" onClick={checkStateFirstUpdates} disabled={updatesBusy}>
            {updatesBusy ? "Checking..." : "Check Tsuki Updates"}
          </button>

          <details className="installed-advanced-actions">
            <summary>Advanced</summary>
            <div>
              <button className="ghost-button compact" type="button" onClick={() => pairSource("modworkshop")} disabled={busyKey === "pair-modworkshop"}>
                {busyKey === "pair-modworkshop" ? "Pairing..." : "Pair All Workshop"}
              </button>
              <button className="ghost-button compact" type="button" onClick={() => pairSource("nexus")} disabled={busyKey === "pair-nexus"}>
                {busyKey === "pair-nexus" ? "Pairing..." : "Pair All Nexus"}
              </button>
              <button className="ghost-button compact" type="button" onClick={() => refreshInstalled()}>
                Refresh Only
              </button>
              <button className="ghost-button compact" type="button" onClick={() => refreshPairing()}>
                Re-pair All
              </button>
              <button className="ghost-button compact danger-button" type="button" onClick={repairPairingCache}>
                Reset Pair Cache
              </button>
              <button className="ghost-button compact" type="button" onClick={diagnoseModWorkshopPairing} disabled={busyKey === "diagnose-modworkshop-pairing"}>
                {busyKey === "diagnose-modworkshop-pairing" ? "Diagnosing..." : "Diagnose MW"}
              </button>
              <button className="ghost-button compact" type="button" onClick={repairInstalledThumbnails} disabled={busyKey === "repair-thumbnails"}>
                {busyKey === "repair-thumbnails" ? "Repairing..." : "Repair Thumbnails"}
              </button>
              <button className="ghost-button compact danger-button" type="button" onClick={removeRaidWw2BadInstall} disabled={busyKey === "remove-raid-ww2"}>
                {busyKey === "remove-raid-ww2" ? "Removing..." : "Remove RAID WW2"}
              </button>
              <label className="pair-limit-control">
                <span>Search limit</span>
                <select
                  className="setting-input"
                  value={searchPairLimit}
                  onChange={(event) => setSearchPairLimit(Number(event.target.value))}
                  disabled={enriching}
                >
                  <option value={5}>5</option>
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={40}>40</option>
                </select>
              </label>
              <button className="ghost-button compact" type="button" onClick={enrichUnmatchedFromFilenames} disabled={enriching || nexusIndexing || backgroundPairing}>
                {enriching ? "Searching..." : "Search Pair"}
              </button>
              <button className="ghost-button compact" type="button" onClick={buildNexusIndex} disabled={enriching || nexusIndexing || backgroundPairing}>
                {nexusIndexing ? "Nexus..." : "Rebuild Nexus"}
              </button>
              <button className="ghost-button compact" type="button" onClick={clearUnpairableGroups} disabled={backgroundPairing}>
                Clear Skipped
              </button>
              <button className="ghost-button compact" type="button" onClick={clearPairingGuards} disabled={backgroundPairing}>
                Clear Guards
              </button>
            </div>
          </details>
        </div>
      </div>

      <div className="installed-metrics">
        <div><strong>{groups.length}</strong><span>mod groups</span></div>
        <div><strong>{pairedMods.length}</strong><span>paired</span></div>
        <div><strong>{updateCount}</strong><span>updates</span></div>
        <div><strong>{disabledGroups}</strong><span>disabled</span></div>
        <div><strong>{unpairableGroups.length}</strong><span>skipped</span></div>
        <div><strong>{autoPairQueue.length}</strong><span>auto queue</span></div>
        <div><strong>{customGroups.length}</strong><span>custom</span></div>
        <div><strong>{rejectedPairings.length}</strong><span>rejected</span></div>
      </div>

      <div className="installed-commandbar">
        <div className="installed-tabs">
          <button className={view === "all" ? "active" : ""} type="button" onClick={() => setView("all")}>
            All
          </button>
          <button className={view === "matched" ? "active" : ""} type="button" onClick={() => setView("matched")}>
            Matched
          </button>
          <button className={view === "updates" ? "active" : ""} type="button" onClick={() => setView("updates")}>
            Updates
          </button>
          <button className={view === "unmatched" ? "active" : ""} type="button" onClick={() => setView("unmatched")}>
            Unmatched
          </button>
          <button className={view === "raw" ? "active" : ""} type="button" onClick={() => setView("raw")}>
            Raw
          </button>
        </div>

        <div className="installed-searchbar">
          <input
            className="setting-input"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search installed..."
          />

          <select
            className="setting-input"
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value as SortMode)}
          >
            <option value="smart">Smart</option>
            <option value="name">Name</option>
            <option value="modified">Last modified</option>
            <option value="size">Size</option>
            <option value="enabled">On first</option>
            <option value="disabled">Off first</option>
          </select>
        </div>
      </div>

      <div className="mass-select-bar card">
        <div>
          <strong>Mass Select</strong>
          <span>{selectedFileNames.length} files selected · {visibleSelectionKeys.length} visible cards</span>
        </div>

        <div className="mass-select-actions">
          <button className="ghost-button compact" type="button" onClick={selectVisibleCards} disabled={visibleSelectionKeys.length === 0}>
            Select Visible
          </button>
          <button className="ghost-button compact" type="button" onClick={clearSelectedCards} disabled={selectedKeys.length === 0}>
            Clear
          </button>
          <button className="ghost-button compact" type="button" onClick={() => setSelectedFilesEnabled(true)} disabled={selectedFileNames.length === 0 || busyKey === "mass-enable"}>
            {busyKey === "mass-enable" ? "..." : "Enable Selected"}
          </button>
          <button className="ghost-button compact" type="button" onClick={() => setSelectedFilesEnabled(false)} disabled={selectedFileNames.length === 0 || busyKey === "mass-disable"}>
            {busyKey === "mass-disable" ? "..." : "Disable Selected"}
          </button>
          <button className="ghost-button compact danger-button" type="button" onClick={requestDeleteSelected} disabled={selectedFileNames.length === 0}>
            Delete Selected
          </button>
        </div>
      </div>

      <div className="installed-status-line">
        <span>{pairingStatus}</span>
        <span>{status}</span>
        <span>{sourceMods.length} cached cards · {sourceCacheBuckets} buckets · {sourceCacheAge} old</span>
        <span>{autoPairStatus}</span>
        {sourceUpdates.length > 0 && (
          <span>
            {sourceUpdates.filter((update) => update.updateAvailable).length}/{sourceUpdates.length} Tsuki receipt updates
            {receiptUpdateCache?.savedAt ? ` · ${cacheAge(receiptUpdateCache.savedAt)} old` : ""}
          </span>
        )}
      </div>

      {(view === "all" || view === "matched" || view === "updates") && (
        <div className="installed-library-grid">
          {visiblePaired.map((item) => (
            <article
              className={`installed-library-card ${item.match.updateAvailable ? "update" : ""} ${selectedSet.has(pairedSelectionKey(item)) ? "selected" : ""}`}
              key={`${item.sourceMod.source}-${item.sourceMod.sourceId}`}
              role="button"
              tabIndex={0}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("button, summary, details, input, select, a")) return;
                void openInstalledModDetail(item.sourceMod, item.match);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void openInstalledModDetail(item.sourceMod, item.match);
              }}
            >
              <label className="mass-card-check" onClick={(event) => event.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selectedSet.has(pairedSelectionKey(item))}
                  onChange={() => toggleSelected(pairedSelectionKey(item))}
                  aria-label={`Select ${item.sourceMod.name}`}
                />
              </label>
              <button
                className="installed-cover"
                type="button"
                disabled={detailLoadingKey === `${item.sourceMod.source}-${item.sourceMod.sourceId}`}
                onClick={() => openInstalledModDetail(item.sourceMod, item.match)}
              >
                {(() => {
                  const coverUrl = sourceImageForCard(item.sourceMod);

                  return (
                    <>
                      <span className="installed-cover-fallback">{sourceAccent(item.sourceMod.source)}</span>
                      {coverUrl && (
                        <img
                          src={coverUrl}
                          alt=""
                          onError={(event) => {
                            event.currentTarget.style.display = "none";
                          }}
                        />
                      )}
                    </>
                  );
                })()}
                {detailLoadingKey === `${item.sourceMod.source}-${item.sourceMod.sourceId}` && <em>Opening...</em>}
              </button>

              <div className="installed-info">
                <div className="installed-title-row">
                  <div>
                    <h2>{item.sourceMod.name}</h2>
                    <p>{sourceLabel(item.sourceMod.source)} · {item.sourceMod.author ?? "Unknown author"}</p>
                  </div>
                  <div className="installed-card-actions">
                    {item.match.matchKind === "receipt" && (
                      <button
                        className={`toggle-pill ${(item.match.enabled !== false) ? "on" : "off"}`}
                        type="button"
                        disabled={busyKey === `receipt-toggle-${item.match.source}-${item.match.sourceId}`}
                        onClick={() => setSourceInstallEnabled(item.match, !(item.match.enabled !== false))}
                      >
                        {busyKey === `receipt-toggle-${item.match.source}-${item.match.sourceId}` ? "..." : (item.match.enabled !== false) ? "On" : "Off"}
                      </button>
                    )}
                    {item.group && (
                      <button
                        className={`toggle-pill ${item.group.enabled ? "on" : "off"}`}
                        type="button"
                        disabled={busyKey === item.group.key}
                        onClick={() => setGroupEnabled(item.group!, !item.group!.enabled)}
                      >
                        {busyKey === item.group.key ? "..." : item.group.enabled ? "On" : "Off"}
                      </button>
                    )}
                    {item.match.updateAvailable && (
                      <button
                        className="mini-action update-button"
                        type="button"
                        disabled={busyKey === `update-${item.match.source}-${item.match.sourceId}`}
                        onClick={() => updateInstalledMatch(item.sourceMod, item.match)}
                      >
                        {busyKey === `update-${item.match.source}-${item.match.sourceId}` ? "..." : "Update"}
                      </button>
                    )}
                    <button
                      className="mini-action danger"
                      type="button"
                      disabled={busyKey === `uninstall-${item.match.source}-${item.match.sourceId}`}
                      onClick={() => {
                        if (item.match.matchKind === "receipt") {
                          void uninstallMatch(item.match);
                        } else {
                          requestDelete(item.sourceMod.name, item.match.matchedFiles, `uninstall-${item.match.source}-${item.match.sourceId}`);
                        }
                      }}
                    >
                      {busyKey === `uninstall-${item.match.source}-${item.match.sourceId}` ? "..." : "Uninstall"}
                    </button>
                    <details className="card-more-menu">
                      <summary aria-label="More options">⋯</summary>
                      <div>
                        <button type="button" onClick={() => openInstalledModDetail(item.sourceMod, item.match)}>Open details</button>
                        <button type="button" onClick={() => openWebsite(item.sourceMod.pageUrl)}>Website</button>
                        {item.group && <button type="button" onClick={() => reinstallGroupFromTsuki(item.group!)}>Reinstall from Tsuki</button>}
                        {item.group && <button type="button" onClick={() => markGroupCustom(item.group)}>Mark Custom</button>}
                        {item.match.matchKind === "receipt" && (
                          <button type="button" onClick={() => setSourceInstallEnabled(item.match, !(item.match.enabled !== false))}>
                            {(item.match.enabled !== false) ? "Disable receipt install" : "Enable receipt install"}
                          </button>
                        )}
                        {item.group && (
                          <button type="button" onClick={() => setGroupEnabled(item.group!, !item.group!.enabled)}>
                            {item.group.enabled ? "Disable" : "Enable"}
                          </button>
                        )}
                      </div>
                    </details>
                  </div>
                </div>

                <p className="installed-summary">{item.sourceMod.shortDescription || item.match.reason}</p>

                <div className="installed-badges">
                  <span className={item.match.updateAvailable ? "badge update" : "badge good"}>
                    {item.match.updateAvailable ? "Possible update" : "Installed"}
                  </span>
                  <span className="badge">{item.match.confidence}% match</span>
                  <span className="badge">{item.match.matchKind}</span>
                  {item.match.matchKind === "receipt" && <span className={(item.match.enabled !== false) ? "badge good" : "badge"}>{(item.match.enabled !== false) ? "Enabled" : "Disabled"}</span>}
                  {item.group && <span className="badge">{item.group.files.length} files</span>}
                </div>

                <div className="installed-file-chip-row">
                  {(item.group?.files ?? item.match.matchedFiles.map((fileName) => ({
                    fileName,
                    fullPath: fileName,
                    extension: "unknown",
                    sizeBytes: 0,
                    enabled: true,
                    priority: null,
                    modifiedUnix: null,
                  }))).slice(0, 4).map((file) => (
                    <span key={file.fullPath || file.fileName} title={file.fileName}>
                      {file.fileName}
                    </span>
                  ))}
                </div>

                <details className="installed-match-details">
                  <summary>Pairing details</summary>
                  <p>{item.match.reason}</p>
                  <p>Source updated: {item.match.sourceUpdatedAt ?? "Unknown"} · Local modified: {formatDateFromUnix(item.match.installedModifiedUnix)}</p>
                </details>
              </div>
            </article>
          ))}

          {view === "all" && unmatchedGroups.map((group) => (
            <article className={`installed-library-card local-unpaired-card ${selectedSet.has(groupSelectionKey(group)) ? "selected" : ""}`} key={`unpaired-${group.key}`}>
              <label className="mass-card-check" onClick={(event) => event.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selectedSet.has(groupSelectionKey(group))}
                  onChange={() => toggleSelected(groupSelectionKey(group))}
                  aria-label={`Select ${group.label}`}
                />
              </label>
              <div className="installed-cover local-cover">
                <span>{group.label.slice(0, 2).toUpperCase()}</span>
              </div>

              <div className="installed-info">
                <div className="installed-title-row">
                  <div>
                    <h2>{group.label}</h2>
                    <p>Local file · Unpaired</p>
                  </div>
                  <div className="installed-card-actions">
                    <button
                      className={`toggle-pill ${group.enabled ? "on" : "off"}`}
                      type="button"
                      disabled={busyKey === group.key}
                      onClick={() => setGroupEnabled(group, !group.enabled)}
                    >
                      {busyKey === group.key ? "..." : group.enabled ? "On" : "Off"}
                    </button>
                    <button className="mini-action danger" type="button" disabled={busyKey === `uninstall-${group.key}`} onClick={() => requestDelete(group.label, group.files.map((file) => file.fileName), `uninstall-${group.key}`)}>
                      {busyKey === `uninstall-${group.key}` ? "..." : "Uninstall"}
                    </button>
                    <details className="card-more-menu">
                      <summary aria-label="More options">⋯</summary>
                      <div>
                        <button type="button" onClick={() => tryPairGroup(group)}>Try Pair</button>
                        <button type="button" onClick={() => markGroupCustom(group)}>Mark Custom</button>
                        <button type="button" onClick={() => setGroupEnabled(group, !group.enabled)}>{group.enabled ? "Disable" : "Enable"}</button>
                      </div>
                    </details>
                  </div>
                </div>

                <p className="installed-summary">No source page is paired yet. Auto Pair can keep searching in the background.</p>

                <div className="installed-badges">
                  <span className="badge">Unpaired</span>
                  <span className="badge">{group.files.length} files</span>
                  <span className="badge">{group.enabled ? "Enabled" : "Disabled"}</span>
                </div>

                <div className="installed-file-chip-row">
                  {group.files.slice(0, 4).map((file) => (
                    <span key={file.fullPath || file.fileName} title={file.fileName}>
                      {file.fileName}
                    </span>
                  ))}
                </div>
              </div>
            </article>
          ))}

          {visiblePaired.length === 0 && view !== "all" && (
            <article className="installed-empty card">
              <h2>No matches in this view</h2>
              <p>Load more source mods in Browse, then come back and press Re-pair.</p>
            </article>
          )}
        </div>
      )}

      {view === "unmatched" && (
        <RawGroupList
          title="Unmatched installed mods"
          groups={unmatchedGroups}
          busyKey={busyKey}
          onToggle={setGroupEnabled}
          onMarkCustom={markGroupCustom}
          onTryPair={tryPairGroup}
          onReinstall={reinstallGroupFromTsuki}
          onUninstall={(group) => requestDelete(group.label, group.files.map((file) => file.fileName), `uninstall-${group.key}`)}
          customGroups={customGroups}
        />
      )}

      {view === "raw" && (
        <RawGroupList
          title="Raw installed groups"
          groups={groups}
          busyKey={busyKey}
          onToggle={setGroupEnabled}
          onMarkCustom={markGroupCustom}
          onTryPair={tryPairGroup}
          onReinstall={reinstallGroupFromTsuki}
          onUninstall={(group) => requestDelete(group.label, group.files.map((file) => file.fileName), `uninstall-${group.key}`)}
          customGroups={customGroups}
        />
      )}

      {pendingDelete && (
        <div className="confirm-overlay" role="dialog" aria-modal="true">
          <div className="confirm-panel">
            <p className="eyebrow">Confirm delete</p>
            <h2>Delete {pendingDelete.title}?</h2>
            <p>Tsuki will move these files into the uninstalled holding folder. Receipt installs use their full tracked file paths.</p>
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


function InstalledSourceDetailPage({
  mod,
  match,
  busyKey,
  onBack,
  onOpenWebsite,
  onUninstall,
  onToggleReceipt,
  onUpdate,
}: {
  mod: SourceModDetail;
  match: InstalledSourceMatch | null;
  busyKey: string | null;
  onBack: () => void;
  onOpenWebsite: (pageUrl?: string | null) => void;
  onUninstall: (match: InstalledSourceMatch) => void;
  onToggleReceipt: (match: InstalledSourceMatch) => void;
  onUpdate: (match: InstalledSourceMatch) => void;
}) {
  const [tab, setTab] = useState<"description" | "files" | "images" | "stats">("description");
  const uninstallBusy = match ? busyKey === `uninstall-${match.source}-${match.sourceId}` : false;
  const safeFiles = Array.isArray(mod.files) ? mod.files : [];
  const safeImages = Array.isArray(mod.images) ? mod.images : [];
  const safeStats = Array.isArray(mod.stats) ? mod.stats : [];
  const safeTags = Array.isArray(mod.tags) ? mod.tags : [];
  const safeMatchedFiles = Array.isArray(match?.matchedFiles) ? match?.matchedFiles ?? [] : [];

  return (
    <section className="page installed-source-detail-page installed-source-detail-page-v2">
      <div className="safe-mod-hero installed-detail-top card">
        <div className="safe-hero-copy">
          <button className="ghost-button compact" type="button" onClick={onBack}>
            ← Back to Installed
          </button>
          <p className="eyebrow">{sourceLabel(mod.source)}</p>
          <h1>{mod.name}</h1>
          <p>{mod.shortDescription || "Installed source page."}</p>
          <div className="installed-badges">
            <span className="badge good">Installed match</span>
            <span className="badge">{sourceLabel(mod.source)}</span>
            <span className="badge">ID {mod.sourceId}</span>
            {mod.author && <span className="badge">by {mod.author}</span>}
            {match && <span className="badge">{match.confidence}% match</span>}
            {match?.matchKind === "receipt" && <span className={(match.enabled !== false) ? "badge good" : "badge"}>{(match.enabled !== false) ? "Receipt enabled" : "Receipt disabled"}</span>}
          </div>
        </div>

        <div className="safe-hero-actions">
          <button className="ghost-button compact" type="button" onClick={() => onOpenWebsite(mod.pageUrl)}>
            Website
          </button>
          {match?.installed && match.matchKind === "receipt" && (
            <button
              className={`ghost-button compact ${(match.enabled !== false) ? "" : "update-button"}`}
              type="button"
              onClick={() => onToggleReceipt(match)}
              disabled={busyKey === `receipt-toggle-${match.source}-${match.sourceId}`}
            >
              {busyKey === `receipt-toggle-${match.source}-${match.sourceId}` ? "..." : (match.enabled !== false) ? "Disable" : "Enable"}
            </button>
          )}
          {match?.installed && match.updateAvailable && (
            <button className="ghost-button compact update-button" type="button" onClick={() => onUpdate(match)} disabled={busyKey === `update-${match.source}-${match.sourceId}`}>
              {busyKey === `update-${match.source}-${match.sourceId}` ? "Updating..." : "Update"}
            </button>
          )}
          {match?.installed && (
            <button className="ghost-button compact danger-button" type="button" onClick={() => onUninstall(match)} disabled={uninstallBusy}>
              {uninstallBusy ? "Uninstalling..." : "Uninstall"}
            </button>
          )}
        </div>
      </div>

      <div className="safe-detail-layout polished installed-detail-polished">
        <article className="card safe-description-card">
          <div className="safe-detail-art installed-detail-hero-art">
            {mod.bannerUrl || mod.thumbnailUrl ? (
              <img src={mod.bannerUrl ?? mod.thumbnailUrl ?? ""} alt="" />
            ) : (
              <span>{sourceAccent(mod.source)}</span>
            )}
          </div>

          <div className="installed-badges">
            {safeTags.slice(0, 10).map((tag) => <span className="badge" key={tag}>{tag}</span>)}
          </div>

          <div className="mod-page-tabs installed-detail-tabs">
            {[
              ["description", "Description"],
              ["files", `Files ${safeFiles.length}`],
              ["images", `Images ${safeImages.length}`],
              ["stats", "Stats"],
            ].map(([id, label]) => (
              <button
                className={`mod-page-tab ${tab === id ? "active" : ""}`}
                key={id}
                type="button"
                onClick={() => setTab(id as typeof tab)}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "description" && (
            <article className="installed-source-detail-content">
              <h2>Description</h2>
              <p>{mod.description || "No description loaded."}</p>
              {mod.changelog && (
                <>
                  <br />
                  <h2>Changelog</h2>
                  <p>{mod.changelog}</p>
                </>
              )}
            </article>
          )}

          {tab === "images" && (
            <article className="installed-source-detail-content">
              <h2>Images</h2>
              <div className="installed-detail-image-grid">
                {safeImages.map((image) => (
                  <div key={image.id}>
                    <img src={image.thumbnailUrl ?? image.imageUrl} alt="" />
                    <strong>{image.title ?? "Image"}</strong>
                  </div>
                ))}
                {safeImages.length === 0 && <p>No images exposed by this source yet.</p>}
              </div>
            </article>
          )}

          {tab === "stats" && (
            <article className="installed-source-detail-content">
              <h2>Stats</h2>
              <div className="source-stats-grid">
                {safeStats.map((stat) => (
                  <div className="card" key={stat.label}>
                    <h3>{stat.label}</h3>
                    <div className="stat-number">{stat.value}</div>
                  </div>
                ))}
                {safeStats.length === 0 && <p>No stats exposed by this source yet.</p>}
              </div>
            </article>
          )}
        </article>

        <aside className="card safe-files-card">
          <div className="safe-files-header">
            <div>
              <p className="eyebrow">Local + source</p>
              <h2>Files</h2>
            </div>
            <span className="badge">{safeMatchedFiles.length} installed</span>
          </div>

          {safeMatchedFiles.length > 0 && (
            <div className="installed-detail-file-list local-files">
              {limitList(safeMatchedFiles, 60).map((fileName) => (
                <div key={fileName} title={fileName}>
                  <div>
                    <strong>{installedFileBaseName(fileName)}</strong>
                    <p>{installedFileShortPath(fileName)}</p>
                  </div>
                  <span>matched</span>
                </div>
              ))}
              {safeMatchedFiles.length > 60 && (
                <div>
                  <div>
                    <strong>+{safeMatchedFiles.length - 60} more matched files</strong>
                    <p>Open the receipt/Installed tools for the full list.</p>
                  </div>
                  <span>hidden</span>
                </div>
              )}
            </div>
          )}

          <h3>Source files</h3>
          <div className="installed-detail-file-list">
            {limitList(safeFiles, 80).map((file) => (
              <div key={file.id} title={file.name}>
                <div>
                  <strong>{file.name}</strong>
                  <p>Version: {file.version ?? "Unknown"} · Uploaded: {file.uploadedAt ?? "Unknown"}</p>
                </div>
                <span>{file.sizeLabel ?? "Unknown size"}</span>
              </div>
            ))}
            {safeFiles.length > 80 && <p>Showing first 80 source files for speed.</p>}
            {safeFiles.length === 0 && <p>No files exposed by this source yet.</p>}
          </div>
        </aside>
      </div>
    </section>
  );
}

function RawGroupList({
  title,
  groups,
  busyKey,
  onToggle,
  onMarkCustom,
  onTryPair,
  onReinstall,
  onUninstall,
  customGroups,
}: {
  title: string;
  groups: InstalledGroup[];
  busyKey: string | null;
  onToggle: (group: InstalledGroup, enabled: boolean) => void;
  onMarkCustom: (group: InstalledGroup) => void;
  onTryPair: (group: InstalledGroup) => void;
  onReinstall: (group: InstalledGroup) => void;
  onUninstall: (group: InstalledGroup) => void;
  customGroups: string[];
}) {

  return (
    <article className="raw-panel">
      <div className="raw-panel-header">
        <h2>{title}</h2>
        <span>{groups.length} groups</span>
      </div>

      <div className="raw-clean-list">
        {groups.map((group) => (
          <div className={`raw-clean-row ${group.enabled ? "" : "disabled"} ${customGroups.includes(group.key) ? "custom" : ""}`} key={group.key}>
            <div className="raw-avatar">{group.label.slice(0, 2).toUpperCase()}</div>
            <div>
              <strong>{group.label}</strong>
              <p>{group.files.map((file) => file.fileName).join(", ")}</p>
              <small>
                {group.files.length} files · {formatBytes(group.sizeBytes)} · {formatDateFromUnix(group.modifiedUnix)}
                {inferModWorkshopId(group) ? ` · MWS #${inferModWorkshopId(group)}` : ""}
              </small>
            </div>
            <div className="raw-row-actions">
              <button
                className={`toggle-pill ${group.enabled ? "on" : "off"}`}
                type="button"
                disabled={busyKey === group.key}
                onClick={() => onToggle(group, !group.enabled)}
              >
                {busyKey === group.key ? "..." : group.enabled ? "Enabled" : "Disabled"}
              </button>
              <button className="mini-action" type="button" disabled={busyKey === `try-pair-${group.key}`} onClick={() => onTryPair(group)}>
                {busyKey === `try-pair-${group.key}` ? "Pairing..." : "Try Pair"}
              </button>
              <button className="mini-action" type="button" disabled={busyKey === `reinstall-${group.key}`} onClick={() => onReinstall(group)}>
                {busyKey === `reinstall-${group.key}` ? "Reinstalling..." : "Reinstall from Tsuki"}
              </button>
              <button className="mini-action warning" type="button" onClick={() => onMarkCustom(group)}>
                {customGroups.includes(group.key) ? "Custom" : "Mark Custom"}
              </button>
              <button className="mini-action danger" type="button" disabled={busyKey === `uninstall-${group.key}`} onClick={() => onUninstall(group)}>
                {busyKey === `uninstall-${group.key}` ? "..." : "Uninstall"}
              </button>
            </div>
          </div>
        ))}

        {groups.length === 0 && <p className="empty-note">Nothing here.</p>}
      </div>
    </article>
  );
}

import "./InstalledPage.css";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { InstalledModCard } from "../../components/InstalledModCard";
import { ModToggleButton } from "../../components/ModToggleButton";
import { UnifiedModPage } from "../../components/UnifiedModPage";
import type { UnifiedAction, UnifiedDependencyItem, UnifiedFileGroup, UnifiedInfoItem, UnifiedTimelineItem } from "../../components/UnifiedModPage";
import { DependencyActions, DependencyName } from "../../components/DependencyActions";
import { dependencySourceLabel, enrichDependency, type DependencySourceKind } from "../../models/dependency";
import type { GameProfile, GameProfileSourceConfig } from "../../models/gameProfiles";
import type { PakModFile, PakScanResult } from "../../models/mod";
import { profileHasConfiguredSources, type ActiveProfileRuntime } from "../../models/profileRuntime";
import type { InstalledSourceMatch, ModSourceKind, SourceModDetail, SourceModSummary, SourceModFile, StagedDownloadResult, InstallApplyResult, SourceUpdateStatus } from "../../models/source";
import type { TagDefinition, TagSource, TagType } from "../../utils/tagRegistry";
import { customTagDefinition, isSystemBadgeTag, mergeTagDefinitions, normalizeGameId, normalizeTagName, rankTags, rejectedTaxonomyLabelReason, seedTagCatalog, tagColorClass, tagColorStyle, tagDisplayLabel, tagGroupLabel, tagMatchesQuery } from "../../utils/tagRegistry";
import { readThumbnailFailures, thumbnailRecentlyFailed, writeThumbnailFailures } from "../../utils/thumbnailFailures";
import { applyKnownSourceAuthor, displaySourceAuthor, displaySourceTitle, rememberSourceAuthorMetadata } from "../../utils/sourceAuthorCache";
import { installedSourceFallbackLabel, resolveInstalledThumbnailUrl } from "../../utils/installedThumbnail";

type InstalledView = "all" | "matched" | "updates" | "unmatched" | "raw";
type SortMode = "name" | "modified" | "size";
type EnabledFilter = "all" | "on" | "off";

interface CachedSourceMods {
  mods?: SourceModSummary[];
  savedAt?: number;
  version?: string;
  page?: number;
  hasMore?: boolean;
}

const INSTALLED_ENRICH_CACHE_KEY = "tsuki-source-cache:v0.44:installed:index";
const INSTALLED_METADATA_HYDRATION_BATCH_SIZE = 8;
const INSTALLED_METADATA_HYDRATION_CONCURRENCY = 2;

const UNPAIRABLE_GROUPS_KEY = "tsuki-installed-unpairable-groups:v0.90-state-first";

const REJECTED_PAIRINGS_KEY = "tsuki-rejected-pairings:v0.90-state-first";
const CUSTOM_GROUPS_KEY = "tsuki-custom-installed-groups:v0.90-state-first";
const CRASH_TEST_EXCLUSION_OVERRIDES_KEY = "tsuki-crash-test-exclusions:v2";
const PAIR_STATE_CACHE_KEY = "tsuki-installed-pair-ledger:v1";

const TSUKI_RECEIPT_UPDATE_CACHE_KEY = "tsuki-receipt-update-check:v1";

function profileLocalStorageKey(base: string, profileId: string) {
  return `${base}:${profileId || "unknown-profile"}`;
}

function installedEnrichCacheKey(profileId: string) {
  return profileLocalStorageKey(INSTALLED_ENRICH_CACHE_KEY, profileId);
}

function sourceCacheKeyBelongsToProfile(key: string, profileId: string) {
  return key === installedEnrichCacheKey(profileId) || key.startsWith(`tsuki-source-cache:${profileId}:`);
}

interface ReceiptUpdateCheckCache {
  savedAt: number;
  updates: SourceUpdateStatus[];
  checkedCount: number;
  updateCount: number;
  source: "launch" | "manual";
}

function readReceiptUpdateCheckCache(profileId: string): ReceiptUpdateCheckCache | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(profileLocalStorageKey(TSUKI_RECEIPT_UPDATE_CACHE_KEY, profileId)) ?? "null");
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

function writeReceiptUpdateCheckCache(profileId: string, updates: SourceUpdateStatus[], source: "launch" | "manual") {
  const payload: ReceiptUpdateCheckCache = {
    savedAt: Date.now(),
    updates,
    checkedCount: updates.length,
    updateCount: updates.filter((update) => update.updateAvailable).length,
    source,
  };

  try {
    window.localStorage.setItem(profileLocalStorageKey(TSUKI_RECEIPT_UPDATE_CACHE_KEY, profileId), JSON.stringify(payload));
    window.dispatchEvent(new CustomEvent("tsuki-receipt-update-check", { detail: { ...payload, profileId } }));
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

function loadCrashTestExclusionOverrides(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CRASH_TEST_EXCLUSION_OVERRIDES_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => typeof value === "boolean")
        .map(([key, value]) => [key, value as boolean]),
    );
  } catch {
    return {};
  }
}

function saveCrashTestExclusionOverrides(overrides: Record<string, boolean>) {
  try {
    window.localStorage.setItem(CRASH_TEST_EXCLUSION_OVERRIDES_KEY, JSON.stringify(overrides));
  } catch {
    // Optional cache.
  }
}

function loadUnpairableGroups(profileId: string) {
  return loadStringList(profileLocalStorageKey(UNPAIRABLE_GROUPS_KEY, profileId));
}

function saveUnpairableGroups(profileId: string, keys: string[]) {
  saveStringList(profileLocalStorageKey(UNPAIRABLE_GROUPS_KEY, profileId), keys);
}

function pruneMissingSkippedGroups(keys: string[], groups: InstalledGroup[]) {
  const liveKeys = new Set(groups.map((group) => group.key));
  return keys.filter((key) => liveKeys.has(key));
}


function saveInstalledEnrichedSourceCache(profileId: string, mods: SourceModSummary[]) {
  try {
    window.localStorage.setItem(
      installedEnrichCacheKey(profileId),
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


interface ManualEditTarget {
  sourceMod: SourceModSummary;
  match: InstalledSourceMatch;
}

interface ManualSourceMatchPayload {
  source: ModSourceKind;
  sourceId: string;
  fileId?: string | null;
  gameId?: string | null;
  modName: string;
  fileName: string;
  version?: string | null;
  author?: string | null;
  thumbnailUrl?: string | null;
  pageUrl?: string | null;
  sha256?: string | null;
  confidence: number;
  confidenceLevel: string;
  matchKind: string;
  reason: string;
}

function sourceGameRawIdFromConfig(sourceConfig: GameProfileSourceConfig | null | undefined, profileId: string, source: ModSourceKind, fallback?: string | null) {
  const configured = source === "modworkshop"
    ? sourceConfig?.modworkshopGameId || sourceConfig?.modworkshopSlug
    : source === "nexus"
      ? sourceConfig?.nexusGameId || sourceConfig?.nexusDomain
      : null;
  const raw = String(configured ?? fallback ?? profileId ?? "").trim();
  return raw || null;
}
function parseManualSourceUrl(input: string): { source: ModSourceKind; modId: string; pageUrl: string; gameDomain?: string | null } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    const path = url.pathname;

    if (host.includes("modworkshop.net")) {
      const match = path.match(/\/mod\/(\d+)/i) ?? path.match(/\/mods?\/(\d+)/i);
      if (match?.[1]) return { source: "modworkshop", modId: match[1], pageUrl: url.toString() };
    }

    if (host.includes("nexusmods.com")) {
      const withDomain = path.match(/^\/([^/?#]+)\/mods\/(\d+)/i);
      const withoutDomain = path.match(/^\/mods\/(\d+)/i);
      const modId = withDomain?.[2] ?? withoutDomain?.[1];
      const gameDomain = withDomain?.[1] ?? null;
      if (modId) return { source: "nexus", modId, pageUrl: url.toString(), gameDomain };
    }
  } catch {
    const modworkshop = trimmed.match(/modworkshop\.net\/mod\/(\d+)/i);
    if (modworkshop?.[1]) return { source: "modworkshop", modId: modworkshop[1], pageUrl: `https://modworkshop.net/mod/${modworkshop[1]}` };

    const nexus = trimmed.match(/nexusmods\.com\/([^/?#]+)\/mods\/(\d+)/i);
    if (nexus?.[1] && nexus?.[2]) return { source: "nexus", modId: nexus[2], pageUrl: `https://www.nexusmods.com/${nexus[1]}/mods/${nexus[2]}`, gameDomain: nexus[1] };
  }

  return null;
}

function sourceMatchPayloadFromDetail(detail: SourceModDetail, pageUrl: string, sourceConfig: GameProfileSourceConfig | null | undefined, profileId: string): ManualSourceMatchPayload {
  const primaryFile = Array.isArray(detail.files) ? detail.files[0] : null;

  return {
    source: detail.source,
    sourceId: detail.sourceId,
    fileId: primaryFile?.id ?? null,
    gameId: sourceGameRawIdFromConfig(sourceConfig, profileId, detail.source, detail.gameId ?? detail.nexus?.gameId),
    modName: detail.name,
    fileName: primaryFile?.name ?? detail.name,
    version: detail.version ?? primaryFile?.version ?? null,
    author: detail.author ?? null,
    thumbnailUrl: detail.thumbnailUrl ?? detail.bannerUrl ?? null,
    pageUrl: detail.pageUrl ?? pageUrl,
    sha256: null,
    confidence: 100,
    confidenceLevel: "manual",
    matchKind: "manual",
    reason: "User-confirmed manual source match from pasted URL.",
  };
}

function manualMatchEditable(match: InstalledSourceMatch | null | undefined) {
  if (!match?.receiptId) return false;
  return ["unknown", "suggestion", "filename-suggestion", "proof-filename", "source-id", "manual", "manual-cleared", "skipped"].includes(match.matchKind)
    || match.ownershipClassification === "unknown_local"
    || (match.source as string) === "local";
}
interface InstalledHydrationDiagnostics {
  checked: number;
  hydratedCount: number;
  missingCount: number;
  thumbnailSource: string;
  metadataSource: string;
  missingReason: string;
  running: boolean;
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
  sourceFileName?: string | null;
  sourceFileCategory?: string | null;
  sourceFileUploadedAt?: string | null;
  sourceFileVersion?: string | null;
  matchKind?: string | null;
  matchConfidence?: number | null;
  matchReason?: string | null;
  pageUrl?: string | null;
  thumbnailUrl?: string | null;
  bannerUrl?: string | null;
  notes?: string | null;
  tags?: string[];
  enabled: boolean;
  installedAtUnix?: number | null;
  files: InstalledStateFile[];
}

function sourceSummaryFromInstalledState(record: InstalledStateRecord): SourceModSummary | null {
  if (!record.source || !record.sourceModId && !record.id) return null;

  const sourceId = record.sourceModId ?? record.id;
  const recordMatchKind = record.matchKind ?? (record.receiptId ? "receipt" : "unknown");
  const tsukiOwnedRecord = (["receipt", "receipt-hash", "manual", "user-confirmed", "user-confirmed-sha256"].includes(recordMatchKind)) && Boolean(record.receiptId);
  const fileAliases = (record.files ?? [])
    .map((file) => file.fileName)
    .filter((fileName) => fileName && fileName.trim().length > 0);
  const receiptTags = [
    "PAYDAY 3",
    tsukiOwnedRecord ? "Tsuki-installed" : "Local",
    record.enabled ? "Enabled" : "Disabled",
    record.location,
    record.fileType,
    record.filename,
    ...(record.files ?? []).map((file) => file.location),
    ...(record.files ?? []).map((file) => file.fileType),
    ...fileAliases,
  ];

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
    views: null,
    shortDescription: [
      tsukiOwnedRecord ? `Installed by Tsuki receipt ${record.receiptId ?? record.uid}` : "Local mod",
      record.enabled ? "Enabled" : "Disabled",
      ...fileAliases,
    ].join(" "),
    tags: [...new Set(receiptTags.filter(Boolean) as string[])],
  };
}

function receiptMatchFromInstalledState(record: InstalledStateRecord): InstalledSourceMatch | null {
  if (!record.source || !record.sourceModId && !record.id) return null;

  const sourceId = record.sourceModId ?? record.id;
  const files = record.files ?? [];
  const hasTrackedFiles = files.length > 0;
  const hasLiveFile = files.some((file) => file.live);
  const disabledPresent = hasLiveFile && record.enabled === false;
  const missing = hasTrackedFiles && !hasLiveFile && !disabledPresent;
  const matchedFiles = [...new Set([
    record.filename,
    ...(record.files ?? []).flatMap((file) => [file.fileName, file.relativePath]),
  ].filter((value): value is string => Boolean(value && value.trim().length > 0)))];

  const matchKind = record.matchKind ?? "receipt";
  const tsukiOwnedRecord = (["receipt", "receipt-hash", "manual", "user-confirmed", "user-confirmed-sha256"].includes(matchKind)) && Boolean(record.receiptId);

  return {
    source: record.source as ModSourceKind,
    sourceId,
    installed: !missing,
    missing,
    broken: missing,
    enabled: missing ? false : record.enabled,
    updateAvailable: false,
    confidence: record.matchConfidence ?? 100,
    ownershipClassification: tsukiOwnedRecord ? "tsuki_installed" : (matchKind === "unknown" ? "unknown_local" : "local_detected"),
    reason: missing ? "Tracked receipt exists, but all files are missing from disk." : (disabledPresent ? "Tracked receipt files are disabled in Tsuki storage." : (record.matchReason ?? `Tsuki install receipt/state record ${record.receiptId ?? record.uid}`)),
    matchedFiles,
    receiptId: record.receiptId ?? record.uid,
    installedModifiedUnix: record.installedAtUnix ?? null,
    sourceUpdatedAt: record.installedAtUnix ? String(record.installedAtUnix) : null,
    sourceUpdatedUnix: record.installedAtUnix ?? null,
    matchKind,
    sourceFileId: record.sourceFileId ?? record.fileId ?? null,
    sourceFileName: record.sourceFileName ?? record.filename ?? null,
    sourceFileCategory: record.sourceFileCategory ?? null,
    sourceFileUploadedAt: record.sourceFileUploadedAt ?? null,
    sourceFileVersion: record.sourceFileVersion ?? record.version ?? null,
    displayName: record.name ?? record.filename ?? null,
    author: record.author ?? null,
    thumbnailUrl: record.thumbnailUrl ?? null,
    bannerUrl: record.bannerUrl ?? null,
    pageUrl: record.pageUrl ?? null,
    notes: record.notes ?? null,
    thumbnailSource: record.thumbnailUrl || record.bannerUrl ? "receipt" : "fallback",
    thumbnailMissingReason: record.thumbnailUrl || record.bannerUrl ? null : "Installed-state record has no thumbnail or banner URL.",
  };
}

interface CachedPairState {
  savedAt: number;
  fileSignature: string;
  sourceMods: SourceModSummary[];
  matches: Record<string, InstalledSourceMatch>;
}

interface InstalledSessionCache {
  profileId: string;
  savedAt: number;
  invalidatedAt: number;
  scanResult: PakScanResult | null;
  sourceMods: SourceModSummary[];
  matches: Record<string, InstalledSourceMatch>;
  installedState: InstalledStateRecord[];
  status: string;
  pairingStatus: string;
  sourceCacheAge: string;
  sourceCacheBuckets: number;
  runtimeLock: RuntimeLockStatus | null;
}

const INSTALLED_SESSION_CACHE_INVALIDATED_AT_KEY = "tsuki-installed-session-cache-invalidated-at";
const INSTALLED_SESSION_CACHE_MAX_AGE_MS = 30 * 60 * 1000;
let installedSessionCache: InstalledSessionCache | null = null;

function installedSessionInvalidatedAt(profileId: string) {
  const raw = Number(window.sessionStorage.getItem(profileLocalStorageKey(INSTALLED_SESSION_CACHE_INVALIDATED_AT_KEY, profileId)) ?? "0");
  return Number.isFinite(raw) ? raw : 0;
}

function readInstalledSessionCache(profileId: string): InstalledSessionCache | null {
  if (!installedSessionCache) return null;
  if (installedSessionCache.profileId !== profileId) return null;
  if (Date.now() - installedSessionCache.savedAt > INSTALLED_SESSION_CACHE_MAX_AGE_MS) return null;
  if (installedSessionCache.invalidatedAt < installedSessionInvalidatedAt(profileId)) return null;
  if (!installedSessionCache.scanResult) return null;
  return installedSessionCache;
}

function writeInstalledSessionCache(profileId: string, cache: Omit<InstalledSessionCache, "profileId" | "savedAt" | "invalidatedAt">) {
  installedSessionCache = {
    ...cache,
    profileId,
    savedAt: Date.now(),
    invalidatedAt: installedSessionInvalidatedAt(profileId),
  };
}

function clearInstalledSessionCache(profileId?: string) {
  if (!profileId || installedSessionCache?.profileId === profileId) installedSessionCache = null;
}

function invalidateInstalledSessionCache(profileId?: string) {
  clearInstalledSessionCache(profileId);
  try {
    window.sessionStorage.setItem(profileLocalStorageKey(INSTALLED_SESSION_CACHE_INVALIDATED_AT_KEY, profileId ?? "global"), String(Date.now()));
  } catch {
    // Session cache is optional.
  }
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
      return ["receipt", "receipt-hash", "sha256", "manifest", "persistent", "manual", "user-confirmed", "user-confirmed-sha256"].includes(match.matchKind);
    }),
  ) as Record<string, InstalledSourceMatch>;
}

function savePairState(profileId: string, sourceMods: SourceModSummary[], matches: Record<string, InstalledSourceMatch>, files: PakModFile[]) {
  try {
    const payload: CachedPairState = {
      savedAt: Date.now(),
      fileSignature: installedFileSignature(files),
      sourceMods,
      matches: stablePairMatches(matches),
    };

    window.localStorage.setItem(profileLocalStorageKey(PAIR_STATE_CACHE_KEY, profileId), JSON.stringify(payload));
  } catch {
    // Optional cache.
  }
}

function loadPairState(profileId: string, files: PakModFile[]): CachedPairState | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(profileLocalStorageKey(PAIR_STATE_CACHE_KEY, profileId)) ?? "{}") as CachedPairState;

    if (!Array.isArray(parsed.sourceMods) || !parsed.matches) return null;

    const liveFileNames = new Set(files.flatMap((file) => fileNameKeys(file.fileName)));
    const liveFullPaths = new Set(files.flatMap((file) => fileNameKeys(file.fullPath)));
    const matches = stablePairMatches(parsed.matches);

    // v1.8.25: do not throw away every proven pair just because one mod was
    // uninstalled, added, or renamed. The old exact file-signature check made
    // Installed look totally unpaired after a single uninstall. Keep receipt and
    // proof pairs, then drop only pairs whose matched files are all gone.
    const liveMatches = Object.fromEntries(
      Object.entries(matches).filter(([, match]) => {
        if (!Array.isArray(match.matchedFiles) || match.matchedFiles.length === 0) return true;

        return match.matchedFiles.some((fileName) => (
          fileNameKeys(fileName).some((key) => liveFileNames.has(key) || liveFullPaths.has(key))
        ));
      }),
    ) as Record<string, InstalledSourceMatch>;

    return {
      ...parsed,
      fileSignature: installedFileSignature(files),
      matches: liveMatches,
    };
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

interface ReinstallPickerState {
  detail: SourceModDetail;
  group: InstalledGroup;
  sourceMatch: InstalledSourceMatch | null;
  recommendedFileId: string | null;
  recommendedReason: string;
  replaceFileNames: string[];
  candidatePool: SourceModSummary[];
}

interface RuntimeLockStatus {
  payday3Running: boolean;
  vanillaSessionActive: boolean;
  toggleLocked: boolean;
  message: string;
}
type CrashTestAnswer = "yes" | "no" | "unsure";

interface CrashTestState {
  active: boolean;
  originalEnabled: Record<string, boolean>;
  suspects: string[];
  currentGroup: string[];
  likelySuspects: string[];
  status: string;
  history: string[];
  totalEnabled: number;
  disabledGroupCount: number;
  round: number;
  excludedCount: number;
  testableCount: number;
  attemptedDisables: number;
  successfulDisables: number;
  failedDisables: number;
  skippedMods: string[];
  disabledStoragePaths: string[];
  testableKeys: string[];
  testedGroups: string[];
  lastResult: string | null;
  nextAction: string;
  noProgressReason: string | null;
}

interface CrashTestCandidate {
  key: string;
  title: string;
  enabled: boolean;
  excluded: boolean;
  exclusionReason: string | null;
  autoExcludeReason: string | null;
  manuallyOverridden: boolean;
  item?: PairedInstalledMod;
  group?: InstalledGroup;
}

interface CrashToggleResult {
  key: string;
  title: string;
  attempted: boolean;
  success: boolean;
  skippedReason?: string;
  error?: string;
  message?: string;
  disabledStoragePaths?: string[];
  batchSize?: number;
  fileCount?: number;
  elapsedMs?: number;
}
interface InstalledSourceIndexIdentity {
  sourceMod: SourceModSummary;
  matchInfo: InstalledSourceMatch;
}

interface PairedInstalledMod {
  sourceMod: SourceModSummary;
  match: InstalledSourceMatch;
  files: PakModFile[];
  group: InstalledGroup | null;
}

function sourceLabel(source: string) {
  if (source === "local") return "Local";
  return source === "modworkshop" ? "ModWorkshop" : "Nexus";
}

function matchKindLabel(matchKind?: string | null) {
  if (matchKind === "receipt") return "Matched by receipt";
  if (matchKind === "receipt-hash") return "Matched by receipt hash";
  if (matchKind === "sha256") return "Matched by SHA256";
  if (matchKind === "manifest") return "Matched by archive manifest";
  if (matchKind === "manual") return "Manual match";
  if (matchKind === "manual-cleared") return "Manual match cleared";
  if (matchKind === "unknown") return "Unknown Mod";
  if (matchKind === "source-id") return "Matched by source ID";
  if (matchKind === "proof-filename") return "Matched by filename";
  if (matchKind === "filename-suggestion") return "Filename suggestion";
  if (matchKind === "sha256-conflict") return "SHA256 needs review";
  if (matchKind === "suggestion") return "Fuzzy match";
  return matchKind ? `Match: ${matchKind}` : null;
}

function pairingReportText(matches: InstalledSourceMatch[], foundMods: number) {
  const installed = matches.filter((match) => match.installed);
  const receiptMatches = installed.filter((match) => match.matchKind === "receipt" || match.matchKind === "receipt-hash").length;
  const exactHashMatches = installed.filter((match) => match.matchKind === "sha256").length;
  const archiveManifestMatches = installed.filter((match) => match.matchKind === "manifest").length;
  const filenameMatches = matches.filter((match) => match.matchKind === "filename-suggestion" || match.matchKind === "source-id" || match.matchKind === "proof-filename").length;
  const fuzzyFilenameMatches = matches.filter((match) => match.matchKind === "suggestion").length;
  const unknownMods = Math.max(0, foundMods - receiptMatches - exactHashMatches - archiveManifestMatches - filenameMatches);

  return `Found Mods: ${foundMods}. Receipt Matches: ${receiptMatches}. Exact Hash Matches: ${exactHashMatches}. Archive Manifest Matches: ${archiveManifestMatches}. Filename Matches: ${filenameMatches}. Fuzzy Filename Matches: ${fuzzyFilenameMatches}. Unknown Mods: ${unknownMods}.`;
}

function isReceiptBackedInstalledItem(item: PairedInstalledMod) {
  return item.match.ownershipClassification === "tsuki_installed"
    || item.match.ownershipClassification === "tsuki_imported";
}

function displayAuthor(mod: SourceModSummary | SourceModDetail) {
  return displaySourceAuthor(mod);
}

function displayModTitle(mod: SourceModSummary | SourceModDetail) {
  return displaySourceTitle(mod);
}

function sourceAccent(source: string) {
  return installedSourceFallbackLabel(source);
}

function sourceKey(mod: SourceModSummary) {
  return `${mod.source}-${mod.sourceId}`;
}

function sourceImageUrl(mod?: SourceModSummary | SourceModDetail | null) {
  return mod?.thumbnailUrl || mod?.bannerUrl || null;
}

function mergeSourceSummary(existing: SourceModSummary | undefined, incoming: SourceModSummary) {
  if (!existing) {
    rememberSourceAuthorMetadata(incoming);
    return applyKnownSourceAuthor(incoming);
  }

  const merged = {
    ...existing,
    ...incoming,
    thumbnailUrl: incoming.thumbnailUrl || existing.thumbnailUrl,
    bannerUrl: incoming.bannerUrl || existing.bannerUrl,
    author: incoming.author || existing.author,
    authorUsername: incoming.authorUsername || existing.authorUsername,
    authorUserId: incoming.authorUserId || existing.authorUserId,
    authorProfileUrl: incoming.authorProfileUrl || existing.authorProfileUrl,
    authorAvatarUrl: incoming.authorAvatarUrl || existing.authorAvatarUrl,
    version: incoming.version || existing.version,
    pageUrl: incoming.pageUrl || existing.pageUrl,
    updatedAt: incoming.updatedAt || existing.updatedAt,
    downloads: incoming.downloads ?? existing.downloads,
    likes: incoming.likes ?? existing.likes,
    views: incoming.views ?? existing.views,
    shortDescription: incoming.shortDescription || existing.shortDescription,
    tags: [...new Set([...(existing.tags ?? []), ...(incoming.tags ?? [])])],
  };

  rememberSourceAuthorMetadata(merged);
  return applyKnownSourceAuthor(merged);
}



function metadataAuthorAvailable(author?: string | null) {
  const value = String(author ?? "").trim();
  return Boolean(value && !/^unknown author$/i.test(value) && !/^community mod$/i.test(value));
}

function summaryNeedsInstalledHydration(summary: SourceModSummary) {
  return !sourceImageUrl(summary) || !metadataAuthorAvailable(summary.author) || !summary.pageUrl;
}

function summaryAddsHydrationValue(existing: SourceModSummary | undefined, incoming: SourceModSummary) {
  if (!existing) return true;
  if (!sourceImageUrl(existing) && sourceImageUrl(incoming)) return true;
  if (!metadataAuthorAvailable(existing.author) && metadataAuthorAvailable(incoming.author)) return true;
  if (!existing.pageUrl && incoming.pageUrl) return true;
  if (!existing.version && incoming.version) return true;
  if (!existing.updatedAt && incoming.updatedAt) return true;
  if ((incoming.tags ?? []).some((tag) => !(existing.tags ?? []).some((existingTag) => existingTag.toLowerCase() === tag.toLowerCase()))) return true;
  return false;
}

function installedSummaryFromMatchMetadata(item: PairedInstalledMod): SourceModSummary {
  const match = item.match;
  return applyKnownSourceAuthor({
    ...item.sourceMod,
    name: match.displayName || item.sourceMod.name,
    author: match.author || item.sourceMod.author,
    authorUsername: item.sourceMod.authorUsername,
    authorUserId: item.sourceMod.authorUserId,
    authorProfileUrl: item.sourceMod.authorProfileUrl,
    authorAvatarUrl: item.sourceMod.authorAvatarUrl,
    version: match.sourceFileVersion || item.sourceMod.version,
    thumbnailUrl: match.thumbnailUrl || item.sourceMod.thumbnailUrl,
    bannerUrl: match.bannerUrl || item.sourceMod.bannerUrl,
    pageUrl: match.pageUrl || item.sourceMod.pageUrl,
    updatedAt: match.sourceUpdatedAt || item.sourceMod.updatedAt,
    tags: [...new Set([
      ...(item.sourceMod.tags ?? []),
      match.sourceFileCategory ?? null,
      match.sourceFileName ?? null,
      matchKindLabel(match.matchKind),
    ].filter(Boolean) as string[])],
  });
}

function installedHydrationMissingReason(summary: SourceModSummary) {
  if (!sourceImageUrl(summary)) return "No thumbnail or banner URL in receipt, Source Index, cache, or live detail.";
  if (!metadataAuthorAvailable(summary.author)) return "Author metadata unavailable from receipt, Source Index, cache, or live detail.";
  if (!summary.pageUrl) return "Source page URL unavailable from receipt, Source Index, cache, or live detail.";
  return "Metadata complete.";
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

  return ["receipt", "receipt-hash", "sha256", "manifest", "persistent", "manual", "user-confirmed", "user-confirmed-sha256"].includes(existing.matchKind);
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
    const isProofPair = match.installed && ["sha256", "manifest", "persistent"].includes(match.matchKind);

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

  const summary = applyKnownSourceAuthor({
    source: detail.source,
    sourceId: detail.sourceId,
    name: detail.name,
    author: detail.author,
    authorUsername: detail.authorUsername,
    authorUserId: detail.authorUserId,
    authorProfileUrl: detail.authorProfileUrl,
    authorAvatarUrl: detail.authorAvatarUrl,
    version: detail.version,
    thumbnailUrl: detail.thumbnailUrl,
    bannerUrl: detail.bannerUrl,
    pageUrl: detail.pageUrl,
    updatedAt: detail.updatedAt,
    downloads: detail.downloads,
    likes: detail.likes,
    views: detail.views,
    shortDescription: [detail.shortDescription, fileAliasText].filter(Boolean).join(" "),
    tags,
  });

  rememberSourceAuthorMetadata(summary);
  return summary;
}

function cacheAge(savedAt?: number) {
  if (!savedAt) return "unknown";

  const seconds = Math.max(1, Math.floor((Date.now() - savedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function installedUpdatedLabel(match: InstalledSourceMatch) {
  const raw = Number(match.sourceUpdatedUnix ?? match.installedModifiedUnix ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return null;

  const timestamp = raw < 4_000_000_000 ? raw * 1000 : raw;
  const seconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "Updated just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.floor(hours / 24)}d ago`;
}

function cachedSourcePriority(mod: SourceModSummary) {
  const hasImage = mod.thumbnailUrl || mod.bannerUrl ? 1000 : 0;
  const updated = Number(mod.updatedAt ?? 0) || 0;
  return hasImage + updated;
}

function loadSourceModsFromCache(profileId: string, limit = 550) {
  const mods = new Map<string, SourceModSummary>();
  let newestCache = 0;
  let cacheBuckets = 0;

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith("tsuki-source-cache:")) continue;
    if (!sourceCacheKeyBelongsToProfile(key, profileId)) continue;

    // Ignore older auto-installed source indexes. They may contain experimental aliases
    // from previous builds that caused false positives. Normal Browse caches still load.
    if (key.includes(":installed:index") && key !== installedEnrichCacheKey(profileId)) continue;

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
    const parsed = JSON.parse(window.localStorage.getItem(profileLocalStorageKey(PAIR_STATE_CACHE_KEY, profileId)) ?? "{}") as CachedPairState;

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
      for (const key of fileNameKeys(file)) claimed.add(key);
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
    const newestModified = Math.max(...item.groups.map((group) => group.modifiedUnix).filter(Boolean), 0);
    const enabled = item.groups.some((group) => group.enabled);

    matches.push({
      source: item.mod.source,
      sourceId: item.mod.sourceId,
      installed: false,
      enabled,
      updateAvailable: false,
      confidence: Math.min(item.score, 85),
      ownershipClassification: "local_detected",
      reason: `${item.reason}; filename/stem similarity is a suggestion only and requires user confirmation`,
      matchedFiles: [],
      installedModifiedUnix: newestModified || null,
      sourceUpdatedAt: item.mod.updatedAt ?? null,
      sourceUpdatedUnix: Number(item.mod.updatedAt) || null,
      matchKind: "filename-suggestion",
    });
  }

  return matches;
}




function pairFilesFromMatch(match: InstalledSourceMatch, groups: InstalledGroup[], sourceMod?: SourceModSummary) {
  const matched = new Set(match.matchedFiles.flatMap(fileNameKeys));

  const directGroups = groups.filter((group) => {
    return group.files.some((file) => (
      fileNameKeys(file.fileName).some((key) => matched.has(key))
      || fileNameKeys(file.fullPath).some((key) => matched.has(key))
    ));
  });

  if (directGroups.length > 1) {
    return mergeInstalledGroups(directGroups, `${match.source}-${match.sourceId}`);
  }

  if (directGroups.length === 1) return directGroups[0];

  if (sourceMod && strongInstalledMatch(match)) {
    const win64Groups = groups.filter((group) => strongMatchClaimsWin64Group(sourceMod, match, group));
    if (win64Groups.length > 1) return mergeInstalledGroups(win64Groups, `${match.source}-${match.sourceId}:win64`);
    if (win64Groups.length === 1) return win64Groups[0];
  }

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
  if (item.match.missing || item.match.broken) return false;
  if (isReceiptBackedInstalledItem(item) || strongInstalledMatch(item.match)) return item.match.enabled !== false;
  if (item.group) return item.group.enabled;
  return item.files.length > 0 ? item.files.some((file) => file.enabled) : item.match.enabled !== false;
}

function installedPathLooksWin64OrUe4ss(value?: string | null) {
  const text = String(value ?? "").replace(/\//g, "\\").toLowerCase();
  return text.includes("\\binaries\\win64\\mods\\")
    || text.includes("\\binaries\\win64\\disabled_ue4ss_mods\\")
    || text.includes("\\binaries\\win64\\ue4ss")
    || text.includes("\\binaries\\win64\\") && (
      text.includes("ue4ss")
      || text.includes("modloader")
      || text.includes("mod_loader")
      || text.includes("logicmods")
      || text.includes("moolah")
      || text.endsWith("\\xinput1_3.dll")
      || text.endsWith("\\xinput1_4.dll")
      || text.endsWith("\\dwmapi.dll")
      || text.endsWith("\\dsound.dll")
      || text.endsWith("\\winhttp.dll")
      || text.endsWith("\\version.dll")
      || text.endsWith("\\mods.txt")
      || text.endsWith("\\enabled.txt")
    );
}

function strongInstalledMatch(match: InstalledSourceMatch) {
  return Boolean(match.installed && ["receipt", "receipt-hash", "sha256", "manifest", "persistent", "manual", "user-confirmed", "user-confirmed-sha256"].includes(match.matchKind));
}

function pluginIdentityKey(value?: string | null) {
  return compact(normalizeInstalledName(String(value ?? "").replace(/\.[a-z0-9]{2,8}$/i, "")));
}

function pluginRootKeyFromPath(value?: string | null) {
  const parts = String(value ?? "").replace(/\//g, "\\").split("\\").filter(Boolean);
  const lower = parts.map((part) => part.toLowerCase());
  const win64 = lower.lastIndexOf("win64");
  if (win64 < 0) return null;

  const mods = lower.indexOf("mods", win64 + 1);
  if (mods >= 0 && parts[mods + 1]) return pluginIdentityKey(parts[mods + 1]);

  const disabled = lower.indexOf("disabled_ue4ss_mods", win64 + 1);
  if (disabled >= 0 && parts[disabled + 1]) return pluginIdentityKey(parts[disabled + 1]);

  const ue4ss = lower.findIndex((part, index) => index > win64 && part.includes("ue4ss"));
  if (ue4ss >= 0 && parts[ue4ss + 1]) return pluginIdentityKey(parts[ue4ss + 1]);

  const last = parts[parts.length - 1] ?? "";
  const parent = parts[parts.length - 2] ?? "";
  const text = `${parent} ${last}`.toLowerCase();
  if (text.includes("ue4ss") || text.includes("modloader") || text.includes("logicmods") || text.includes("moolah")) {
    return pluginIdentityKey(parent || last);
  }

  return null;
}

function win64GroupIdentityKeys(group: InstalledGroup) {
  const keys = new Set<string>();

  for (const file of group.files) {
    const root = pluginRootKeyFromPath(file.fullPath) ?? pluginRootKeyFromPath(file.fileName);
    if (root && root.length >= 3) keys.add(root);
  }

  if (keys.size === 0 && group.files.some((file) => installedPathLooksWin64OrUe4ss(file.fullPath) || installedPathLooksWin64OrUe4ss(file.fileName))) {
    const fallback = pluginIdentityKey(group.label || group.key);
    if (fallback.length >= 3) keys.add(fallback);
  }

  return keys;
}

function looseWin64GroupIdentityKeys(group: InstalledGroup) {
  const looksWin64 = group.files.some((file) => installedPathLooksWin64OrUe4ss(file.fullPath) || installedPathLooksWin64OrUe4ss(file.fileName));
  const keys = win64GroupIdentityKeys(group);
  if (!looksWin64) return keys;

  const values = [
    group.key,
    group.label,
    ...group.files.flatMap((file) => {
      const pathParts = String(file.fullPath ?? "").replace(/\//g, "\\").split("\\").filter(Boolean);
      const fileName = enabledFileName(file.fileName);
      const pathFileName = pathParts[pathParts.length - 1] ?? "";
      const parentFolder = pathParts[pathParts.length - 2] ?? "";

      return [
        fileName,
        fileName.replace(/\.[a-z0-9]{2,8}$/i, ""),
        pathFileName,
        pathFileName.replace(/\.[a-z0-9]{2,8}$/i, ""),
        parentFolder,
      ];
    }),
  ];

  for (const value of values) {
    const key = pluginIdentityKey(value);
    if (key.length >= 3) keys.add(key);
  }

  return keys;
}

function sourceIdentityKeysForMatch(sourceMod: SourceModSummary, match: InstalledSourceMatch) {
  const values = [
    sourceMod.name,
    sourceMod.sourceId,
    match.sourceId,
    match.sourceFileId ?? "",
    match.sourceFileName ?? "",
    match.displayName ?? "",
    ...(match.matchedFiles ?? []),
  ];

  return values
    .flatMap((value) => {
      const raw = String(value ?? "");
      return [
        compact(normalizeInstalledName(raw)),
        pluginIdentityKey(raw),
      ];
    })
    .filter((value, index, all) => value.length >= 3 && all.indexOf(value) === index);
}

function strongMatchClaimsWin64Group(sourceMod: SourceModSummary, match: InstalledSourceMatch, group: InstalledGroup) {
  if (!strongInstalledMatch(match)) return false;
  const groupKeys = [...looseWin64GroupIdentityKeys(group)];
  if (groupKeys.length === 0) return false;
  if (sourceIdAppearsInGroup(sourceMod, group)) return true;

  const sourceKeys = sourceIdentityKeysForMatch(sourceMod, match);
  return groupKeys.some((groupKey) => sourceKeys.some((sourceKey) => (
    sourceKey === groupKey
    || sourceKey.includes(groupKey)
    || groupKey.includes(sourceKey)
  )));
}

function installedSurfaceLabel(item: PairedInstalledMod) {
  if (sourceFileCategoryLooksWin64OrUe4ss(item.match.sourceFileCategory)) return "Win64/UE4SS";

  const paths = [
    ...(item.match.matchedFiles ?? []),
    ...(item.group?.files ?? []).flatMap((file) => [file.fileName, file.fullPath]),
  ];

  return paths.some(installedPathLooksWin64OrUe4ss) ? "Win64/UE4SS" : null;
}

function groupLooksWin64OrUe4ss(group: InstalledGroup) {
  return group.files.some((file) => installedPathLooksWin64OrUe4ss(file.fullPath) || installedPathLooksWin64OrUe4ss(file.fileName));
}

function installedPathLooksPakFamily(value?: string | null) {
  const text = String(value ?? "").toLowerCase().split("?")[0];
  return /\.(pak|ucas|utoc)(?:\.disabled)?$/i.test(text)
    || text.includes(".pak.disabled")
    || text.includes(".ucas.disabled")
    || text.includes(".utoc.disabled");
}

function installedPathLooksDisabledStorage(value?: string | null) {
  const text = String(value ?? "").replace(/\//g, "\\").toLowerCase();
  return text.includes("\\disabled_ue4ss_mods\\")
    || text.includes("\\disabled_pak_mods\\")
    || text.includes("\\_local_matched\\")
    || text.includes("tsuki_disabled")
    || text.includes("tsuki-disabled")
    || /\.disabled$/i.test(text);
}

function installedPathLooksManageableWin64(value?: string | null) {
  const text = String(value ?? "").replace(/\//g, "\\").toLowerCase();
  return installedPathLooksWin64OrUe4ss(value)
    || text.includes("\\disabled_ue4ss_mods\\")
    || text.includes("\\_local_matched\\")
    || /\.(dll|lua|ini|json|txt)(?:\.disabled)?$/i.test(text);
}

function sourceFileCategoryLooksWin64OrUe4ss(category?: string | null) {
  const text = String(category ?? "").toLowerCase();
  return text.includes("ue4ss")
    || text.includes("win64")
    || text.includes("plugin")
    || text.includes("dll")
    || text.includes("lua");
}

function sourceFileCategoryLooksManageable(category?: string | null) {
  const text = String(category ?? "").toLowerCase();
  return text.includes("pak")
    || text.includes("ue4ss")
    || text.includes("win64")
    || text.includes("plugin")
    || text.includes("mod");
}

function itemHasManageableInstalledFiles(item: PairedInstalledMod) {
  if (item.group) return true;
  if (isReceiptBackedInstalledItem(item)) return true;
  if (!strongInstalledMatch(item.match)) return false;

  const matchedFiles = (item.match.matchedFiles ?? []).filter((value): value is string => Boolean(value && value.trim().length > 0));
  if (matchedFiles.length === 0) return false;

  const win64OrUe4ss = installedSurfaceLabel(item) === "Win64/UE4SS"
    || sourceFileCategoryLooksWin64OrUe4ss(item.match.sourceFileCategory);
  if (win64OrUe4ss) {
    return matchedFiles.some(installedPathLooksManageableWin64)
      || (item.match.enabled === false && sourceFileCategoryLooksManageable(item.match.sourceFileCategory));
  }

  if (matchedFiles.some(installedPathLooksPakFamily)) return true;

  return item.match.enabled === false && sourceFileCategoryLooksManageable(item.match.sourceFileCategory);
}

function ownershipBadgeLabel(match: InstalledSourceMatch) {
  if (match.missing || match.broken) return "Missing/Broken";
  if (match.ownershipClassification === "tsuki_installed" || match.ownershipClassification === "tsuki_imported") return "Installed by Tsuki";
  if (match.ownershipClassification === "local_detected") return "Local detected";
  if (match.ownershipClassification === "unknown_local") return "Unknown local";
  return null;
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

function cleanSourceDescription(text?: string | null) {
  return decodeHtmlEntities(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[\/?(?:heading|b|i|u|size|color|font|center|quote|list|\*|url|img)[^\]]*\]/gi, " ")
    .replace(/\[code\]/gi, "`")
    .replace(/\[\/code\]/gi, "`")
    .replace(/Description\s+Images\s+Downloads\s+(Changelog\s+)?Dependencies\s*&\s*Instructions/gi, " ")
    .replace(/Images\s+Downloads\s+(Changelog\s+)?Dependencies\s*&\s*Instructions/gi, " ")
    .replace(/Install with Mod Organizer 2.*$/gim, "")
    .replace(/Don't have Mod Organizer 2\??/gim, "")
    .replace(/^\s*[a-f0-9]{4,}\s+/gim, "")
    .replace(/\bDownloads?\s+\d+\b/gi, " ")
    .replace(/\bViews?\s+\d+\b/gi, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function sourceFileVersionScore(file: SourceModFile) {
  const raw = `${file.version ?? ""} ${file.name}`.toLowerCase();
  const numbers = raw.match(/\d+(?:\.\d+)?/g)?.slice(0, 4).map(Number) ?? [];
  return numbers.reduce((score, value, index) => score + value / Math.pow(1000, index), 0);
}

function formatSourceFileDate(raw?: string | null) {
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
    `Uploaded ${formatSourceFileDate(file.uploadedAt)}`,
  ].filter(Boolean).join(" - ");
}

type SourceFileBucket = "main" | "optional" | "old";

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

function compareSourceFilesNewest(a: SourceModFile, b: SourceModFile) {
  return sourceFileDateValue(b) - sourceFileDateValue(a)
    || sourceFileVersionScore(b) - sourceFileVersionScore(a)
    || String(b.id).localeCompare(String(a.id));
}

function sourceFileBucket(file: SourceModFile, newestMain?: SourceModFile | null, source?: ModSourceKind): SourceFileBucket {
  const text = `${file.name} ${file.version ?? ""} ${file.downloadUrl ?? ""}`.toLowerCase();
  if (/\b(old|legacy|previous|archive|archived|deprecated|outdated|unsupported)\b/.test(text)) return "old";
  if (!newestMain || file.id === newestMain.id) return "main";
  if (source === "modworkshop") return "optional";

  const thisSeries = normalizedFileSeries(file);
  const mainSeries = normalizedFileSeries(newestMain);
  const sameSeries = Boolean(thisSeries && mainSeries && (thisSeries === mainSeries || thisSeries.includes(mainSeries) || mainSeries.includes(thisSeries)));
  const olderDate = sourceFileDateValue(file) > 0 && sourceFileDateValue(newestMain) > 0 && sourceFileDateValue(file) < sourceFileDateValue(newestMain);
  const olderVersion = sourceFileVersionScore(file) > 0 && sourceFileVersionScore(newestMain) > 0 && sourceFileVersionScore(file) < sourceFileVersionScore(newestMain);
  if (sameSeries && file.id !== newestMain.id) return "old";
  if (olderDate || olderVersion) return "old";
  if (/\b(optional|addon|add-on|patch|compat|plugin|extra|lite|translation|variant|bonus|separate|requirement|required)\b/.test(text)) return "optional";
  return "optional";
}

function groupedInstalledSourceFiles(files: SourceModFile[], source?: ModSourceKind) {
  const installable = source === "modworkshop"
    ? files.filter(isInstallableSourceFile)
    : installableSourceFiles(files).sort(compareSourceFilesNewest);
  const newestMain = source === "modworkshop"
    ? installable[0] ?? null
    : installable.find((file) => !/\b(optional|addon|add-on|patch|compat|plugin|extra|lite|translation|variant|old|legacy|previous|archive|deprecated)\b/i.test(`${file.name} ${file.version ?? ""}`)) ?? installable[0] ?? null;
  const groups: Record<SourceFileBucket, SourceModFile[]> = { main: [], optional: [], old: [] };
  for (const file of installable) groups[sourceFileBucket(file, newestMain, source)].push(file);
  if (groups.main.length === 0 && installable.length > 0) {
    groups.main.push(installable[0]);
    groups.optional = groups.optional.filter((file) => file.id !== installable[0].id);
    groups.old = groups.old.filter((file) => file.id !== installable[0].id);
  }
  return groups;
}

function sourceFileBucketOrder(category?: string | null): SourceFileBucket[] {
  const lower = String(category ?? "").toLowerCase();
  if (/\b(optional|addon|add-on|extra|variant)\b/.test(lower)) return ["optional"];
  if (/\b(old|legacy|previous|archive|archived|deprecated|outdated)\b/.test(lower)) return ["old", "main"];
  return ["main"];
}

function normalizedFileFamilyName(value: string) {
  return String(value ?? "")
    .toLowerCase()
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(zip|rar|7z|pak|ucas|utoc|dll|lua|ini)$/i, "")
    .replace(/(?:^|[^a-z0-9])(ver|version|v)\s*\d+(?:\.\d+){0,4}/gi, " ")
    .replace(/(ver|version|v)\s*\d+(?:\.\d+){0,4}/gi, " ")
    .replace(/\b\d+(?:\.\d+){0,4}\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function fileFamilySimilarity(a: string, b: string) {
  const left = normalizedFileFamilyName(a);
  const right = normalizedFileFamilyName(b);
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (left.includes(right) || right.includes(left)) return 88;

  const leftTokens = new Set(left.split(/\s+/).filter((token) => token.length > 1));
  const rightTokens = new Set(right.split(/\s+/).filter((token) => token.length > 1));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  const ratio = overlap / Math.max(leftTokens.size, rightTokens.size);
  return Math.round(ratio * 78);
}

function matchedFileNamesForSourceFile(file: SourceModFile, match?: InstalledSourceMatch | null) {
  if (!match?.installed) return [];
  const needle = file.name.toLowerCase().replace(/\s+/g, "");
  const fileId = file.id.toLowerCase();
  return (match.matchedFiles ?? []).filter((value) => {
    const clean = value.toLowerCase().replace(/\s+/g, "");
    return clean.includes(needle) || clean.includes(fileId);
  });
}

function bestReinstallFileForGroup(files: SourceModFile[], group: InstalledGroup, match?: InstalledSourceMatch | null) {
  const installable = installableSourceFiles(files);
  const groups = groupedInstalledSourceFiles(files, match?.source);
  const exactId = String(match?.sourceFileId ?? "").trim();

  if (exactId) {
    const exact = installable.find((file) => String(file.id) === exactId);
    if (exact) return { file: exact, reason: `exact saved file id ${exactId}` };
  }

  const installedNames = [
    match?.sourceFileName ?? "",
    ...(match?.matchedFiles ?? []),
    ...group.files.flatMap((file) => [file.fileName, file.fullPath]),
  ].filter((value) => value && normalizedFileFamilyName(value));

  const buckets = sourceFileBucketOrder(match?.sourceFileCategory);
  let best: { file: SourceModFile; score: number; bucket: SourceFileBucket } | null = null;

  for (const bucket of buckets) {
    for (const file of groups[bucket]) {
      const score = Math.max(0, ...installedNames.map((name) => fileFamilySimilarity(name, file.name)));
      if (score < 70) continue;
      if (
        !best
        || score > best.score
        || (score === best.score && compareSourceFilesNewest(file, best.file) < 0)
      ) {
        best = { file, score, bucket };
      }
    }

    if (best) break;
  }

  if (best) {
    return {
      file: best.file,
      reason: `${best.bucket} filename-family match (${best.score})`,
    };
  }

  if (groups.main.length > 0) {
    return {
      file: groups.main[0],
      reason: "newest Main file fallback",
    };
  }

  return {
    file: null,
    reason: exactId
      ? `saved file id ${exactId} no longer exists and no same-family ${buckets.join("/")} file was found`
      : `no same-family ${buckets.join("/")} file was found`,
  };
}

function reinstallPickerFiles(detail: SourceModDetail) {
  const groups = groupedInstalledSourceFiles(detail.files, detail.source);
  return ([
    ["main", "Main files"],
    ["optional", "Optional files"],
    ["old", "Old versions"],
  ] as Array<[SourceFileBucket, string]>)
    .filter(([bucket]) => bucket !== "old" || groups.old.length > 0)
    .flatMap(([bucket, label]) => groups[bucket].map((file) => ({ file, bucket, label })));
}


function fileNameKey(value: string) {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return (parts.length > 0 ? parts[parts.length - 1] : value).toLowerCase();
}

function fileNameKeys(value: string) {
  const key = fileNameKey(value);
  const canonical = enabledFileName(key).toLowerCase();
  return key === canonical ? [key] : [key, canonical];
}

function fileKeySetForPakFiles(files: PakModFile[]) {
  const keys = new Set<string>();

  for (const file of files) {
    for (const key of fileNameKeys(file.fileName)) keys.add(key);
    for (const key of fileNameKeys(file.fullPath)) keys.add(key);
  }

  return keys;
}

function recordMatchesSourceMatch(record: InstalledStateRecord, sourceMod: SourceModSummary, match: InstalledSourceMatch) {
  if (match.receiptId && record.receiptId && record.receiptId === match.receiptId) return true;

  const sourceMatches = record.source === sourceMod.source || record.source === match.source;
  if (!sourceMatches) return false;

  const sourceIds = [sourceMod.sourceId, match.sourceId].filter(Boolean).map((value) => String(value).toLowerCase());
  const recordModIds = [record.sourceModId, record.id, record.uid].filter(Boolean).map((value) => String(value).toLowerCase());
  if (sourceIds.some((id) => recordModIds.includes(id))) return true;

  const matchFileIds = [match.sourceFileId, match.sourceFileName].filter(Boolean).map((value) => String(value).toLowerCase());
  const recordFileIds = [record.sourceFileId, record.fileId, record.filename].filter(Boolean).map((value) => String(value).toLowerCase());
  return matchFileIds.some((id) => recordFileIds.includes(id));
}

function installedStateFilesForMatch(match: InstalledSourceMatch, sourceMod: SourceModSummary, records: InstalledStateRecord[]) {
  return records
    .filter((record) => recordMatchesSourceMatch(record, sourceMod, match))
    .flatMap((record) => (record.files ?? [])
      .filter((file) => file.live !== false)
      .flatMap((file) => [file.relativePath, file.fileName])
      .concat(record.filename)
      .filter((value): value is string => Boolean(value && value.trim().length > 0)));
}

function matchWithLocalFiles(match: InstalledSourceMatch, group: InstalledGroup | null, sourceMod: SourceModSummary, records: InstalledStateRecord[]) {
  const matchedFiles = [...new Set([
    ...(match.matchedFiles ?? []),
    ...(group?.files ?? []).flatMap((file) => [file.fileName, file.fullPath]),
    ...installedStateFilesForMatch(match, sourceMod, records),
  ].filter((value): value is string => Boolean(value && value.trim().length > 0)))];

  if (matchedFiles.length === match.matchedFiles.length) return match;
  return { ...match, matchedFiles };
}

function localIdentityTokensFromFile(file: PakModFile) {
  const tokens = new Set<string>();
  const paths = [file.fullPath, file.fileName].filter(Boolean);

  for (const value of paths) {
    const clean = enabledFileName(String(value)).replace(/\//g, "\\").toLowerCase();
    if (clean) tokens.add(`path:${clean}`);
    const root = pluginRootKeyFromPath(value);
    if (root) tokens.add(`plugin:${root}`);
  }

  if (file.sha256) tokens.add(`sha:${file.sha256.toLowerCase()}`);
  return tokens;
}

function localIdentityTokensFromPath(value: string) {
  const tokens = new Set<string>();
  const clean = enabledFileName(value).replace(/\//g, "\\").toLowerCase();
  if (clean) tokens.add(`path:${clean}`);
  const root = pluginRootKeyFromPath(value);
  if (root) tokens.add(`plugin:${root}`);
  return tokens;
}

function localIdentityTokensForGroup(group: InstalledGroup) {
  const tokens = new Set<string>();
  for (const file of group.files) {
    for (const token of localIdentityTokensFromFile(file)) tokens.add(token);
  }
  return tokens;
}

function localIdentityTokensForPairedItem(item: PairedInstalledMod) {
  const tokens = new Set<string>();
  for (const file of item.files) {
    for (const token of localIdentityTokensFromFile(file)) tokens.add(token);
  }
  for (const path of item.match.matchedFiles ?? []) {
    for (const token of localIdentityTokensFromPath(path)) tokens.add(token);
  }
  if (strongInstalledMatch(item.match)) {
    for (const key of sourceIdentityKeysForMatch(item.sourceMod, item.match)) {
      tokens.add(`plugin:${key}`);
    }
  }
  return tokens;
}

function groupConsumedByPairedIdentity(group: InstalledGroup, consumedTokens: Set<string>) {
  for (const token of localIdentityTokensForGroup(group)) {
    if (consumedTokens.has(token)) return true;
  }
  return false;
}

function installedFileChipLabel(value: string) {
  const parts = enabledFileName(value).split(/[\\/]/).filter(Boolean);
  const clean = parts.length > 0 ? parts[parts.length - 1] : enabledFileName(value);
  if (clean.length <= 16) return clean;
  const extension = clean.match(/\.[a-z0-9]{2,6}$/i)?.[0] ?? "";
  const body = extension ? clean.slice(0, -extension.length) : clean;
  return `${body.slice(0, 8)}...${extension}`;
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

  if (text.includes("tsuki-installed") || text.includes("installed by tsuki receipt")) return true;

  if (foreignMarkers.some((marker) => text.includes(marker))) return false;

  if (mod.source === "nexus") {
    return mod.pageUrl?.toLowerCase().includes("/payday3/") ?? true;
  }

  if (mod.source === "modworkshop") {
    return text.includes("payday 3") || text.includes("payday3") || text.includes("pd3") || (mod.tags ?? []).some((tag) => tag.toLowerCase() === "payday 3");
  }

  return true;
}

function isProfileSourceCandidate(profileId: string, mod: SourceModSummary) {
  if (profileId !== "builtin.payday3") return Boolean(mod?.source && mod?.sourceId && mod?.name);
  return isPayday3SourceCandidate(mod);
}

function filterProfileSourceMods(profileId: string, mods: SourceModSummary[]) {
  return mods.filter((mod) => isProfileSourceCandidate(profileId, mod));
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

function liveFileDataUnavailableMessageForInstalled() {
  return "Live file data unavailable. Please try again.";
}


function sortPaired(items: PairedInstalledMod[], sortMode: SortMode) {
  return [...items].sort((a, b) => {
    if (sortMode === "modified") return (b.group?.modifiedUnix ?? 0) - (a.group?.modifiedUnix ?? 0);
    if (sortMode === "size") return (b.group?.sizeBytes ?? 0) - (a.group?.sizeBytes ?? 0);
    return a.sourceMod.name.localeCompare(b.sourceMod.name);
  });
}



interface InstalledPageProps {
  currentGameProfile: GameProfile;
  profileRuntime?: ActiveProfileRuntime | null;
  profileSwitching?: boolean;
}

export function InstalledPage({ currentGameProfile, profileRuntime, profileSwitching = false }: InstalledPageProps) {
  const profileId = currentGameProfile.profileId;
  const runtimeSourceConfig = profileRuntime?.sourceConfig ?? currentGameProfile.sourceConfig ?? {};
  const hasModWorkshopSource = Boolean(runtimeSourceConfig.modworkshopGameId || runtimeSourceConfig.modworkshopSlug);
  const hasNexusSource = Boolean(runtimeSourceConfig.nexusDomain || runtimeSourceConfig.nexusGameId);
  const nexusGameDomain = runtimeSourceConfig.nexusDomain ?? null;
  const hasConfiguredSources = profileHasConfiguredSources(currentGameProfile) || hasModWorkshopSource || hasNexusSource || Boolean(runtimeSourceConfig.customBrowser);
  const gameName = profileRuntime?.gameName || currentGameProfile.displayName || "Current game";
  const modWorkshopGameKey = runtimeSourceConfig.modworkshopGameId || runtimeSourceConfig.modworkshopSlug || currentGameProfile.gameKey || profileId;
  const runtimeReady = !profileSwitching && profileRuntime?.profileId === profileId;
  const sessionCache = useMemo(() => readInstalledSessionCache(profileId), [profileId]);
  const [scanResult, setScanResult] = useState<PakScanResult | null>(() => sessionCache?.scanResult ?? null);
  const [sourceMods, setSourceMods] = useState<SourceModSummary[]>(() => sessionCache?.sourceMods ?? []);
  const [matches, setMatches] = useState<Record<string, InstalledSourceMatch>>(() => sessionCache?.matches ?? {});
  const [installedState, setInstalledState] = useState<InstalledStateRecord[]>(() => sessionCache?.installedState ?? []);
  const [status, setStatus] = useState(() => sessionCache?.status ?? "Ready to scan installed mods.");
  const [runtimeLock, setRuntimeLock] = useState<RuntimeLockStatus | null>(() => sessionCache?.runtimeLock ?? null);
  const [pairingStatus, setPairingStatus] = useState(() => sessionCache?.pairingStatus ?? "Open Browse first so Tsuki has source cards to pair.");
  const [sourceCacheAge, setSourceCacheAge] = useState(() => sessionCache?.sourceCacheAge ?? "unknown");
  const [sourceCacheBuckets, setSourceCacheBuckets] = useState(() => sessionCache?.sourceCacheBuckets ?? 0);
  const [searchQuery, setSearchQuery] = useState("");
  const [view] = useState<InstalledView>("all");
  const [sortMode, setSortMode] = useState<SortMode>("name");
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>("all");
  const [renderLimit, setRenderLimit] = useState(48);
  useEffect(() => { setRenderLimit(48); }, [profileId, searchQuery, sortMode, enabledFilter, view]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [selectedSourceMod, setSelectedSourceMod] = useState<SourceModDetail | null>(null);
  const [selectedSourceMatch, setSelectedSourceMatch] = useState<InstalledSourceMatch | null>(null);
  const [manualEditTarget, setManualEditTarget] = useState<ManualEditTarget | null>(null);
  const [detailLoadingKey, setDetailLoadingKey] = useState<string | null>(null);
  const [searchPairLimit, setSearchPairLimit] = useState(10);
  const [nexusIndexing, setNexusIndexing] = useState(false);
  const [backgroundPairing, setBackgroundPairing] = useState(false);
  const [autoPairEnabled] = useState(false);
  const [autoPairStatus, setAutoPairStatus] = useState("Pair Ledger v1 active. Broad Auto Pair is disabled; use Try Pair on a selected mod.");
  const [sourceUpdates, setSourceUpdates] = useState<SourceUpdateStatus[]>(() => readReceiptUpdateCheckCache(profileId)?.updates ?? []);
  const [failedImages, setFailedImages] = useState<Record<string, number>>(() => readThumbnailFailures());
  const [metadataHydrationStatus, setMetadataHydrationStatus] = useState<InstalledHydrationDiagnostics>({
    checked: 0,
    hydratedCount: 0,
    missingCount: 0,
    thumbnailSource: "idle",
    metadataSource: "idle",
    missingReason: "Installed scan has not run yet.",
    running: false,
  });
  const [updatesBusy, setUpdatesBusy] = useState(false);
  const [receiptUpdateCache, setReceiptUpdateCache] = useState<ReceiptUpdateCheckCache | null>(() => readReceiptUpdateCheckCache(profileId));
  const [unpairableGroups, setUnpairableGroups] = useState<string[]>(() => loadUnpairableGroups(profileId));
  const [rejectedPairings, setRejectedPairings] = useState<string[]>(() => loadStringList(profileLocalStorageKey(REJECTED_PAIRINGS_KEY, profileId)));
  const [customGroups, setCustomGroups] = useState<string[]>(() => loadStringList(profileLocalStorageKey(CUSTOM_GROUPS_KEY, profileId)));
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [reinstallPicker, setReinstallPicker] = useState<ReinstallPickerState | null>(null);
  const [reinstallPickerSelectedIds, setReinstallPickerSelectedIds] = useState<string[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [crashTestOpen, setCrashTestOpen] = useState(false);
  const [crashTestBusy, setCrashTestBusy] = useState(false);
  const [crashTestExclusionOverrides, setCrashTestExclusionOverrides] = useState<Record<string, boolean>>(() => loadCrashTestExclusionOverrides());
  const [crashTest, setCrashTest] = useState<CrashTestState>({
    active: false,
    originalEnabled: {},
    suspects: [],
    currentGroup: [],
    likelySuspects: [],
    status: "Crash Test is idle.",
    history: [],
    totalEnabled: 0,
    disabledGroupCount: 0,
    round: 0,
    excludedCount: 0,
    testableCount: 0,
    attemptedDisables: 0,
    successfulDisables: 0,
    failedDisables: 0,
    skippedMods: [],
    disabledStoragePaths: [],
    testableKeys: [],
    testedGroups: [],
    lastResult: null,
    nextAction: "Start by disabling half of the testable enabled mods.",
    noProgressReason: null,
  });
  const autoPairTimerRef = useRef<number | null>(null);
  const pairingBusyRef = useRef(false);
  const pairingLoadBusyRef = useRef(false);
  const installedRefreshBusyRef = useRef(false);
  const installedPageActiveRef = useRef(true);
  useEffect(() => {
    installedPageActiveRef.current = true;
    return () => { installedPageActiveRef.current = false; };
  }, []);
  const initialRefreshTimerRef = useRef<number | null>(null);
  const thumbnailHydrationAttemptsRef = useRef<Set<string>>(new Set());
  const metadataHydrationBusyRef = useRef(false);
  const crashTestCancelRef = useRef(false);
  const installedProfileRef = useRef(profileId);

  useEffect(() => {
    if (installedProfileRef.current === profileId) {
      if (profileSwitching) setStatus("Switching profile...");
      return;
    }

    installedProfileRef.current = profileId;
    installedRefreshBusyRef.current = false;
    pairingBusyRef.current = false;
    pairingLoadBusyRef.current = false;
    metadataHydrationBusyRef.current = false;
    crashTestCancelRef.current = true;
    if (autoPairTimerRef.current) {
      window.clearTimeout(autoPairTimerRef.current);
      autoPairTimerRef.current = null;
    }

    clearInstalledSessionCache();
    setScanResult(null);
    setSourceMods([]);
    setMatches({});
    setInstalledState([]);
    setRuntimeLock(null);
    setSourceUpdates(readReceiptUpdateCheckCache(profileId)?.updates ?? []);
    setReceiptUpdateCache(readReceiptUpdateCheckCache(profileId));
    setUnpairableGroups(loadUnpairableGroups(profileId));
    setRejectedPairings(loadStringList(profileLocalStorageKey(REJECTED_PAIRINGS_KEY, profileId)));
    setCustomGroups(loadStringList(profileLocalStorageKey(CUSTOM_GROUPS_KEY, profileId)));
    setSelectedSourceMod(null);
    setSelectedSourceMatch(null);
    setManualEditTarget(null);
    setBusyKey(null);
    setEnriching(false);
    setBackgroundPairing(false);
    setNexusIndexing(false);
    setUpdatesBusy(false);
    setSourceCacheAge("unknown");
    setSourceCacheBuckets(0);
    setPairingStatus(hasConfiguredSources ? "Open Browse first so Tsuki has source cards to pair." : "No browse sources configured for this profile.");
    setStatus(profileSwitching ? "Switching profile..." : "No mods installed for this profile.");
  }, [hasConfiguredSources, profileId, profileSwitching]);

  const rawFiles = scanResult?.pakMods ?? [];
  const groups = useMemo(() => groupInstalledFiles(rawFiles), [rawFiles]);

  useEffect(() => {
    if (!scanResult) return;
    writeInstalledSessionCache(profileId, {
      scanResult,
      sourceMods,
      matches,
      installedState,
      status,
      pairingStatus,
      sourceCacheAge,
      sourceCacheBuckets,
      runtimeLock,
    });
  }, [installedState, matches, pairingStatus, profileId, runtimeLock, scanResult, sourceCacheAge, sourceCacheBuckets, sourceMods, status]);

  useEffect(() => {
    const pruned = pruneMissingSkippedGroups(unpairableGroups, groups);
    if (pruned.length !== unpairableGroups.length) {
      setUnpairableGroups(pruned);
      saveUnpairableGroups(profileId, pruned);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.length]);

  useEffect(() => {
    const onReceiptUpdateCheck = () => {
      const cached = readReceiptUpdateCheckCache(profileId);
      setReceiptUpdateCache(cached);
      setSourceUpdates(cached?.updates ?? []);
    };

    window.addEventListener("tsuki-receipt-update-check", onReceiptUpdateCheck);
    onReceiptUpdateCheck();

    return () => window.removeEventListener("tsuki-receipt-update-check", onReceiptUpdateCheck);
  }, [profileId]);

  const updateStatusBySourceKey = useMemo(() => {
    const map = new Map<string, SourceUpdateStatus>();

    for (const update of sourceUpdates) {
      map.set(`${update.source}-${update.modId}`, update);
    }

    return map;
  }, [sourceUpdates]);

  const allPairedMods = useMemo(() => {
    const items: PairedInstalledMod[] = [];

    for (const sourceMod of filterProfileSourceMods(profileId, sourceMods)) {
      const match = matches[`${sourceMod.source}-${sourceMod.sourceId}`];
      if (!match || (!match.installed && !match.missing)) continue;

      const group = pairFilesFromMatch(match, groups, sourceMod);
      const guardKey = pairingGuardKey(sourceMod, match, group);

      if (rejectedPairings.includes(guardKey)) continue;
      if (group && customGroups.includes(group.key)) continue;

      // Low-confidence token overlaps created obvious false positives.
      // They can become suggestions later, but they should not count as paired.
      if (!["receipt", "unknown"].includes(match.matchKind) && match.confidence < 86) continue;

      const updateStatus = updateStatusBySourceKey.get(`${sourceMod.source}-${sourceMod.sourceId}`);
      const matchWithUpdates = updateStatus
        ? {
            ...match,
            updateAvailable: updateStatus.updateAvailable,
            sourceUpdatedAt: updateStatus.latestVersion ?? match.sourceUpdatedAt,
          }
        : match;
      const hydratedMatch = matchWithLocalFiles(matchWithUpdates, group, sourceMod, installedState);

      items.push({
        sourceMod,
        match: hydratedMatch,
        group,
        files: group?.files ?? [],
      });
    }

    return sortPaired(items, sortMode);
  }, [customGroups, groups, installedState, matches, rejectedPairings, sortMode, sourceMods, updateStatusBySourceKey]);

  const pairedMods = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = allPairedMods.filter((item) => {
      if (enabledFilter === "on" && !itemEnabled(item)) return false;
      if (enabledFilter === "off" && (itemEnabled(item) || item.match.missing)) return false;
      if (!query) return true;

      return (
        item.sourceMod.name.toLowerCase().includes(query) ||
        (item.sourceMod.author ?? "").toLowerCase().includes(query) ||
        item.match.matchedFiles.some((file) => file.toLowerCase().includes(query))
      );
    });

    return sortPaired(filtered, sortMode);
  }, [allPairedMods, enabledFilter, searchQuery, sortMode]);

  const pairedFileNames = useMemo(() => {
    const names = new Set<string>();

    for (const item of allPairedMods) {
      for (const file of item.files) {
        for (const key of fileNameKeys(file.fileName)) names.add(key);
        for (const key of fileNameKeys(file.fullPath)) names.add(key);
      }

      for (const fileName of item.match.matchedFiles) {
        for (const key of fileNameKeys(fileName)) names.add(key);
      }
    }

    return names;
  }, [allPairedMods]);

  const pairedGroupKeys = useMemo(() => {
    return new Set(allPairedMods.map((item) => item.group?.key).filter((key): key is string => Boolean(key)));
  }, [allPairedMods]);

  const consumedLocalIdentityTokens = useMemo(() => {
    const tokens = new Set<string>();
    for (const item of allPairedMods) {
      for (const token of localIdentityTokensForPairedItem(item)) tokens.add(token);
    }
    return tokens;
  }, [allPairedMods]);

  const strongClaimedGroupKeys = useMemo(() => {
    const claimed = new Set<string>();

    for (const sourceMod of filterProfileSourceMods(profileId, sourceMods)) {
      const match = matches[`${sourceMod.source}-${sourceMod.sourceId}`];
      if (!match || (!match.installed && !match.missing) || !strongInstalledMatch(match)) continue;

      for (const group of groups) {
        if (strongMatchClaimsWin64Group(sourceMod, match, group)) claimed.add(group.key);
      }
    }

    return claimed;
  }, [groups, matches, sourceMods]);

  const allUnmatchedGroups = useMemo(() => {
    return groups.filter((group) => {
      if (pairedGroupKeys.has(group.key) || strongClaimedGroupKeys.has(group.key) || groupConsumedByPairedIdentity(group, consumedLocalIdentityTokens)) return false;
      return !group.files.some((file) => (
        fileNameKeys(file.fileName).some((key) => pairedFileNames.has(key))
        || fileNameKeys(file.fullPath).some((key) => pairedFileNames.has(key))
      ));
    });
  }, [consumedLocalIdentityTokens, groups, pairedFileNames, pairedGroupKeys, strongClaimedGroupKeys]);

  const unmatchedGroups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return allUnmatchedGroups
      .filter((group) => {
        if (enabledFilter === "on" && !group.enabled) return false;
        if (enabledFilter === "off" && group.enabled) return false;
        if (!query) return true;
        return (
          group.label.toLowerCase().includes(query) ||
          group.files.some((file) => file.fileName.toLowerCase().includes(query))
        );
      })
      .sort((a, b) => {
        if (sortMode === "modified") return b.modifiedUnix - a.modifiedUnix;
        if (sortMode === "size") return b.sizeBytes - a.sizeBytes;
        return a.label.localeCompare(b.label);
      });
  }, [allUnmatchedGroups, enabledFilter, searchQuery, sortMode]);

  const autoPairQueue = useMemo(() => {
    return allUnmatchedGroups.filter((group) => !unpairableGroups.includes(group.key) && !customGroups.includes(group.key));
  }, [allUnmatchedGroups, customGroups, unpairableGroups]);

  const visiblePaired = useMemo(() => {
    if (view === "updates") return pairedMods.filter((item) => item.match.updateAvailable);
    return pairedMods;
  }, [pairedMods, view]);

  const selectedSet = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const massSelectionMode = selectedKeys.length > 0;

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

  function possibleNewerLocalVersionDetected(item: PairedInstalledMod) {
    if (!item.match.missing && !item.match.broken) return false;

    const sourceNames = [
      item.match.sourceFileName,
      item.match.displayName,
      item.sourceMod.name,
      ...item.match.matchedFiles,
    ]
      .map((value) => compact(normalizeInstalledName(String(value ?? ""))))
      .filter((value) => value.length >= 6);

    if (sourceNames.length === 0) return false;

    return allUnmatchedGroups.some((group) => {
      const groupNames = [
        group.label,
        ...group.files.flatMap((file) => [file.fileName, file.fullPath]),
      ]
        .map((value) => compact(normalizeInstalledName(value)))
        .filter((value) => value.length >= 6);

      return sourceNames.some((sourceName) => groupNames.some((groupName) => {
        const shortest = Math.min(sourceName.length, groupName.length);
        if (shortest < 6) return false;
        return sourceName.includes(groupName.slice(0, Math.min(groupName.length, 14)))
          || groupName.includes(sourceName.slice(0, Math.min(sourceName.length, 14)));
      }));
    });
  }

  const pairedActiveMods = allPairedMods.filter((item) => !item.match.missing && !item.match.broken);
  const enabledPairedCount = pairedActiveMods.filter(itemEnabled).length;
  const disabledPairedCount = pairedActiveMods.filter((item) => !itemEnabled(item)).length;
  const enabledLocalCount = allUnmatchedGroups.filter((group) => group.enabled).length;
  const disabledLocalCount = allUnmatchedGroups.length - enabledLocalCount;
  const totalInstalledLocalMods = allPairedMods.length + allUnmatchedGroups.length;
  const totalEnabledMods = enabledPairedCount + enabledLocalCount;
  const totalDisabledMods = disabledPairedCount + disabledLocalCount;

  function crashTestAutoExcludeReason(title: string, item?: PairedInstalledMod, group?: InstalledGroup) {
    const text = [
      title,
      item?.sourceMod.name,
      item?.sourceMod.author,
      item?.sourceMod.shortDescription,
      ...(item?.sourceMod.tags ?? []),
      item?.match.sourceFileName,
      item?.match.sourceFileCategory,
      item?.match.reason,
      ...(item?.match.matchedFiles ?? []),
      ...(item?.files ?? []).flatMap((file) => [file.fileName, file.fullPath]),
      group?.label,
      ...(group?.files ?? []).flatMap((file) => [file.fileName, file.fullPath]),
    ].filter(Boolean).join(" ").toLowerCase();

    if (/logic\s*mod\s*loader|\bmod\s*loader\b|loader/.test(text)) return "required loader";
    if (/\bue4ss\b|xinput1?_|dinput8|winhttp|dsound|framework|hook/.test(text)) return "framework/runtime";
    if (/dependency|dependencies|required|library|lib\b/.test(text)) return "required dependency";
    return null;
  }

  function applyCrashTestExclusion(base: Omit<CrashTestCandidate, "excluded" | "exclusionReason" | "autoExcludeReason" | "manuallyOverridden">): CrashTestCandidate {
    const autoExcludeReason = crashTestAutoExcludeReason(base.title, base.item, base.group);
    const manualOverride = crashTestExclusionOverrides[base.key];
    const manuallyOverridden = typeof manualOverride === "boolean";
    const excluded = manualOverride === false ? false : (manualOverride === true || Boolean(autoExcludeReason));
    const exclusionReason = manualOverride === true
      ? "manually excluded"
      : (excluded ? autoExcludeReason : null);

    return {
      ...base,
      excluded,
      exclusionReason,
      autoExcludeReason,
      manuallyOverridden,
    };
  }

  const crashTestCandidates = useMemo<CrashTestCandidate[]>(() => {
    const paired = allPairedMods
      .filter((item) => !item.match.missing && !item.match.broken)
      .map((item) => applyCrashTestExclusion({
        key: pairedSelectionKey(item),
        title: displayModTitle({ ...item.sourceMod, name: item.match.displayName ?? item.sourceMod.name }),
        enabled: itemEnabled(item),
        item,
      }));

    const local = allUnmatchedGroups.map((group) => applyCrashTestExclusion({
      key: groupSelectionKey(group),
      title: group.label,
      enabled: group.enabled,
      group,
    }));

    return [...paired, ...local];
  }, [allPairedMods, allUnmatchedGroups, crashTestExclusionOverrides]);

  const crashCandidateMap = useMemo(() => new Map(crashTestCandidates.map((candidate) => [candidate.key, candidate])), [crashTestCandidates]);
  const selectedToggleKeys = useMemo(() => selectedKeys.filter((key) => crashCandidateMap.has(key)), [crashCandidateMap, selectedKeys]);
  const crashTestExcludedCandidates = useMemo(() => crashTestCandidates.filter((candidate) => candidate.excluded), [crashTestCandidates]);

  function setCrashTestCandidateExcluded(key: string, excluded: boolean) {
    setCrashTestExclusionOverrides((current) => {
      const next = { ...current, [key]: excluded };
      saveCrashTestExclusionOverrides(next);
      return next;
    });
    const title = crashCandidateTitle(key);
    setCrashTest((current) => ({ ...current, status: `${title} is now ${excluded ? "excluded from" : "included in"} Crash Test.` }));
  }

  function clearManualCrashTestExclusions() {
    setCrashTestExclusionOverrides({});
    saveCrashTestExclusionOverrides({});
    setCrashTest((current) => ({ ...current, status: "Manual Crash Test exclusions cleared. Auto-excluded loaders/frameworks still stay protected." }));
  }
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

  function rememberInstalledThumbnailFailure(url: string | null | undefined) {
    if (!url) return;
    const next = { ...readThumbnailFailures(), [url]: Date.now() };
    writeThumbnailFailures(next);
    setFailedImages(next);
  }

  function canUseInstalledThumbnail(url: string | null | undefined) {
    return Boolean(url && !thumbnailRecentlyFailed(url, failedImages));
  }

  function mergeSourceCards(incoming: SourceModSummary[]) {
    if (incoming.length === 0) return;

    setSourceMods((current) => {
      const map = new Map(current.map((mod) => [sourceKey(mod), mod]));

      for (const mod of incoming) {
        map.set(sourceKey(mod), mergeSourceSummary(map.get(sourceKey(mod)), mod));
      }

      const next = [...map.values()];
      saveInstalledEnrichedSourceCache(profileId, next);
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
              ? await invoke<SourceModDetail>("fetch_nexus_mod_detail", { modId: item.sourceMod.sourceId, profileId, gameDomain: nexusGameDomain })
              : await invoke<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: item.sourceMod.sourceId, profileId });

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

  useEffect(() => {
    if (allPairedMods.length === 0) return;

    const currentByKey = new Map(sourceMods.map((mod) => [sourceKey(mod), mod]));
    const localSummaries = allPairedMods
      .map(installedSummaryFromMatchMetadata)
      .filter((summary) => summaryAddsHydrationValue(currentByKey.get(sourceKey(summary)), summary));

    if (localSummaries.length > 0) {
      mergeSourceCards(localSummaries);
    }

    const missingCount = allPairedMods.filter((item) => {
      const summary = mergeSourceSummary(currentByKey.get(sourceKey(item.sourceMod)), installedSummaryFromMatchMetadata(item));
      return summaryNeedsInstalledHydration(summary);
    }).length;

    setMetadataHydrationStatus((current) => current.running ? current : {
      checked: allPairedMods.length,
      hydratedCount: localSummaries.length,
      missingCount,
      thumbnailSource: localSummaries.some(sourceImageUrl) ? "receipt/source-index/cache" : current.thumbnailSource,
      metadataSource: localSummaries.length > 0 ? "receipt/source-index/cache" : current.metadataSource,
      missingReason: missingCount > 0 ? "Some installed cards still need live detail metadata." : "Installed card metadata is hydrated from receipt, Source Index, or cache.",
      running: false,
    });
  }, [allPairedMods, sourceMods]);

  const installedHydrationTargets = useMemo(() => {
    const currentByKey = new Map(sourceMods.map((mod) => [sourceKey(mod), mod]));

    return visiblePaired.slice(0, renderLimit)
      .filter((item) => !item.match.missing && !item.match.broken)
      .filter((item) => ["receipt", "receipt-hash", "sha256", "manifest", "persistent", "manual", "user-confirmed", "user-confirmed-sha256"].includes(item.match.matchKind))
      .filter((item) => {
        const key = sourceKey(item.sourceMod);
        if (thumbnailHydrationAttemptsRef.current.has(key)) return false;
        const summary = mergeSourceSummary(currentByKey.get(key), installedSummaryFromMatchMetadata(item));
        return summaryNeedsInstalledHydration(summary);
      })
      .slice(0, INSTALLED_METADATA_HYDRATION_BATCH_SIZE);
  }, [visiblePaired, renderLimit, sourceMods]);

  const installedHydrationTargetKey = installedHydrationTargets.map((item) => sourceKey(item.sourceMod)).join("|");

  useEffect(() => {
    if (!installedHydrationTargetKey || installedHydrationTargets.length === 0 || metadataHydrationBusyRef.current) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        metadataHydrationBusyRef.current = true;
        setMetadataHydrationStatus({
          checked: installedHydrationTargets.length,
          hydratedCount: 0,
          missingCount: installedHydrationTargets.length,
          thumbnailSource: "live detail pending",
          metadataSource: "live detail pending",
          missingReason: "Hydrating installed cards in the background.",
          running: true,
        });

        const existingByKey = new Map(sourceMods.map((mod) => [sourceKey(mod), mod]));
        const repaired: SourceModSummary[] = [];
        const failures: string[] = [];
        let hydratedCount = 0;
        let missingCount = 0;
        let thumbnailSource = "fallback";
        let metadataSource = "live detail";
        let missingReason = "Metadata complete.";
        let cursor = 0;

        async function hydrateOne(item: PairedInstalledMod) {
          const key = sourceKey(item.sourceMod);
          thumbnailHydrationAttemptsRef.current.add(key);

          try {
            const detail = item.sourceMod.source === "nexus"
              ? await invoke<SourceModDetail>("fetch_nexus_mod_detail", { modId: item.sourceMod.sourceId, profileId, gameDomain: nexusGameDomain })
              : await invoke<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: item.sourceMod.sourceId, profileId });

            if (cancelled) return;

            const summary = sourceSummaryFromDetail(detail);
            const existing = existingByKey.get(key);
            const merged = mergeSourceSummary(existing, summary);
            const improved = summaryAddsHydrationValue(existing, summary);

            if (improved) {
              repaired.push(summary);
              hydratedCount += 1;
            }

            if (sourceImageUrl(summary)) thumbnailSource = "live detail";
            if (metadataAuthorAvailable(summary.author) || summary.pageUrl) metadataSource = "live detail";

            if (summaryNeedsInstalledHydration(merged)) {
              missingCount += 1;
              missingReason = installedHydrationMissingReason(merged);
            }
          } catch (error) {
            failures.push(`${item.sourceMod.source}:${item.sourceMod.sourceId}`);
            missingCount += 1;
            missingReason = error instanceof Error ? error.message : String(error);
          }
        }

        async function worker() {
          while (!cancelled) {
            const item = installedHydrationTargets[cursor];
            cursor += 1;
            if (!item) return;
            await hydrateOne(item);
            await yieldToUi(40);
          }
        }

        try {
          await Promise.all(Array.from({ length: Math.min(INSTALLED_METADATA_HYDRATION_CONCURRENCY, installedHydrationTargets.length) }, worker));

          if (!cancelled && repaired.length > 0) {
            mergeSourceCards(repaired);
          }

          if (!cancelled) {
            setMetadataHydrationStatus({
              checked: installedHydrationTargets.length,
              hydratedCount,
              missingCount,
              thumbnailSource,
              metadataSource,
              missingReason: missingCount > 0 ? missingReason : "Metadata complete.",
              running: false,
            });
            recordRuntimeDiagnostic("Installed metadata hydration", failures.length > 0 ? "warning" : "completed", missingCount > 0 ? missingReason : "Installed card metadata hydrated.", [
              `checked=${installedHydrationTargets.length}`,
              `hydrated=${hydratedCount}`,
              `missing=${missingCount}`,
              `thumbnailSource=${thumbnailSource}`,
              `metadataSource=${metadataSource}`,
              failures.length > 0 ? `failed=${failures.slice(0, 8).join(", ")}` : "failed=0",
            ]);
          }
        } finally {
          metadataHydrationBusyRef.current = false;
        }
      })();
    }, 900);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [installedHydrationTargetKey]);


  async function checkStateFirstUpdates() {
    if (updatesBusy) return;
    setUpdatesBusy(true);
    setStatus("Checking updates for Tsuki-downloaded receipt mods only...");
    reportTaskProgress("Check Updates", 12, "Checking receipt-backed source files...");
    try {
      const updates = await invoke<SourceUpdateStatus[]>("check_installed_source_updates", { profileId });
      writeReceiptUpdateCheckCache(profileId, updates, "manual");
      setReceiptUpdateCache(readReceiptUpdateCheckCache(profileId));
      setSourceUpdates(updates);
      const count = updates.filter((update) => update.updateAvailable).length;
      setStatus(`Receipt update check complete: ${count}/${updates.length} Tsuki-downloaded mod(s) have updates.`);
      reportTaskProgress("Check Updates", 100, `${count}/${updates.length} update(s) found.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      reportTaskProgress("Refresh failed", 100, message);
    } finally {
      setUpdatesBusy(false);
      clearTaskProgressSoon();
    }
  }

  async function refreshUpdateStateAfterMutation(source: string, sourceId: string) {
    try {
      const updates = await invoke<SourceUpdateStatus[]>("check_installed_source_updates", { profileId });
      writeReceiptUpdateCheckCache(profileId, updates, "manual");
      setReceiptUpdateCache(readReceiptUpdateCheckCache(profileId));
      setSourceUpdates(updates);

      const current = updates.find((update) => update.source === source && update.modId === sourceId);
      if (!current?.updateAvailable) {
        setMatches((existing) => {
          const key = `${source}-${sourceId}`;
          const match = existing[key];
          if (!match) return existing;
          return {
            ...existing,
            [key]: {
              ...match,
              updateAvailable: false,
            },
          };
        });
      }
    } catch (error) {
      setStatus(error instanceof Error ? `Updated, but refresh failed: ${error.message}` : `Updated, but refresh failed: ${String(error)}`);
    }
  }

  async function refreshRuntimeLock() {
    try {
      if (profileId !== "builtin.payday3") {
        const lock: RuntimeLockStatus = {
          payday3Running: false,
          vanillaSessionActive: false,
          toggleLocked: false,
          message: `${gameName} is not using the PAYDAY 3 runtime lock.`,
        };
        setRuntimeLock(lock);
        return lock;
      }

      const lock = await invoke<RuntimeLockStatus>("payday3_runtime_lock_status");
      setRuntimeLock(lock);
      return lock;
    } catch {
      setRuntimeLock(null);
      return null;
    }
  }
  async function ensureRuntimeMutationAllowed() {
    const lock = await refreshRuntimeLock();
    if (lock?.toggleLocked) {
      setStatus(lock.message);
      return false;
    }
    return true;
  }

  async function refreshInstalled(clearWhenDone = true): Promise<PakModFile[]> {
    if (!runtimeReady) {
      setStatus(profileSwitching ? "Switching profile..." : "Profile runtime is not ready yet.");
      return [];
    }

    if (installedRefreshBusyRef.current) {
      setStatus("Installed refresh is already running.");
      return rawFiles;
    }

    installedRefreshBusyRef.current = true;
    clearInstalledSessionCache(profileId);
    void refreshRuntimeLock();
    setStatus("Scanning installed pak files...");
    reportTaskProgress("Scan Installed", 12, "Scanning installed files...");
    let loaded = false;

    try {
      const prunePromise = invoke<string>("prune_stale_install_receipts", { profileId }).catch(() => "");
      const [scan, nextInstalledState] = await Promise.all([
        invoke<PakScanResult>("scan_pak_mods", { profileId }),
        invoke<InstalledStateRecord[]>("list_installed_state_records", { profileId }),
      ]);
      if (!installedPageActiveRef.current) return [];
      reportTaskProgress("Scan Installed", 45, `Found ${scan.foundMods || scan.pakFileCount} mod group(s). Hash ${scan.exactHashMatches}, receipts ${scan.receiptMatches}, unknown ${scan.unknownMods}.`);

      const pairState = loadPairState(profileId, scan.pakMods);
      const cache = loadSourceModsFromCache(profileId);
      reportTaskProgress("Scan Installed", 72, "Loading source/state records...");
      const sourceMap = new Map<string, SourceModSummary>();

      // State-first: Tsuki-installed mods come from receipts/installed-state first.
      // Browse/source caches are only extra context, not the identity source of truth.
      const receiptMatches: Record<string, InstalledSourceMatch> = {};
      const sourceIndexMatches: Record<string, InstalledSourceMatch> = {};

      setInstalledState(nextInstalledState);

      for (const record of nextInstalledState) {
        if (!(record.files ?? []).some((file) => file.live)) continue;
        const summary = sourceSummaryFromInstalledState(record);
        if (summary) {
          sourceMap.set(sourceKey(summary), summary);
          const receiptMatch = receiptMatchFromInstalledState(record);
          if (receiptMatch) receiptMatches[sourceKey(summary)] = receiptMatch;
        }
      }

      // Show disk-validated receipts immediately; exact source identification can finish later.
      setScanResult(scan);
      setSourceMods([...sourceMap.values()]);
      setMatches(receiptMatches);
      reportTaskProgress("Scan Installed", 78, "Installed files loaded. Identifying indexed files...");
      const sourceIndexIdentities = await invoke<InstalledSourceIndexIdentity[]>("match_installed_source_index_v2", { profileId });
      if (!installedPageActiveRef.current) return [];

      for (const identity of sourceIndexIdentities) {
        if (!identity?.sourceMod || !identity.matchInfo) continue;
        sourceMap.set(sourceKey(identity.sourceMod), identity.sourceMod);
        sourceIndexMatches[sourceKey(identity.sourceMod)] = identity.matchInfo;
      }

      const liveReceiptIds = new Set(nextInstalledState.filter((record) => (record.files ?? []).some((file) => file.live)).flatMap((record) => [record.receiptId, record.uid]).filter((value): value is string => Boolean(value)));
      const liveFileKeys = fileKeySetForPakFiles(scan.pakMods);
      const cachedMatches = pairState
        ? Object.fromEntries(Object.entries(pairState.matches).filter(([key, match]) => {
            if (receiptMatches[key] || sourceIndexMatches[key]) return true;
            if (match.receiptId && !liveReceiptIds.has(match.receiptId)) return false;
            if (match.missing || match.broken) return Boolean(match.receiptId && liveReceiptIds.has(match.receiptId));
            if (!match.installed) return true;
            return (match.matchedFiles ?? []).some((fileName) => fileNameKeys(fileName).some((fileKey) => liveFileKeys.has(fileKey)));
          })) as Record<string, InstalledSourceMatch>
        : {};

      const installedSourceKeys = new Set([
        ...Object.keys(receiptMatches),
        ...Object.keys(sourceIndexMatches),
        ...Object.entries(cachedMatches).filter(([, match]) => match.installed).map(([key]) => key),
      ]);
      for (const mod of cache.mods.filter((mod) => installedSourceKeys.has(sourceKey(mod)))) {
        sourceMap.set(sourceKey(mod), mergeSourceSummary(sourceMap.get(sourceKey(mod)), mod));
      }

      if (pairState?.sourceMods?.length) {
        for (const mod of pairState.sourceMods.filter((mod) => installedSourceKeys.has(sourceKey(mod)))) {
          sourceMap.set(sourceKey(mod), mergeSourceSummary(sourceMap.get(sourceKey(mod)), mod));
        }
      }

      const indexedSources = filterProfileSourceMods(profileId, [...sourceMap.values()]);

      if (pairState) {
        const hydratedSources = indexedSources;

        const mergedReceiptFirst = { ...cachedMatches, ...sourceIndexMatches, ...receiptMatches };
        setScanResult(scan);
        setSourceMods(hydratedSources);
        setMatches(mergedReceiptFirst);
        setSourceCacheAge(cacheAge(pairState.savedAt));
        setSourceCacheBuckets(cache.cacheBuckets + 1);
        setPairingStatus(`Loaded cached pair state from ${cacheAge(pairState.savedAt)} ago, applied ${Object.values(sourceIndexMatches).length} Source Index identity match(es), and anchored ${Object.values(receiptMatches).length} Tsuki receipt/state pair(s).`);
      } else if (indexedSources.length > 0) {
        setScanResult(scan);
        setSourceMods(filterProfileSourceMods(profileId, indexedSources));
        setMatches({ ...sourceIndexMatches, ...receiptMatches });
        setSourceCacheAge(cacheAge(cache.newestCache));
        setSourceCacheBuckets(cache.cacheBuckets + (sourceIndexIdentities.length > 0 ? 1 : 0));
        setPairingStatus(`Loaded ${indexedSources.length} source/state records, applied ${Object.values(sourceIndexMatches).length} Source Index identity match(es), and anchored ${Object.values(receiptMatches).length} Tsuki receipt/state pair(s).`);
      } else {
        setScanResult(scan);
        setPairingStatus("No source cache found yet. Browse mods first, or use Auto Pair manually.");
      }

      await prunePromise;
      reportTaskProgress("Scan Installed", 100, "Installed library loaded.");
      setStatus(`Found ${scan.pakFileCount} pak-related files across ${scan.foundMods || scan.pakFileCount} group(s). Receipt Matches: ${scan.receiptMatches}. Exact Hash Matches: ${scan.exactHashMatches}. Unknown Mods: ${scan.unknownMods}. UI loaded without background pairing.`);
      loaded = true;
      return scan.pakMods;
    } catch (error) {
      if (!installedPageActiveRef.current) return [];
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      reportTaskProgress("Refresh failed", 100, message);
      return rawFiles;
    } finally {
      installedRefreshBusyRef.current = false;
      if (clearWhenDone && installedPageActiveRef.current) {
        if (loaded) finishTaskProgress("Scan Installed", "Installed library loaded.");
        else clearTaskProgressSoon(1200);
      }
    }
  }

  async function runPairing(nextSourceMods: SourceModSummary[], filesForStatus = rawFiles): Promise<Record<string, InstalledSourceMatch>> {
    if (pairingBusyRef.current) {
      setPairingStatus("Pairing is already running. Skipped duplicate request.");
      return matches;
    }

    pairingBusyRef.current = true;

    const cachedPairState = loadPairState(profileId, filesForStatus);

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

    const cappedSourceMods = nextSourceMods;

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
        profileId,
      });

      reportTaskProgress("Pair Installed", 62, "Running direct local filename proof pass...");
      const directResult = directPairMatchesFromGroups(cappedSourceMods, groups, matches, "all");
      const combinedResult = [...result, ...directResult];
      const cleanedExisting = pruneNumericMismatchPairMatches(cappedSourceMods, matches);

      const { next, keptExisting } = mergePairResultsSafely(cleanedExisting.next, combinedResult);

      reportTaskProgress("Pair Installed", 78, "Saving matched pair state...");
      setMatches(next);
      savePairState(profileId, cappedSourceMods, next, filesForStatus);
      saveInstalledEnrichedSourceCache(profileId, cappedSourceMods);

      const installed = Object.values(next).filter((match) => match.installed).length;
      const updates = Object.values(next).filter((match) => match.updateAvailable).length;
      const report = pairingReportText(combinedResult, groups.length || filesForStatus.length);

      reportTaskProgress("Pair Installed", 100, `Paired ${installed} source card(s).`);
      setPairingStatus(`${report} Proof-paired ${installed}/${cappedSourceMods.length} source cards. Direct local proof added ${directResult.length} source pair(s). Removed ${cleanedExisting.removed} numeric mismatch pair(s). ${updates} possible updates. Preserved ${keptExisting} proven old pair(s).`);
      pairingBusyRef.current = false;
      clearTaskProgressSoon();
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportTaskProgress("Pairing failed", 100, message);
      setPairingStatus(message);
      return {};
    } finally {
      pairingBusyRef.current = false;
      clearTaskProgressSoon();
    }
  }

  function repairPairingCache() {
    try {
      removeLocalStorageKeys(PAIR_REPAIR_CACHE_KEYS.map((key) => profileLocalStorageKey(key, profileId)));
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
    setPairingStatus("Sync Installed: scan files -> repair receipts -> refresh cards.");
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
    if (pairingBusyRef.current || pairingLoadBusyRef.current) {
      setPairingStatus("Pairing is already running. Skipped duplicate request.");
      return;
    }

    pairingLoadBusyRef.current = true;
    reportTaskProgress("Pair Installed", 12, "Loading source index, cache, and state records...");
    try {
      const cache = loadSourceModsFromCache(profileId);
      const pairState = loadPairState(profileId, filesForStatus);
      const [backendIndex, nextInstalledState] = await Promise.all([
        invoke<SourceModSummary[]>("list_source_index", { source: null, limit: 100000, profileId }).catch(() => []),
        invoke<InstalledStateRecord[]>("list_installed_state_records", { profileId }).catch(() => []),
      ]);
      const sourceMap = new Map<string, SourceModSummary>();

      setInstalledState(nextInstalledState);

      for (const record of nextInstalledState) {
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

      const nextMods = filterProfileSourceMods(profileId, [...sourceMap.values()]);
      setSourceMods(nextMods);
      setSourceCacheAge(cacheAge(Math.max(cache.newestCache, pairState?.savedAt ?? 0)));
      setSourceCacheBuckets(cache.cacheBuckets + (pairState ? 1 : 0) + (backendIndex.length > 0 ? 1 : 0));

      reportTaskProgress("Pair Installed", 25, `Loaded ${nextMods.length} source card(s).`);
      await runPairing(nextMods, filesForStatus);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPairingStatus(message);
      reportTaskProgress("Pairing failed", 100, message);
      clearTaskProgressSoon();
    } finally {
      pairingLoadBusyRef.current = false;
    }
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
      const cache = loadSourceModsFromCache(profileId);
      const pairState = loadPairState(profileId, files);
      const [backendIndex, nextInstalledState] = await Promise.all([
        invoke<SourceModSummary[]>("list_source_index", { source, limit: 100000, profileId }).catch(() => []),
        invoke<InstalledStateRecord[]>("list_installed_state_records", { profileId }).catch(() => []),
      ]);

      const sourceMap = new Map<string, SourceModSummary>();

      setInstalledState(nextInstalledState);

      for (const record of nextInstalledState) {
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

      const sourceOnly = filterProfileSourceMods(profileId, [...sourceMap.values()]).filter((mod) => mod.source === source);
      const mergedSources = filterProfileSourceMods(profileId, [...sourceMods, ...sourceOnly]);
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
        sourceMods: sourceOnly,
        profileId,
      });

      reportTaskProgress(`Pair ${label}`, 70, "Running direct local filename proof pass...");
      const directResult = directPairMatchesFromGroups(sourceOnly, groups, matches, source);
      const combinedResult = [...result, ...directResult];
      const cleanedExisting = pruneNumericMismatchPairMatches(sourceOnly, matches);

      reportTaskProgress(`Pair ${label}`, 84, "Merging pair results...");
      const { next: nextMatches, keptExisting } = mergePairResultsSafely(cleanedExisting.next, combinedResult);

      setMatches(nextMatches);
      savePairState(profileId, dedupedSources, nextMatches, files);
      saveInstalledEnrichedSourceCache(profileId, dedupedSources);

      const paired = result.filter((match) => match.installed).length;
      const candidates = result.filter((match) => !match.installed && match.confidence >= 60).length;
      const report = pairingReportText(combinedResult, groups.length || files.length);
      reportTaskProgress(`Pair ${label}`, 100, `Paired ${paired}/${result.length}.`);
      setPairingStatus(`${report} Pair ${label} complete: paired ${paired}/${combinedResult.length}. Direct local proof added ${directResult.length} source pair(s). Removed ${cleanedExisting.removed} numeric mismatch pair(s). Live searched ${liveStats.checked} file group(s), found ${liveStats.foundById + liveStats.foundBySearch} source hit(s). Preserved ${keptExisting} proven old pair(s). ${candidates} manual candidate(s) stayed unpaired.`);
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
      void invoke<string>("diagnose_modworkshop_pairing").catch(() => "");
    } catch (error) {
      setPairingStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
      clearTaskProgressSoon();
    }
  }






  async function fetchSourceDetailForSummary(sourceMod: SourceModSummary) {
    if ((sourceMod.source as string) === "local") {
      return {
        ...sourceMod,
        description: sourceMod.shortDescription ?? "Managed local mod. No live source page is paired yet.",
        changelog: null,
        files: [],
        images: [],
        comments: [],
        bugs: [],
        logs: ["Managed Unknown Mod"],
        stats: [{ label: "Match", value: "Unknown Mod" }],
      };
    }

    const detail =
      sourceMod.source === "nexus"
        ? await invoke<SourceModDetail>("fetch_nexus_mod_detail", { modId: sourceMod.sourceId, profileId, gameDomain: nexusGameDomain })
        : await invoke<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: sourceMod.sourceId, profileId });

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
    const groupFiles = new Set(group.files.flatMap((file) => fileNameKeys(file.fileName)));

    return matched
      .filter((match) => match.installed && match.confidence >= 86)
      .filter((match) => candidateKeys.has(`${match.source}-${match.sourceId}`))
      .filter((match) => match.matchedFiles.some((fileName) => fileNameKeys(fileName).some((key) => groupFiles.has(key))))
      .sort((a, b) => b.confidence - a.confidence)
      [0] ?? null;
  }

  async function searchGroupIntoSourceMap(group: InstalledGroup, sourceMap: Map<string, SourceModSummary>, sourceFilter: ModSourceKind | "all" = "all") {
    let foundById = 0;
    let foundBySearch = 0;
    let failed = 0;

    try {
      const indexed = filterProfileSourceMods(profileId, await invoke<SourceModSummary[]>("list_source_index", { source: sourceFilter === "all" ? null : sourceFilter, limit: 100000, profileId }));
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
        const detail = await invoke<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: id, profileId });
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

      if (hasModWorkshopSource && sourceFilter !== "nexus") {
        try {
          const results = filterProfileSourceMods(profileId, await invoke<SourceModSummary[]>("search_modworkshop_mods_for_query", { query, profileId, gameId: modWorkshopGameKey }));

          for (const result of results.slice(0, 25)) {
            sourceMap.set(sourceKey(result), result);
          }

          queryFound += results.length;
        } catch {
          failed += 1;
        }

        await yieldToUi();
      }

      if (hasNexusSource && sourceFilter !== "modworkshop") {
        try {
          const nexusResults = filterProfileSourceMods(profileId, await invoke<SourceModSummary[]>("search_nexus_mods_for_query", { query, profileId }));

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
        const nextMods = filterProfileSourceMods(profileId, [...sourceMap.values()]);
        setSourceMods(nextMods);
        saveInstalledEnrichedSourceCache(profileId, nextMods);
        await yieldToUi(35);
      }
    }

    return { checked: targets.length, foundById, foundBySearch, failed };
  }



  async function enrichUnmatchedFromFilenames() {
    const sourceMap = new Map(filterProfileSourceMods(profileId, sourceMods).map((mod) => [sourceKey(mod), mod]));
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
        saveInstalledEnrichedSourceCache(profileId, nextMods);

        if ((index + 1) % 2 === 0 || index === targetGroups.length - 1) {
          await runPairing(nextMods, rawFiles);
          await yieldToUi(50);
        }
      }

      const skipped = [...newlyUnpairable];
      setUnpairableGroups(skipped);
      saveUnpairableGroups(profileId, skipped);

      const nextMods = [...sourceMap.values()];
      setSourceMods(nextMods);
      saveInstalledEnrichedSourceCache(profileId, nextMods);
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
    saveStringList(profileLocalStorageKey(CUSTOM_GROUPS_KEY, profileId), nextCustom);
    setUnpairableGroups(nextSkipped);
    saveUnpairableGroups(profileId, nextSkipped);
    setStatus(`${group.label} marked as Custom/Local. It will not auto-pair.`);
  }

  function clearPairingGuards() {
    setRejectedPairings([]);
    setCustomGroups([]);
    saveStringList(profileLocalStorageKey(REJECTED_PAIRINGS_KEY, profileId), []);
    saveStringList(profileLocalStorageKey(CUSTOM_GROUPS_KEY, profileId), []);
    setStatus("Cleared rejected pairings and custom/local marks.");
  }

  async function buildNexusIndex() {
    if (profileId !== "builtin.payday3") {
      setPairingStatus("The legacy Nexus PAYDAY 3 index builder is only available for the built-in PAYDAY 3 profile.");
      return;
    }

    setNexusIndexing(true);
    setBusyKey("nexus-index");
    reportTaskProgress("Rebuild Nexus", 8, "Loading ordered Nexus feeds...");
    setPairingStatus("Rebuilding Nexus cache from GraphQL/ordered Nexus feeds. No raw ID sweep.");

    try {
      const nexusMods = await invoke<SourceModSummary[]>("build_nexus_payday3_index", { maxId: 0 });
      reportTaskProgress("Rebuild Nexus", 72, `Loaded ${nexusMods.length} cards; merging cache...`);
      const sourceMap = new Map(filterProfileSourceMods(profileId, sourceMods).map((mod) => [sourceKey(mod), mod]));

      for (const mod of nexusMods) {
        sourceMap.set(sourceKey(mod), mod);
      }

      const nextMods = [...sourceMap.values()];
      setSourceMods(nextMods);
      saveInstalledEnrichedSourceCache(profileId, nextMods);
      setSourceCacheAge("just now");
      setSourceCacheBuckets((current) => Math.max(current, 1));

      savePairState(profileId, nextMods, matches, rawFiles);

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
    savePairState(profileId, sourceMods, next, rawFiles);
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
      saveUnpairableGroups(profileId, skipped);
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
        profileId,
      });

      const nextMatches = mergeMatchArray(result);
      const pairedNow = groupIsPairedByMatches(group, nextMatches, candidates);

      if (pairedNow) {
        const skipped = unpairableGroups.filter((key) => key !== group.key);
        setUnpairableGroups(skipped);
        saveUnpairableGroups(profileId, skipped);
        setAutoPairStatus(`${reason}: paired ${group.label} from cache.`);
      } else {
        const skipped = [...new Set([...unpairableGroups, group.key])];
        setUnpairableGroups(skipped);
        saveUnpairableGroups(profileId, skipped);
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
    const sourceMap = new Map(filterProfileSourceMods(profileId, sourceMods).map((mod) => [sourceKey(mod), mod]));
    const withoutCurrentSkip = unpairableGroups.filter((key) => key !== group.key);
    setUnpairableGroups(withoutCurrentSkip);
    saveUnpairableGroups(profileId, withoutCurrentSkip);
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
      saveInstalledEnrichedSourceCache(profileId, enrichedMods);

      if (enrichedCandidates.length === 0 && result.found === 0) {
        const skipped = [...new Set([...unpairableGroups, group.key])];
        setUnpairableGroups(skipped);
        saveUnpairableGroups(profileId, skipped);
        setPairingStatus(`${group.label}: no source candidates found. Saved as skipped.`);
        return;
      }

      reportTaskProgress("Reinstall from Tsuki", 38, "Running proof matcher...");
      reportTaskProgress("Try Pair", 72, "Matching local file proof...");
      const matched = await invoke<InstalledSourceMatch[]>("match_installed_source_mods", {
        sourceMods: enrichedCandidates.length > 0 ? enrichedCandidates : enrichedMods.slice(0, 30),
        profileId,
      });
      const nextMatches = mergeMatchArray(matched);
      const pairedNow = Boolean(bestProofMatchForGroup(group, matched, enrichedCandidates)) || groupIsPairedByMatches(group, nextMatches, enrichedCandidates.length > 0 ? enrichedCandidates : enrichedMods);

      if (pairedNow) {
        const skipped = unpairableGroups.filter((key) => key !== group.key);
        setUnpairableGroups(skipped);
        saveUnpairableGroups(profileId, skipped);
        setPairingStatus(`${group.label}: paired from selected Try Pair.`);
      } else {
        const skipped = [...new Set([...unpairableGroups, group.key])];
        setUnpairableGroups(skipped);
        saveUnpairableGroups(profileId, skipped);
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
    const sourceMap = new Map(filterProfileSourceMods(profileId, sourceMods).map((mod) => [sourceKey(mod), mod]));
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
        profileId,
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
      const sourceMatch = matches[sourceKey(sourceMod)] ?? proof ?? null;
      const files = installableSourceFiles(detail.files);

      if (files.length === 0) {
        setPairingStatus(`${detail.name}: no installable source files exposed. Open the mod page in Browse and choose manually.`);
        recordRuntimeDiagnostic("Reinstall from Tsuki", "blocked", "Source detail exposed no installable files.", [detail.name, `${detail.source}:${detail.sourceId}`]);
        return;
      }

      const selected = bestReinstallFileForGroup(detail.files, group, sourceMatch);
      const pickerFiles = reinstallPickerFiles(detail);
      if (!selected.file) {
        const mainFallback = pickerFiles.find((item) => item.bucket === "main")?.file ?? null;
        if (pickerFiles.length > 1 && mainFallback) {
          setReinstallPicker({
            detail,
            group,
            sourceMatch,
            recommendedFileId: mainFallback.id,
            recommendedReason: `${selected.reason} Latest Main file is the safest manual choice.`,
            replaceFileNames,
            candidatePool,
          });
          setReinstallPickerSelectedIds([mainFallback.id]);
          setPairingStatus(`${detail.name}: original file no longer exists. Choose a file manually; Tsuki marked the latest Main file as recommended.`);
          return;
        }

        const message = "Original file no longer exists. Manual selection required.";
        setPairingStatus(`${detail.name}: ${message}`);
        recordRuntimeDiagnostic("Reinstall from Tsuki", "blocked", selected.reason, [
          detail.name,
          `${detail.source}:${detail.sourceId}`,
          `Installed files: ${replaceFileNames.join(", ")}`,
          `Available files: ${files.map((candidate) => `${candidate.id}:${candidate.name}`).slice(0, 12).join(" | ")}`,
        ]);
        return;
      }

      if (pickerFiles.length > 1) {
        setReinstallPicker({
          detail,
          group,
          sourceMatch,
          recommendedFileId: selected.file.id,
          recommendedReason: selected.reason,
          replaceFileNames,
          candidatePool,
        });
        setReinstallPickerSelectedIds([selected.file.id]);
        setPairingStatus(`${detail.name}: choose exactly which file(s) to reinstall. Recommended: ${selected.file.name}.`);
        return;
      }

      const file = selected.file;

      reportTaskProgress("Reinstall from Tsuki", 58, `Downloading ${file.name}...`);
      setPairingStatus(`Reinstall from Tsuki: downloading ${detail.name} / ${file.name} (${selected.reason})...`);
      reportTaskProgress("Reinstall from Tsuki", 82, "Replacing files and writing receipt...");
      setPairingStatus(`Reinstall from Tsuki: replacing local files and writing receipt...`);
      const directPicker: ReinstallPickerState = {
        detail,
        group,
        sourceMatch,
        recommendedFileId: file.id,
        recommendedReason: selected.reason,
        replaceFileNames,
        candidatePool,
      };
      const applied = await installReinstallFile(detail, file, replaceNamesForReinstallFile(file, directPicker), candidatePool);
      setPairingStatus(`Reinstalled ${detail.name} through Tsuki: ${applied.installedFiles.length} installed, ${applied.replacedFiles.length} replaced. It should now have a receipt/state record.`);
      setStatus(`Reinstalled ${detail.name} from ${sourceLabel(detail.source)}.`);
      reportTaskProgress("Reinstall from Tsuki", 100, `Installed ${applied.installedFiles.length} file(s).`);
      await refreshInstalled();
      await refreshUpdateStateAfterMutation(detail.source, detail.sourceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPairingStatus(`${liveFileDataUnavailableMessageForInstalled()} ${message}`);
      reportTaskProgress("Reinstall failed", 100, message);
      recordRuntimeDiagnostic("Reinstall from Tsuki", "error", "Live file data unavailable.", [group.label, message]);
    } finally {
      setBusyKey(null);
      clearTaskProgressSoon();
    }
  }

  function replaceNamesForReinstallFile(file: SourceModFile, picker: ReinstallPickerState) {
    const groups = groupedInstalledSourceFiles(picker.detail.files, picker.detail.source);
    const category = sourceFileBucket(file, groups.main[0] ?? null, picker.detail.source);
    if (category === "main") return picker.replaceFileNames;

    const matchedNames = matchedFileNamesForSourceFile(file, picker.sourceMatch);
    return matchedNames.length > 0 ? matchedNames : [];
  }

  async function installReinstallFile(
    detail: SourceModDetail,
    file: SourceModFile,
    replaceFileNames: string[],
    candidatePool: SourceModSummary[],
  ) {
    const staged = await invoke<StagedDownloadResult>("stage_source_file_download", {
      source: detail.source,
      modId: detail.sourceId,
      fileId: file.id,
      fileName: file.name,
      downloadUrl: file.downloadUrl ?? null,
      modName: detail.name,
      description: detail.description,
      gameDomain: detail.source === "nexus" ? detail.gameId ?? null : null,
      profileId,
    });

    if (!staged.canInstallLater) {
      const blocked = staged.entries
        .filter((entry) => entry.blocked)
        .map((entry) => `${entry.archivePath}: ${entry.reason}`)
        .slice(0, 12);

      recordRuntimeDiagnostic("Reinstall from Tsuki", "blocked", "Staged download had no safe installable route.", [detail.name, file.name, ...staged.warnings, ...blocked]);
      throw new Error(`${detail.name}: downloaded, but no safe installable file was found.`);
    }

    const applied = await invoke<InstallApplyResult>("install_staged_file_to_game", {
      stagedFilePath: staged.stagedFilePath,
      modName: detail.name,
      source: detail.source,
      modId: detail.sourceId,
      fileId: file.id,
      version: file.version ?? detail.version ?? null,
      sourceFileName: file.name,
      sourceFileCategory: sourceFileBucket(file, groupedInstalledSourceFiles(detail.files, detail.source).main[0] ?? null, detail.source),
      sourceFileUploadedAt: file.uploadedAt ?? null,
      sourceFileVersion: file.version ?? detail.version ?? null,
      author: detail.author ?? null,
      thumbnailUrl: detail.thumbnailUrl ?? null,
      bannerUrl: detail.bannerUrl ?? null,
      pageUrl: detail.pageUrl ?? null,
      description: detail.description,
      replaceFileNames,
      profileId,
    });

    saveInstalledEnrichedSourceCache(profileId, candidatePool);
    recordRuntimeDiagnostic("Reinstall from Tsuki", "success", "Reinstall completed and receipt/state should be available.", [detail.name, `${detail.source}:${detail.sourceId}`, file.name, `Installed: ${applied.installedFiles.length}`, `Replaced: ${applied.replacedFiles.length}`]);
    return applied;
  }

  async function installSelectedReinstallFiles() {
    if (!reinstallPicker || reinstallPickerSelectedIds.length === 0) return;
    const selected = reinstallPickerFiles(reinstallPicker.detail)
      .map((item) => item.file)
      .filter((file) => reinstallPickerSelectedIds.includes(file.id));

    if (selected.length === 0) return;

    setBusyKey(`reinstall-${reinstallPicker.group.key}`);
    setPairingStatus(`Reinstall from Tsuki: installing ${selected.length} selected file(s)...`);
    reportTaskProgress("Reinstall from Tsuki", 12, `Installing ${selected.length} selected file(s)...`);

    try {
      let installed = 0;
      let replaced = 0;
      for (const file of selected) {
        const replaceNames = replaceNamesForReinstallFile(file, reinstallPicker);
        const applied = await installReinstallFile(reinstallPicker.detail, file, replaceNames, reinstallPicker.candidatePool);
        installed += applied.installedFiles.length;
        replaced += applied.replacedFiles.length;
      }
      setPairingStatus(`Reinstalled ${reinstallPicker.detail.name}: ${installed} installed, ${replaced} replaced.`);
      setStatus(`Reinstalled ${selected.length} selected file(s) from ${sourceLabel(reinstallPicker.detail.source)}.`);
      reportTaskProgress("Reinstall from Tsuki", 100, `Installed ${installed} file(s), replaced ${replaced}.`);
      setReinstallPicker(null);
      setReinstallPickerSelectedIds([]);
      await refreshInstalled();
      await refreshUpdateStateAfterMutation(reinstallPicker.detail.source, reinstallPicker.detail.sourceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPairingStatus(message);
      reportTaskProgress("Reinstall failed", 100, message);
    } finally {
      setBusyKey(null);
      clearTaskProgressSoon();
    }
  }


  function clearUnpairableGroups() {
    setUnpairableGroups([]);
    saveUnpairableGroups(profileId, []);
    setPairingStatus("Cleared skipped/unpairable groups. Light Auto Pair and selected Try Pair can retry them.");
  }

  function patchPakFilesEnabled(fileNames: string[], enabled: boolean) {
    const requested = new Set(fileNames.flatMap(fileNameKeys));

    setScanResult((current) => {
      if (!current) return current;

      const pakMods = current.pakMods.map((file) => {
        const matchesSelection =
          fileNameKeys(file.fileName).some((key) => requested.has(key))
          || fileNameKeys(file.fullPath).some((key) => requested.has(key));

        if (!matchesSelection) return file;

        const cleanName = enabledFileName(file.fileName);
        return {
          ...file,
          enabled,
          fileName: enabled ? cleanName : `${cleanName}.disabled`,
        };
      });

      return {
        ...current,
        pakMods,
        pakFileCount: pakMods.length,
      };
    });

    setMatches((current) => Object.fromEntries(
      Object.entries(current).map(([key, match]) => {
        const touchesMatch = match.matchedFiles.some((fileName) => fileNameKeys(fileName).some((fileKey) => requested.has(fileKey)));
        return [key, touchesMatch ? { ...match, enabled } : match];
      }),
    ) as Record<string, InstalledSourceMatch>);

    setSelectedSourceMatch((current) => {
      if (!current) return current;
      const touchesMatch = current.matchedFiles.some((fileName) => fileNameKeys(fileName).some((fileKey) => requested.has(fileKey)));
      return touchesMatch ? { ...current, enabled } : current;
    });
  }

  function patchSourceInstallEnabled(match: InstalledSourceMatch, enabled: boolean) {
    const key = `${match.source}-${match.sourceId}`;

    setMatches((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? match),
        enabled,
      },
    }));

    setSelectedSourceMatch((current) => {
      if (!current || current.source !== match.source || current.sourceId !== match.sourceId) return current;
      return { ...current, enabled };
    });
  }

  function parsedPakToggleCount(result: string) {
    const match = result.match(/\b(?:Enabled|Disabled)\s+(\d+)\s+PAK-family file/i);
    return match ? Number(match[1]) : null;
  }

  async function setGroupEnabled(group: InstalledGroup, enabled: boolean) {
    if (!(await ensureRuntimeMutationAllowed())) return;

    setBusyKey(group.key);

    try {
      const win64 = groupLooksWin64OrUe4ss(group);
      const fileNames = group.files.map((file) => file.fileName);
      const filePaths = [...new Set(group.files.flatMap((file) => [file.fullPath, file.fileName]).filter((value): value is string => Boolean(value && value.trim().length > 0)))];
      const result = win64
        ? await invoke<string>("set_local_win64_matched_files_enabled", { filePaths, enabled, profileId })
        : await invoke<string>("set_pak_mod_files_enabled", { fileNames, enabled, profileId });

      setStatus(result);
      const changedCount = win64 ? group.files.length : parsedPakToggleCount(result);
      if (changedCount === null || changedCount >= group.files.length) {
        patchPakFilesEnabled(win64 ? filePaths : fileNames, enabled);
        setPairingStatus(`${group.label} is now ${enabled ? "On" : "Off"}. Updated the visible row without a full rescan.`);
      } else {
        setPairingStatus(`${group.label} partially toggled; refreshing once to reconcile skipped files.`);
        await refreshInstalled(false);
      }
      window.dispatchEvent(new Event("tsuki-data-refresh"));
    } catch (error) {
      setStatus(`${liveFileDataUnavailableMessageForInstalled()} ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusyKey(null);
    }
  }

  async function uninstallFileNames(fileNames: string[], busyId: string) {
    if (!(await ensureRuntimeMutationAllowed())) return;

    if (fileNames.length === 0) {
      setStatus("No files were selected for uninstall.");
      return;
    }

    setBusyKey(busyId);

    try {
      const result = await invoke<string>("uninstall_pak_mod_files", {
        fileNames,
        profileId,
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
    if (!(await ensureRuntimeMutationAllowed())) return;

    setBusyKey(`receipt-toggle-${match.source}-${match.sourceId}`);

    try {
      const result = await invoke<string>("set_source_install_enabled", {
        source: match.source,
        sourceId: match.sourceId,
        enabled,
        profileId,
      });

      setStatus(result);
      patchSourceInstallEnabled(match, enabled);
      setPairingStatus(`${sourceLabel(match.source)} install ${match.sourceId} is now ${enabled ? "On" : "Off"}. Updated receipt state without a full rescan.`);
      window.dispatchEvent(new Event("tsuki-data-refresh"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function setMatchedLocalFilesEnabled(item: PairedInstalledMod, enabled: boolean) {
    if (!(await ensureRuntimeMutationAllowed())) return;

    const busyId = `local-toggle-${item.match.source}-${item.match.sourceId}`;
    setBusyKey(busyId);

    try {
      const win64 = installedSurfaceLabel(item) === "Win64/UE4SS";
      const groupedPaths = item.files.flatMap((file) => [file.fullPath, file.fileName]);
      const groupedFileNames = item.files.map((file) => file.fileName);
      const rawTogglePaths = [...new Set([...(win64 ? groupedPaths : groupedFileNames), ...item.match.matchedFiles]
        .filter((value): value is string => Boolean(value && value.trim().length > 0)))];
      const togglePaths = win64 ? rawTogglePaths : rawTogglePaths.map(fileNameKey).filter(Boolean);

      const result = win64
        ? await invoke<string>("set_local_win64_matched_files_enabled", {
            filePaths: togglePaths,
            enabled,
            profileId,
          })
        : await invoke<string>("set_pak_mod_files_enabled", {
            fileNames: togglePaths,
            enabled,
            profileId,
          });

      setStatus(result);
      patchPakFilesEnabled(togglePaths, enabled);
      patchSourceInstallEnabled({ ...item.match, matchedFiles: togglePaths }, enabled);
      window.dispatchEvent(new Event("tsuki-data-refresh"));

      if (toggleResultNeedsRefresh(result, togglePaths.length)) {
        setPairingStatus(`${displayModTitle(item.sourceMod)} toggled with skipped files; refreshing only this reconciliation pass.`);
        await refreshInstalled(false);
      } else {
        setPairingStatus(`${displayModTitle(item.sourceMod)} is now ${enabled ? "On" : "Off"}. Updated the visible card without a full rescan.`);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
    }
  }

  function crashCandidateTitle(key: string) {
    return crashCandidateMap.get(key)?.title ?? key.replace(/^pair:|^group:/, "");
  }

  function crashGroupSignature(keys: string[]) {
    return [...keys].sort().join("|");
  }

  function splitCrashGroup(keys: string[]) {
    if (keys.length <= 1) return keys;
    return keys.slice(0, Math.max(1, Math.ceil(keys.length / 2)));
  }

  function crashComplement(keys: string[], disabledGroup: string[]) {
    const disabled = new Set(disabledGroup);
    return keys.filter((key) => !disabled.has(key));
  }

  function chooseNextCrashGroup(suspects: string[], testedGroups: string[]) {
    const preferred = splitCrashGroup(suspects);
    if (!testedGroups.includes(crashGroupSignature(preferred))) return preferred;

    const alternate = crashComplement(suspects, preferred);
    if (alternate.length > 0 && !testedGroups.includes(crashGroupSignature(alternate))) return alternate;

    return preferred;
  }

  function toggleResultChangedCount(result: string) {
    const counts = [
      ...Array.from(result.matchAll(/\b(?:Enabled|Disabled|Restored|Moved)\s+(\d+)\b/gi)).map((match) => Number(match[1])),
      ...Array.from(result.matchAll(/\bmoving\s+(\d+)\s+file/gi)).map((match) => Number(match[1])),
      ...Array.from(result.matchAll(/\b(\d+)\s+(?:file|files)\b/gi)).map((match) => Number(match[1])),
    ].filter((value) => Number.isFinite(value));

    return counts.length > 0 ? Math.max(...counts) : null;
  }

  function toggleResultSucceeded(result: string) {
    const count = toggleResultChangedCount(result);
    if (count !== null) return count > 0;
    if (/already\s+(?:enabled|disabled|off|on)/i.test(result)) return true;
    return !/(?:no matching|not found|0\s+(?:file|files)|failed|unable)/i.test(result);
  }

  function toggleResultNeedsRefresh(result: string, expectedCount: number) {
    const count = toggleResultChangedCount(result);
    const hasProblem = /(?:skipped|missing|refused|failed|unable|target already exists|no matching|not found)/i.test(result);
    if (count !== null && expectedCount > 0 && count < expectedCount) return true;
    return hasProblem && !(count !== null && count >= expectedCount);
  }

  function extractDisabledStoragePaths(result: string) {
    const paths = new Set<string>();
    for (const match of result.matchAll(/(?:storage at|disabled storage at|moved to)\s+([^.;\n]+)/gi)) {
      const value = match[1]?.trim();
      if (value) paths.add(value);
    }
    return [...paths];
  }

  async function setCrashCandidatesEnabledBatch(keys: string[], enabled: boolean): Promise<CrashToggleResult[]> {
    const started = performance.now();
    const uniqueKeys = [...new Set(keys)];
    const results: CrashToggleResult[] = [];
    const receiptActions: Array<{ key: string; title: string; match: InstalledSourceMatch }> = [];
    const pakFileNames = new Set<string>();
    const win64FilePaths = new Set<string>();
    const pakKeys: string[] = [];
    const win64Keys: string[] = [];
    const pakPatchMatches: InstalledSourceMatch[] = [];
    const win64PatchMatches: InstalledSourceMatch[] = [];

    const pushSkipped = (key: string, title: string, skippedReason: string) => {
      results.push({ key, title, attempted: false, success: false, skippedReason });
    };

    for (const key of uniqueKeys) {
      const candidate = crashCandidateMap.get(key);
      const title = candidate?.title ?? key.replace(/^pair:|^group:/, "");
      if (!candidate) {
        pushSkipped(key, title, "candidate not found");
        continue;
      }
      if (crashTestCancelRef.current) {
        pushSkipped(key, title, "cancelled");
        continue;
      }

      if (candidate.item) {
        const receiptBacked = isReceiptBackedInstalledItem(candidate.item);
        if (receiptBacked) {
          receiptActions.push({ key, title, match: candidate.item.match });
          continue;
        }

        if (!itemHasManageableInstalledFiles(candidate.item)) {
          pushSkipped(key, title, "no manageable files");
          continue;
        }

        const win64 = installedSurfaceLabel(candidate.item) === "Win64/UE4SS";
        const groupedPaths = candidate.item.files.flatMap((file) => [file.fullPath, file.fileName]);
        const groupedFileNames = candidate.item.files.map((file) => file.fileName);
        const toggleValues = [...new Set([...(win64 ? groupedPaths : groupedFileNames), ...candidate.item.match.matchedFiles]
          .filter((value): value is string => Boolean(value && value.trim().length > 0)))];

        if (toggleValues.length === 0) {
          pushSkipped(key, title, "no tracked file paths");
          continue;
        }

        if (win64) {
          toggleValues.forEach((value) => win64FilePaths.add(value));
          win64Keys.push(key);
          win64PatchMatches.push({ ...candidate.item.match, matchedFiles: toggleValues });
        } else {
          toggleValues.map(fileNameKey).filter(Boolean).forEach((value) => pakFileNames.add(value));
          pakKeys.push(key);
          pakPatchMatches.push({ ...candidate.item.match, matchedFiles: toggleValues.map(fileNameKey).filter(Boolean) });
        }
      } else if (candidate.group) {
        const win64 = groupLooksWin64OrUe4ss(candidate.group);
        const toggleValues = win64
          ? [...new Set(candidate.group.files.flatMap((file) => [file.fullPath, file.fileName]).filter((value): value is string => Boolean(value && value.trim().length > 0)))]
          : candidate.group.files.map((file) => file.fileName).map(fileNameKey).filter(Boolean);

        if (toggleValues.length === 0) {
          pushSkipped(key, title, "no tracked group files");
          continue;
        }

        if (win64) {
          toggleValues.forEach((value) => win64FilePaths.add(value));
          win64Keys.push(key);
        } else {
          toggleValues.forEach((value) => pakFileNames.add(value));
          pakKeys.push(key);
        }
      } else {
        pushSkipped(key, title, "candidate has no installed files");
      }
    }

    for (const action of receiptActions) {
      if (crashTestCancelRef.current) {
        pushSkipped(action.key, action.title, "cancelled");
        continue;
      }

      const actionStarted = performance.now();
      try {
        const message = await invoke<string>("set_source_install_enabled", {
          source: action.match.source,
          sourceId: action.match.sourceId,
          enabled,
          profileId,
        });
        const success = toggleResultSucceeded(message);
        if (success) patchSourceInstallEnabled(action.match, enabled);
        results.push({
          key: action.key,
          title: action.title,
          attempted: true,
          success,
          message,
          disabledStoragePaths: enabled ? [] : extractDisabledStoragePaths(message),
          batchSize: 1,
          fileCount: action.match.matchedFiles.length,
          elapsedMs: Math.round(performance.now() - actionStarted),
        });
      } catch (error) {
        results.push({
          key: action.key,
          title: action.title,
          attempted: true,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          batchSize: 1,
          fileCount: action.match.matchedFiles.length,
          elapsedMs: Math.round(performance.now() - actionStarted),
        });
      }
    }

    async function runFileBatch(command: "set_pak_mod_files_enabled" | "set_local_win64_matched_files_enabled", batchKeys: string[], values: string[], matchesToPatch: InstalledSourceMatch[]) {
      if (values.length === 0 || batchKeys.length === 0) return;
      if (crashTestCancelRef.current) {
        batchKeys.forEach((key) => pushSkipped(key, crashCandidateTitle(key), "cancelled"));
        return;
      }

      const actionStarted = performance.now();
      try {
        const message = command === "set_local_win64_matched_files_enabled"
          ? await invoke<string>(command, { filePaths: values, enabled, profileId })
          : await invoke<string>(command, { fileNames: values, enabled, profileId });
        const success = toggleResultSucceeded(message);
        const elapsedMs = Math.round(performance.now() - actionStarted);
        if (success) {
          patchPakFilesEnabled(values, enabled);
          for (const match of matchesToPatch) patchSourceInstallEnabled(match, enabled);
        }
        const disabledStoragePaths = enabled ? [] : extractDisabledStoragePaths(message);
        for (const key of batchKeys) {
          results.push({
            key,
            title: crashCandidateTitle(key),
            attempted: true,
            success,
            message,
            disabledStoragePaths,
            batchSize: batchKeys.length,
            fileCount: values.length,
            elapsedMs,
          });
        }
      } catch (error) {
        const elapsedMs = Math.round(performance.now() - actionStarted);
        const message = error instanceof Error ? error.message : String(error);
        for (const key of batchKeys) {
          results.push({
            key,
            title: crashCandidateTitle(key),
            attempted: true,
            success: false,
            error: message,
            batchSize: batchKeys.length,
            fileCount: values.length,
            elapsedMs,
          });
        }
      }
    }

    await runFileBatch("set_pak_mod_files_enabled", pakKeys, [...pakFileNames], pakPatchMatches);
    await runFileBatch("set_local_win64_matched_files_enabled", win64Keys, [...win64FilePaths], win64PatchMatches);

    const elapsedMs = Math.round(performance.now() - started);
    const attempted = results.filter((result) => result.attempted).length;
    const skipped = results.filter((result) => !result.attempted || result.skippedReason).length;
    const fileCount = pakFileNames.size + win64FilePaths.size + receiptActions.reduce((total, action) => total + action.match.matchedFiles.length, 0);
    const verb = enabled ? "enable/restore" : "disable";
    setCrashTest((current) => ({
      ...current,
      history: [...current.history, `Batch ${verb}: candidates ${uniqueKeys.length}, attempted ${attempted}, file refs ${fileCount}, skipped ${skipped}, elapsed ${elapsedMs}ms.`].slice(-12),
    }));

    return results;
  }
  function crashTestDelay(ms = 90) {
    return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  }

  async function restoreCrashTestOriginalState(state = crashTest) {
    const entries = Object.entries(state.originalEnabled);
    if (entries.length === 0) {
      setCrashTest((current) => ({ ...current, status: "No Crash Test snapshot is available to restore." }));
      return;
    }

    setCrashTestBusy(true);
    setCrashTest((current) => ({ ...current, status: "Restoring original enabled/disabled state..." }));

    try {
      crashTestCancelRef.current = false;
      const originallyEnabled = entries.filter(([, enabled]) => enabled).map(([key]) => key);
      const originallyDisabled = entries.filter(([, enabled]) => !enabled).map(([key]) => key);
      const enableResults = await setCrashCandidatesEnabledBatch(originallyEnabled, true);
      const disableResults = await setCrashCandidatesEnabledBatch(originallyDisabled, false);
      const failed = [...enableResults, ...disableResults].filter((result) => result.attempted && !result.success).length;
      const skipped = [...enableResults, ...disableResults].filter((result) => !result.attempted || result.skippedReason).length;

      setCrashTest((current) => ({
        ...current,
        active: false,
        currentGroup: [],
        status: failed > 0 || skipped > 0
          ? `Original state restore finished with ${failed} failed and ${skipped} skipped toggle(s).`
          : "Original enabled/disabled state restored.",
        history: [...current.history, `Restored original state in batch. Failed ${failed}, skipped ${skipped}.`].slice(-12),
      }));
    } finally {
      setCrashTestBusy(false);
    }
  }

  async function prepareCrashTestGroup(groupKeys: string[], baseState = crashTest) {
    if (groupKeys.length === 0) return;
    const groupSignature = crashGroupSignature(groupKeys);

    setCrashTest((current) => ({
      ...current,
      currentGroup: groupKeys,
      status: `Round ${baseState.round || 1}: disabling ${groupKeys.length} of ${baseState.testableCount || baseState.suspects.length} testable enabled mod group(s), then launching ${gameName}...`,
      disabledGroupCount: groupKeys.length,
      attemptedDisables: 0,
      successfulDisables: 0,
      failedDisables: 0,
      skippedMods: [],
      disabledStoragePaths: [],
      testedGroups: current.testedGroups.includes(groupSignature) ? current.testedGroups : [...current.testedGroups, groupSignature],
      lastResult: null,
      nextAction: "Disable this half, launch the game, then wait for your Yes/No result.",
      noProgressReason: current.testedGroups.includes(groupSignature) ? "This exact group was already tested. Choose Not sure only when you intentionally want to retry it." : null,
      history: [...current.history, `Round ${baseState.round || 1}: testing group: ${groupKeys.map(crashCandidateTitle).join(", ")}`].slice(-12),
    }));

    const originalEntries = Object.entries(baseState.originalEnabled);
    const originallyEnabledKeys = originalEntries.filter(([, enabled]) => enabled).map(([key]) => key);
    await setCrashCandidatesEnabledBatch(originallyEnabledKeys, true);
    if (crashTestCancelRef.current) return;

    const disableResults = await setCrashCandidatesEnabledBatch(groupKeys, false);

    const attempted = disableResults.filter((result) => result.attempted).length;
    const successful = disableResults.filter((result) => result.success).length;
    const failed = disableResults.filter((result) => result.attempted && !result.success).length;
    const skipped = disableResults
      .filter((result) => !result.attempted || result.skippedReason)
      .map((result) => `${result.title}: ${result.skippedReason ?? result.error ?? "not attempted"}`);
    const disabledStoragePaths = [...new Set(disableResults.flatMap((result) => result.disabledStoragePaths ?? []))];
    const wrongSourceSet = (baseState.testableCount || baseState.suspects.length) >= 70 && groupKeys.length >= 20 && attempted <= 3;
    const noProgressReason = wrongSourceSet ? "Crash tester is using the wrong source set." : null;

    setCrashTest((current) => ({
      ...current,
      attemptedDisables: attempted,
      successfulDisables: successful,
      failedDisables: failed,
      skippedMods: skipped.slice(0, 24),
      disabledStoragePaths,
      noProgressReason,
      nextAction: wrongSourceSet
        ? "Stop. Crash Tester did not attempt the expected half-set; inspect the candidate source before launching."
        : (successful > 0 ? "Answer whether the problem happened while this group is disabled." : "No mods were disabled. Check skipped/failed diagnostics before continuing."),
      status: wrongSourceSet
        ? "Crash tester is using the wrong source set."
        : (successful > 0
          ? `Disabled ${successful}/${groupKeys.length} selected test group(s). Launching ${gameName}...`
          : `Crash Test could not disable any selected mods. Failed: ${failed}. Skipped: ${skipped.length}.`),
      history: [...current.history, `Disable results: attempted ${attempted}, successful ${successful}, failed ${failed}, skipped ${skipped.length}.`].slice(-12),
    }));

    if (wrongSourceSet || successful === 0) return;

    try {
      const result = await invoke<string>("launch_active_profile_modded", { profileId });
      setCrashTest((current) => ({ ...current, status: `${result} After testing, answer whether the crash/problem happened.` }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCrashTest((current) => ({ ...current, status: `Launch attempt failed: ${message}. You can still answer manually or restore original state.` }));
    }
  }

  async function startCrashTest() {
    if (crashTestBusy) return;
    if (!(await ensureRuntimeMutationAllowed())) return;

    const enabledCandidates = crashTestCandidates.filter((candidate) => candidate.enabled);
    const testableCandidates = enabledCandidates.filter((candidate) => !candidate.excluded);
    const excludedCandidates = enabledCandidates.filter((candidate) => candidate.excluded);
    if (testableCandidates.length === 0) {
      setCrashTest((current) => ({
        ...current,
        status: excludedCandidates.length > 0
          ? "All enabled mods are excluded from Crash Test. Include at least one mod to test."
          : "No enabled mods are available for Crash Test.",
        excludedCount: excludedCandidates.length,
        testableCount: 0,
      }));
      return;
    }

    const originalEnabled = Object.fromEntries(crashTestCandidates.map((candidate) => [candidate.key, candidate.enabled]));
    const suspects = testableCandidates.map((candidate) => candidate.key);
    const currentGroup = splitCrashGroup(suspects);
    const nextState: CrashTestState = {
      active: true,
      originalEnabled,
      suspects,
      currentGroup,
      likelySuspects: [],
      status: "Crash Test started. Tsuki saved the current enabled/disabled state.",
      history: [`Started with ${enabledCandidates.length} enabled mod group(s), ${excludedCandidates.length} excluded, ${suspects.length} testable. First pass disables ${currentGroup.length}.`],
      totalEnabled: enabledCandidates.length,
      excludedCount: excludedCandidates.length,
      testableCount: suspects.length,
      disabledGroupCount: currentGroup.length,
      round: 1,
      attemptedDisables: 0,
      successfulDisables: 0,
      failedDisables: 0,
      skippedMods: [],
      disabledStoragePaths: [],
      testableKeys: suspects,
      testedGroups: [],
      lastResult: null,
      nextAction: `First round disables ${currentGroup.length}; the other ${suspects.length - currentGroup.length} testable mod group(s) stay enabled.`,
      noProgressReason: null,
    };

    crashTestCancelRef.current = false;
    setCrashTest(nextState);
    setCrashTestBusy(true);
    try {
      await crashTestDelay(90);
      await prepareCrashTestGroup(currentGroup, nextState);
    } finally {
      setCrashTestBusy(false);
    }
  }

  async function answerCrashTest(answer: CrashTestAnswer) {
    if (crashTestBusy || !crashTest.active || crashTest.currentGroup.length === 0) return;

    if (answer === "unsure") {
      setCrashTest((current) => ({
        ...current,
        lastResult: "Not sure",
        nextAction: "Retest this same group or restore the original state.",
        noProgressReason: "User marked this round as unsure, so Tsuki did not reduce the suspect set.",
        status: "Marked unsure. Re-run this group, or stop and restore the original state.",
        history: [...current.history, "User was unsure for current test group."].slice(-12),
      }));
      return;
    }

    const currentSuspects = crashTest.suspects;
    const disabledHalf = crashTest.currentGroup;
    const stillEnabledHalf = crashComplement(currentSuspects, disabledHalf);
    const nextSuspects = answer === "no" ? disabledHalf : stillEnabledHalf;
    const lastResult = answer === "no"
      ? "Problem stopped while the current group was disabled. Suspects are inside the disabled half."
      : "Problem happened while the current group was disabled. Suspects are inside the still-enabled half.";

    if (nextSuspects.length === 0 || nextSuspects.length >= currentSuspects.length) {
      const reason = nextSuspects.length === 0
        ? "No suspect mods remain after this answer. Restore original state and rerun if needed."
        : "This answer did not reduce the suspect set, so Tsuki stopped to avoid repeating the same test.";
      setCrashTest((current) => ({
        ...current,
        lastResult,
        noProgressReason: reason,
        nextAction: "Restore original state, then restart Crash Test if the result was unexpected.",
        status: reason,
        history: [...current.history, `${lastResult} ${reason}`].slice(-12),
      }));
      return;
    }

    if (nextSuspects.length <= 1) {
      const likelySuspects = nextSuspects;
      setCrashTest((current) => ({
        ...current,
        suspects: nextSuspects,
        currentGroup: [],
        likelySuspects,
        disabledGroupCount: 0,
        lastResult,
        nextAction: "Likely culprit isolated. Restore original state when finished.",
        noProgressReason: null,
        status: likelySuspects.length === 1
          ? `Likely suspect found: ${crashCandidateTitle(likelySuspects[0])}. Restore the original state when finished.`
          : "Crash Test could not isolate a suspect from the remaining enabled mods.",
        history: [...current.history, `${lastResult} Suspect set reduced from ${currentSuspects.length} to ${nextSuspects.length}.`].slice(-12),
      }));
      return;
    }

    const nextGroup = chooseNextCrashGroup(nextSuspects, crashTest.testedGroups);
    const nextSignature = crashGroupSignature(nextGroup);
    if (crashTest.testedGroups.includes(nextSignature)) {
      const reason = "Every candidate half for this suspect set was already tested. Tsuki stopped to avoid repeating a group.";
      setCrashTest((current) => ({
        ...current,
        suspects: nextSuspects,
        currentGroup: [],
        disabledGroupCount: 0,
        lastResult,
        noProgressReason: reason,
        nextAction: "Restore original state or answer Not sure only if you want to manually retry.",
        status: reason,
        history: [...current.history, `${lastResult} ${reason}`].slice(-12),
      }));
      return;
    }

    const nextState: CrashTestState = {
      ...crashTest,
      suspects: nextSuspects,
      currentGroup: nextGroup,
      disabledGroupCount: nextGroup.length,
      round: crashTest.round + 1,
      attemptedDisables: 0,
      successfulDisables: 0,
      failedDisables: 0,
      skippedMods: [],
      disabledStoragePaths: [],
      lastResult,
      nextAction: `Suspect set reduced from ${currentSuspects.length} to ${nextSuspects.length}. Next round disables ${nextGroup.length} and leaves ${nextSuspects.length - nextGroup.length} enabled.`,
      noProgressReason: null,
      history: [...crashTest.history, `${lastResult} Suspect set reduced from ${currentSuspects.length} to ${nextSuspects.length}.`].slice(-12),
    };

    setCrashTest(nextState);
    setCrashTestBusy(true);
    try {
      await crashTestDelay(90);
      await prepareCrashTestGroup(nextGroup, nextState);
    } finally {
      setCrashTestBusy(false);
    }
  }

  async function stopCrashTest() {
    crashTestCancelRef.current = true;
    if (crashTestBusy) {
      setCrashTest((current) => ({ ...current, status: "Crash Test is finishing the current safe toggle step. Restore will run next." }));
      await crashTestDelay(120);
    }
    await restoreCrashTestOriginalState();
  }
  async function uninstallMatch(match: InstalledSourceMatch, receiptBacked = match.ownershipClassification === "tsuki_installed" || match.ownershipClassification === "tsuki_imported") {
    if (!(await ensureRuntimeMutationAllowed())) return;

    setBusyKey(`uninstall-${match.source}-${match.sourceId}`);

    try {
      const result = receiptBacked
        ? await invoke<string>("uninstall_source_install", { source: match.source, sourceId: match.sourceId, profileId })
        : await invoke<string>("uninstall_pak_mod_files", { fileNames: match.matchedFiles, profileId });

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

  async function removeBrokenReceipt(match: InstalledSourceMatch) {
    const receiptId = match.receiptId;
    if (!receiptId) {
      setStatus("Broken receipt ID is unavailable. Run a full refresh and try again.");
      return;
    }

    setBusyKey(`remove-broken-${receiptId}`);
    reportTaskProgress("Remove broken receipt", 25, `Removing receipt ${receiptId}...`);

    try {
      const result = await invoke<string>("remove_broken_receipt", { receiptId, profileId });
      const removedKey = `${match.source}-${match.sourceId}`;
      setMatches((current) => {
        const next = { ...current };
        for (const [key, value] of Object.entries(next)) {
          if (key === removedKey || value.receiptId === receiptId) delete next[key];
        }
        savePairState(profileId, sourceMods, next, rawFiles);
        return next;
      });
      setSourceUpdates((current) => current.filter((update) => !(update.source === match.source && update.modId === match.sourceId)));
      invalidateInstalledSessionCache(profileId);
      try {
        window.localStorage.removeItem(profileLocalStorageKey(PAIR_STATE_CACHE_KEY, profileId));
      } catch {
        // Optional cache.
      }
      setSelectedSourceMod(null);
      setSelectedSourceMatch(null);
      setStatus(result);
      reportTaskProgress("Remove broken receipt", 100, "Receipt removed. Refreshing Installed...");
      await refreshInstalled();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      reportTaskProgress("Remove broken receipt failed", 100, message);
    } finally {
      setBusyKey(null);
      clearTaskProgressSoon();
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
    if (!(await ensureRuntimeMutationAllowed())) return;

    if (selectedToggleKeys.length === 0) {
      setStatus("No selected manageable mod cards.");
      return;
    }

    const busyId = `mass-${enabled ? "enable" : "disable"}`;
    setBusyKey(busyId);

    try {
      const started = performance.now();
      const results = await setCrashCandidatesEnabledBatch(selectedToggleKeys, enabled);
      const attempted = results.filter((result) => result.attempted).length;
      const successful = results.filter((result) => result.success).length;
      const failed = results.filter((result) => result.attempted && !result.success).length;
      const skipped = results.filter((result) => !result.attempted || result.skippedReason).length;
      const elapsed = Math.round(performance.now() - started);

      setStatus(`${enabled ? "Enabled" : "Disabled"} ${successful}/${selectedToggleKeys.length} selected mod card(s) in ${elapsed}ms. ${failed ? `${failed} failed. ` : ""}${skipped ? `${skipped} skipped.` : ""}`.trim());
      setPairingStatus(`Multi-select ${enabled ? "enable" : "disable"}: attempted ${attempted}, succeeded ${successful}, failed ${failed}, skipped ${skipped}. Updated affected cards without a full Installed scan.`);
      clearSelectedCards();
      window.dispatchEvent(new Event("tsuki-data-refresh"));
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
      const result = await invoke<string>("open_pak_mods_folder", { profileId });
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

  async function openInstalledFileLocation(match: InstalledSourceMatch) {
    const key = `open-location-${match.source}-${match.sourceId}`;
    setBusyKey(key);
    setStatus("Opening installed file location...");

    try {
      const result = await invoke<string>("open_installed_mod_file_location", {
        source: match.source,
        sourceId: match.sourceId,
        matchedFiles: match.matchedFiles,
        matchKind: match.matchKind,
        profileId,
      });

      setStatus(result);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function openInstalledModDetail(sourceMod: SourceModSummary, match?: InstalledSourceMatch) {
    const key = `${sourceMod.source}-${sourceMod.sourceId}`;
    setDetailLoadingKey(key);
    setSelectedSourceMatch(match ?? matches[key] ?? null);
    reportTaskProgress("Open installed mod", 12, sourceMod.name);
    setStatus(`Opening ${sourceMod.name} inside Tsuki...`);

    const fallbackDetail: SourceModDetail = {
      ...sourceMod,
      description: match?.reason ?? sourceMod.shortDescription ?? "Source files are unavailable right now. Tsuki is showing the local installed files it already tracks.",
      changelog: null,
      files: [],
      images: [],
      comments: [],
      bugs: [],
      logs: [match?.reason ?? "Installed local file record"],
      stats: [
        { label: "Match", value: matchKindLabel(match?.matchKind) ?? "Local installed files" },
        { label: "Confidence", value: `${match?.confidence ?? 0}%` },
      ],
    };

    setSelectedSourceMod(fallbackDetail);

    try {
      if ((sourceMod.source as string) === "local") {
        const localDetail: SourceModDetail = {
          ...sourceMod,
          description: match?.reason ?? sourceMod.shortDescription ?? "Managed local mod. No live source page is paired yet.",
          changelog: null,
          files: [],
          images: [],
          comments: [],
          bugs: [],
          logs: [match?.reason ?? "Managed Unknown Mod"],
          stats: [
            { label: "Match", value: matchKindLabel(match?.matchKind) ?? "Unknown Mod" },
            { label: "Confidence", value: `${match?.confidence ?? 0}%` },
          ],
        };

        setSelectedSourceMod(localDetail);
        setStatus(`Opened ${sourceMod.name}.`);
        reportTaskProgress("Open installed mod", 100, "Opened local installed record.");
        return;
      }

      reportTaskProgress("Open installed mod", 48, "Loading full source detail...");
      const detail =
        sourceMod.source === "nexus"
          ? await invoke<SourceModDetail>("fetch_nexus_mod_detail", { modId: sourceMod.sourceId, profileId, gameDomain: nexusGameDomain })
          : await invoke<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: sourceMod.sourceId, profileId });

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

  async function openLocalGroupDetail(group: InstalledGroup) {
    const sourceId = group.key;
    const localSource = "local" as ModSourceKind;
    const matchedFiles = group.files.map((file) => file.fullPath || file.fileName);
    const match: InstalledSourceMatch = {
      source: localSource,
      sourceId,
      installed: true,
      enabled: group.enabled,
      updateAvailable: false,
      confidence: customGroups.includes(group.key) ? 45 : 10,
      confidenceLevel: customGroups.includes(group.key) ? "medium" : "low",
      ownershipClassification: customGroups.includes(group.key) ? "local_detected" : "unknown_local",
      reason: customGroups.includes(group.key) ? "User marked this local group as custom." : "Unknown local files detected in the active game profile.",
      matchedFiles,
      matchKind: customGroups.includes(group.key) ? "custom-local" : "unknown-local",
      displayName: group.label,
      sourceFileCategory: group.files.some((file) => installedPathLooksWin64OrUe4ss(file.fullPath) || installedPathLooksWin64OrUe4ss(file.fileName)) ? "Win64/UE4SS" : null,
      notes: "Local/unknown mod generated from the active profile scan.",
    };
    const detail: SourceModDetail = {
      source: localSource,
      sourceId,
      name: group.label,
      author: customGroups.includes(group.key) ? "Custom local mod" : null,
      version: null,
      tags: [customGroups.includes(group.key) ? "Custom Local" : "Unknown Local", `${group.files.length} files`, group.enabled ? "Enabled" : "Disabled"],
      thumbnailUrl: null,
      bannerUrl: null,
      pageUrl: null,
      updatedAt: group.modifiedUnix ? String(group.modifiedUnix) : null,
      downloads: null,
      likes: null,
      views: null,
      shortDescription: customGroups.includes(group.key) ? "Custom local mod in the selected profile." : "Unknown local mod in the selected profile.",
      description: [
        customGroups.includes(group.key) ? "This custom local mod is not paired with an online source yet." : "Tsuki found these local files but has not matched them to an online source yet.",
        "Use Try Pair or Edit Metadata to match, rename, tag, and convert it into a managed mod.",
      ].join("\n\n"),
      changelog: null,
      files: [],
      images: [],
      comments: [],
      bugs: [],
      logs: group.files.slice(0, 24).map((file) => `${file.fileName} - ${formatBytes(file.sizeBytes)} - ${formatDateFromUnix(file.modifiedUnix)}`),
      stats: [
        { label: "Files", value: group.files.length.toLocaleString() },
        { label: "Size", value: formatBytes(group.sizeBytes) },
        { label: "Modified", value: formatDateFromUnix(group.modifiedUnix) },
      ],
      dataSource: "fallback",
      detailDataSource: "fallback",
      fileListDataSource: "unavailable",
    };
    setSelectedSourceMatch(match);
    setSelectedSourceMod(detail);
  }
  async function updateInstalledMatch(sourceMod: SourceModSummary, match: InstalledSourceMatch) {
    const key = `update-${sourceMod.source}-${sourceMod.sourceId}`;
    setBusyKey(key);
    setStatus(`Checking update files for ${sourceMod.name}...`);
    reportTaskProgress("Update mod", 10, `Checking ${sourceMod.name}...`);

    try {
      const detail =
        sourceMod.source === "nexus"
          ? await invoke<SourceModDetail>("fetch_nexus_mod_detail", { modId: sourceMod.sourceId, profileId, gameDomain: nexusGameDomain })
          : await invoke<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: sourceMod.sourceId, profileId });

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
        reportTaskProgress("Update failed", 100, "No installable files detected.");
        return;
      }

      const matchedGroup = pairFilesFromMatch(match, groups, sourceMod) ?? {
        key: `${match.source}-${match.sourceId}`,
        label: sourceMod.name,
        files: [],
        modifiedUnix: match.installedModifiedUnix ?? 0,
        sizeBytes: 0,
        enabled: match.enabled,
      };
      const selected = bestReinstallFileForGroup(safeDetail.files, matchedGroup, match);
      if (!selected.file) {
        setStatus(`${safeDetail.name}: Original file no longer exists. Manual selection required.`);
        reportTaskProgress("Update failed", 100, "Manual file selection required.");
        recordRuntimeDiagnostic("Update installed mod", "blocked", selected.reason, [
          safeDetail.name,
          `${safeDetail.source}:${safeDetail.sourceId}`,
          `Available files: ${files.map((candidate) => `${candidate.id}:${candidate.name}`).slice(0, 12).join(" | ")}`,
        ]);
        return;
      }

      const file = selected.file;

      setStatus(`Downloading update for ${safeDetail.name} (${selected.reason})...`);
      reportTaskProgress("Update mod", 45, `Downloading ${file.name}...`);

      const staged = await invoke<StagedDownloadResult>("stage_source_file_download", {
        source: safeDetail.source,
        modId: safeDetail.sourceId,
        fileId: file.id,
        fileName: file.name,
        downloadUrl: file.downloadUrl ?? null,
        modName: safeDetail.name,
        description: safeDetail.description,
        gameDomain: safeDetail.source === "nexus" ? safeDetail.gameId ?? null : null,
        profileId,
      });

      if (!staged.canInstallLater) {
        setStatus(`Downloaded update for ${safeDetail.name}, but install is blocked for manual review.`);
        reportTaskProgress("Update failed", 100, "No installable files detected.");
        return;
      }

      setStatus(`Installing update for ${safeDetail.name}...`);
      reportTaskProgress("Update mod", 76, `Installing ${file.name}...`);

      const applied = await invoke<InstallApplyResult>("install_staged_file_to_game", {
        stagedFilePath: staged.stagedFilePath,
        modName: safeDetail.name,
        source: safeDetail.source,
        modId: safeDetail.sourceId,
        fileId: file.id,
        version: file.version ?? safeDetail.version ?? null,
        sourceFileName: file.name,
        sourceFileCategory: sourceFileBucket(file, groupedInstalledSourceFiles(safeDetail.files, safeDetail.source).main[0] ?? null, safeDetail.source),
        sourceFileUploadedAt: file.uploadedAt ?? null,
        sourceFileVersion: file.version ?? safeDetail.version ?? null,
        author: safeDetail.author ?? null,
        thumbnailUrl: safeDetail.thumbnailUrl ?? null,
        bannerUrl: safeDetail.bannerUrl ?? null,
        pageUrl: safeDetail.pageUrl ?? null,
        description: safeDetail.description,
        replaceFileNames: match.matchedFiles,
        profileId,
      });

      setStatus(`Updated ${safeDetail.name}: installed ${applied.installedFiles.length} file(s), replaced ${applied.replacedFiles.length} old file(s).`);
      reportTaskProgress("Update mod", 100, `Installed ${applied.installedFiles.length} file(s).`);
      await refreshInstalled();
      await refreshUpdateStateAfterMutation(safeDetail.source, safeDetail.sourceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      reportTaskProgress("Update failed", 100, message);
    } finally {
      setBusyKey(null);
      clearTaskProgressSoon();
    }
  }

  void removeRaidWw2BadInstall;
  void syncInstalledLibrary;
  void pairAllSources;

  useEffect(() => {
    if (!runtimeReady) return;
    if (sessionCache) {
      setStatus("Checking cached installed library against disk...");
      void refreshRuntimeLock();
    }
    initialRefreshTimerRef.current = window.setTimeout(() => {
      initialRefreshTimerRef.current = null;
      void refreshInstalled();
    }, 0);

    const reconcileOnFocus = () => {
      if (document.hidden || installedRefreshBusyRef.current) return;
      if (initialRefreshTimerRef.current !== null) window.clearTimeout(initialRefreshTimerRef.current);
      initialRefreshTimerRef.current = window.setTimeout(() => {
        initialRefreshTimerRef.current = null;
        void refreshInstalled(false);
      }, 500);
    };
    window.addEventListener("focus", reconcileOnFocus);

    const timer = window.setInterval(() => {
      void refreshRuntimeLock();
    }, 5000);
    return () => {
      window.removeEventListener("focus", reconcileOnFocus);
      if (initialRefreshTimerRef.current !== null) {
        window.clearTimeout(initialRefreshTimerRef.current);
        initialRefreshTimerRef.current = null;
      }
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, runtimeReady]);

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
      <>
        <InstalledSourceDetailPage
          mod={selectedSourceMod}
          match={selectedSourceMatch}
          profileId={profileId}
          busyKey={busyKey}
          runtimeLocked={runtimeLock?.toggleLocked ?? false}
          onBack={() => {
            setSelectedSourceMod(null);
            setSelectedSourceMatch(null);
          }}
          onOpenWebsite={openWebsite}
          onOpenFileLocation={openInstalledFileLocation}
          onUninstall={(match) => uninstallMatch(match, match.ownershipClassification === "tsuki_installed" || match.ownershipClassification === "tsuki_imported")}
          onToggleReceipt={(match) => setSourceInstallEnabled(match, !(match.enabled !== false))}
          onUpdate={(match) => updateInstalledMatch(selectedSourceMod, match)}
          onEdit={(match) => setManualEditTarget({ sourceMod: selectedSourceMod, match })}
          onRefresh={async () => { await refreshInstalled(); }}
        />
        {manualEditTarget && (
          <ManualReceiptEditModal
            target={manualEditTarget}
            sourceCatalog={sourceMods}
            profileId={profileId}
            sourceConfig={runtimeSourceConfig}
            gameName={gameName}
            onClose={() => setManualEditTarget(null)}
            onSaved={async () => { await refreshInstalled(); }}
          />
        )}
      </>
    );
  }

  return (
    <section className="page installed-clean-page">
      <div className="installed-toolbar-v2">
        <div className="installed-toolbar-search-v2">
          <input
            className="setting-input"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search installed mods..."
          />
        </div>

        <div className="installed-toolbar-counts" aria-label="Installed counts">
          <button className={enabledFilter === "all" ? "active" : ""} type="button" onClick={() => setEnabledFilter("all")}>
            <span>All</span><strong>{totalInstalledLocalMods}</strong>
          </button>
          <button className={enabledFilter === "on" ? "active" : ""} type="button" onClick={() => setEnabledFilter("on")}>
            <span>On</span><strong>{totalEnabledMods}</strong>
          </button>
          <button className={enabledFilter === "off" ? "active" : ""} type="button" onClick={() => setEnabledFilter("off")}>
            <span>Off</span><strong>{totalDisabledMods}</strong>
          </button>
        </div>

        <div className="installed-toolbar-controls-v2">
          <label className="installed-toolbar-select">
            <span>Sort</span>
            <select className="setting-input" value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
              <option value="name">Name</option>
              <option value="modified">Date</option>
              <option value="size">Size</option>
            </select>
          </label>


        </div>

        <div className="installed-toolbar-actions-v2">
          <button className="ghost-button compact" type="button" onClick={openPakModsFolder}>Open ~mods</button>
          <button className="ghost-button compact" type="button" onClick={checkStateFirstUpdates} disabled={updatesBusy}>
            {updatesBusy ? "Checking..." : "Check Updates"}
          </button>
          <button className="ghost-button compact install-button" type="button" onClick={() => setCrashTestOpen(true)}>
            Crash Test
          </button>

          <details className="installed-advanced-actions toolbar-menu">
            <summary>Advanced</summary>
            <div>
              <button className="ghost-button compact" type="button" onClick={() => pairSource("modworkshop")} disabled={busyKey === "pair-modworkshop"}>
                {busyKey === "pair-modworkshop" ? "Pairing..." : "Pair All Workshop"}
              </button>
              <button className="ghost-button compact" type="button" onClick={() => pairSource("nexus")} disabled={busyKey === "pair-nexus"}>
                {busyKey === "pair-nexus" ? "Pairing..." : "Pair All Nexus"}
              </button>
              <button className="ghost-button compact" type="button" onClick={() => refreshInstalled()}>Refresh Only</button>
              <button className="ghost-button compact" type="button" onClick={() => refreshPairing()}>Re-pair All</button>
              <button className="ghost-button compact danger-button" type="button" onClick={repairPairingCache}>Reset Pair Cache</button>
              <button className="ghost-button compact" type="button" onClick={diagnoseModWorkshopPairing} disabled={busyKey === "diagnose-modworkshop-pairing"}>
                {busyKey === "diagnose-modworkshop-pairing" ? "Diagnosing..." : "Diagnose MW"}
              </button>
              <button className="ghost-button compact" type="button" onClick={repairInstalledThumbnails} disabled={busyKey === "repair-thumbnails"}>
                {busyKey === "repair-thumbnails" ? "Repairing..." : "Repair Thumbnails"}
              </button>
              <label className="pair-limit-control">
                <span>Search limit</span>
                <select className="setting-input" value={searchPairLimit} onChange={(event) => setSearchPairLimit(Number(event.target.value))} disabled={enriching}>
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
              <button className="ghost-button compact" type="button" onClick={clearUnpairableGroups} disabled={backgroundPairing}>Clear Skipped</button>
              <button className="ghost-button compact" type="button" onClick={clearPairingGuards} disabled={backgroundPairing}>Clear Guards</button>
            </div>
          </details>
        </div>
      </div>

      {runtimeLock?.toggleLocked && (
        <div className="safe-result warning installed-runtime-lock">
          <strong>{runtimeLock.payday3Running ? `${gameName} is running` : "Vanilla session active"}</strong>
          <span>{runtimeLock.message}</span>
        </div>
      )}

      {crashTestOpen && (
        <div className="installed-crash-modal-backdrop" role="dialog" aria-modal="true">
          <div className="installed-crash-modal card">
            <div className="installed-crash-modal-head">
              <div>
                <strong>Crash Test / Isolation Mode</strong>
                <span>{crashTest.status}</span>
              </div>
              <button className="ghost-button compact" type="button" onClick={() => setCrashTestOpen(false)}>Close</button>
            </div>
            <div className="crash-test-actions">
              <button className="ghost-button compact install-button" type="button" onClick={startCrashTest} disabled={crashTestBusy || crashTest.active || Boolean(runtimeLock?.toggleLocked)}>
                {crashTestBusy ? "Working..." : "Start Crash Test"}
              </button>
              <button className="ghost-button compact" type="button" onClick={() => answerCrashTest("yes")} disabled={crashTestBusy || !crashTest.active || crashTest.currentGroup.length === 0}>Problem happened</button>
              <button className="ghost-button compact" type="button" onClick={() => answerCrashTest("no")} disabled={crashTestBusy || !crashTest.active || crashTest.currentGroup.length === 0}>Problem stopped</button>
              <button className="ghost-button compact" type="button" onClick={() => answerCrashTest("unsure")} disabled={crashTestBusy || !crashTest.active || crashTest.currentGroup.length === 0}>Not sure</button>
              <button className="ghost-button compact" type="button" onClick={stopCrashTest} disabled={!crashTest.active && Object.keys(crashTest.originalEnabled).length === 0}>Stop Test</button>
              <button className="ghost-button compact" type="button" onClick={stopCrashTest} disabled={Object.keys(crashTest.originalEnabled).length === 0}>Restore Original State</button>
              <button className="ghost-button compact" type="button" onClick={clearManualCrashTestExclusions} disabled={Object.keys(crashTestExclusionOverrides).length === 0}>Clear Manual Exclusions</button>
            </div>
            <div className="crash-test-details">
              <span>Total enabled mods: {crashTest.totalEnabled || crashTestCandidates.filter((candidate) => candidate.enabled).length}</span>
              <span>Excluded mods: {crashTest.excludedCount || crashTestExcludedCandidates.filter((candidate) => candidate.enabled).length}</span>
              <span>Testable mods: {crashTest.testableCount || crashTestCandidates.filter((candidate) => candidate.enabled && !candidate.excluded).length}</span>
              <span>Test round: {crashTest.round || 0}</span>
              <span>Selected test group: {crashTest.disabledGroupCount || crashTest.currentGroup.length}</span>
              <span>Attempted disables: {crashTest.attemptedDisables}</span>
              <span>Successful disables: {crashTest.successfulDisables}</span>
              <span>Failed disables: {crashTest.failedDisables}</span>
              <span>Current suspect set: {crashTest.suspects.length}</span>
              <span>Remaining suspects: {crashTest.suspects.length}</span>
              <span>Currently disabled group names: {crashTest.currentGroup.length > 0 ? crashTest.currentGroup.map(crashCandidateTitle).join(", ") : "None"}</span>
              <span>Likely suspects: {crashTest.likelySuspects.length > 0 ? crashTest.likelySuspects.map(crashCandidateTitle).join(", ") : "None yet"}</span>
              {crashTest.lastResult && <span>Last result: {crashTest.lastResult}</span>}
              {crashTest.nextAction && <span>Next action: {crashTest.nextAction}</span>}
              {crashTest.noProgressReason && <span>No progress reason: {crashTest.noProgressReason}</span>}
              {crashTest.disabledStoragePaths.length > 0 && <span>Disabled storage: {crashTest.disabledStoragePaths.join(", ")}</span>}
              {crashTest.skippedMods.length > 0 && <span>Skipped: {crashTest.skippedMods.join("; ")}</span>}
            </div>
            <div className="crash-test-excluded-list">
              <strong>Excluded mods ({crashTestExcludedCandidates.length})</strong>
              {crashTestExcludedCandidates.length === 0 ? (
                <span>None</span>
              ) : (
                <ul>
                  {crashTestExcludedCandidates.slice(0, 16).map((candidate) => (
                    <li key={candidate.key}>{candidate.title}: {candidate.exclusionReason ?? "excluded"}</li>
                  ))}
                </ul>
              )}
              {crashTestExcludedCandidates.length > 16 && <span>+{crashTestExcludedCandidates.length - 16} more excluded mod(s)</span>}
            </div>
            <p className="crash-test-note">This is an isolation tool. Tsuki can help narrow suspects, but your manual answer decides each step.</p>
          </div>
        </div>
      )}
      <div className="mass-select-bar card">
        <div>
          <strong>Mass Select</strong>
          <span>{selectedKeys.length} cards selected / {selectedToggleKeys.length} manageable / {selectedFileNames.length} files selected / {visibleSelectionKeys.length} matching cards</span>
        </div>

        <div className="mass-select-actions">
          <button className="ghost-button compact" type="button" onClick={selectVisibleCards} disabled={visibleSelectionKeys.length === 0}>
            Select Filtered
          </button>
          <button className="ghost-button compact" type="button" onClick={clearSelectedCards} disabled={selectedKeys.length === 0}>
            Clear
          </button>
          <button className="ghost-button compact" type="button" onClick={() => setSelectedFilesEnabled(true)} disabled={selectedToggleKeys.length === 0 || busyKey === "mass-enable"}>
            {busyKey === "mass-enable" ? "..." : "Enable Selected"}
          </button>
          <button className="ghost-button compact" type="button" onClick={() => setSelectedFilesEnabled(false)} disabled={selectedToggleKeys.length === 0 || busyKey === "mass-disable"}>
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
        <span>{sourceMods.length} cached cards - cache {sourceCacheAge} - {sourceCacheBuckets} bucket(s)</span>
        <span>{autoPairStatus}</span>
        <span>Hydration: {metadataHydrationStatus.running ? "running" : "idle"} - {metadataHydrationStatus.hydratedCount} hydrated - {metadataHydrationStatus.missingCount} missing</span>
        {sourceUpdates.length > 0 && (
          <span>
            {sourceUpdates.filter((update) => update.updateAvailable).length}/{sourceUpdates.length} Tsuki receipt updates
            {receiptUpdateCache?.savedAt ? ` - checked ${new Date(receiptUpdateCache.savedAt).toLocaleTimeString()}` : ""}
          </span>
        )}
      </div>

      {(view === "all" || view === "matched" || view === "updates") && (
        <div className="installed-library-grid">
          {visiblePaired.slice(0, renderLimit).map((item) => {
            const selectionKey = pairedSelectionKey(item);
            const detailKey = `${item.sourceMod.source}-${item.sourceMod.sourceId}`;
            const receiptBacked = isReceiptBackedInstalledItem(item);
            const receiptThumbnail = receiptBacked ? (item.match.thumbnailUrl ?? item.match.bannerUrl ?? null) : null;
            const manualThumbnail = isManualMatchKind(item.match.matchKind) ? (item.match.thumbnailUrl ?? item.match.bannerUrl ?? null) : null;
            const exactSourceThumbnail = sourceImageUrl(item.sourceMod);
            const cachedSourceThumbnail = sourceImageForCard(item.sourceMod);
            const cardThumbnail = resolveInstalledThumbnailUrl({
              receiptThumbnail,
              exactSourceThumbnail,
              manualThumbnail,
              cachedSourceThumbnail,
            }, canUseInstalledThumbnail);
            const sourceMod = {
              ...item.sourceMod,
              name: item.match.displayName ?? item.sourceMod.name,
              author: item.match.author ?? item.sourceMod.author,
              thumbnailUrl: cardThumbnail,
              bannerUrl: item.match.bannerUrl ?? item.sourceMod.bannerUrl,
              pageUrl: item.match.pageUrl ?? item.sourceMod.pageUrl,
            };
            const locationLabel = installedSurfaceLabel(item);
            const manageableInstalledFiles = itemHasManageableInstalledFiles(item);
            const hasDisabledStoragePath = item.match.enabled === false && (item.match.matchedFiles ?? []).some(installedPathLooksDisabledStorage);
            const showMissingState = (item.match.missing || item.match.broken) && !hasDisabledStoragePath;
            const rawOwnershipLabel = ownershipBadgeLabel(item.match);
            const ownershipLabel = !showMissingState && rawOwnershipLabel === "Missing/Broken" ? null : rawOwnershipLabel;
            const possibleReplacement = possibleNewerLocalVersionDetected(item);
            const localToggleBusyKey = `local-toggle-${item.match.source}-${item.match.sourceId}`;
            const crashCandidate = crashCandidateMap.get(selectionKey);
            const crashExcluded = Boolean(crashCandidate?.excluded);
            const tagList = [
              ...(sourceMod.tags ?? []),
              item.match.updateAvailable ? "Update" : null,
              ownershipLabel,
              locationLabel,
              possibleReplacement ? "Possible newer local version" : null,
              crashExcluded ? "Crash Test Excluded" : null,
            ].filter(Boolean) as string[];
            const compactTagList = tagList.filter((tag) => {
              const key = String(tag).trim().toLowerCase();
              return key
                && key !== "tsuki-installed"
                && key !== "enabled"
                && key !== "~mods"
                && key !== "pak"
                && key !== "installed";
            }).slice(0, 5);
            const toggleAction = showMissingState ? (
              <span className="badge danger">Missing</span>
            ) : receiptBacked ? (
              <ModToggleButton
                enabled={item.match.enabled !== false}
                busy={busyKey === `receipt-toggle-${item.match.source}-${item.match.sourceId}`}
                disabled={runtimeLock?.toggleLocked}
                onClick={() => setSourceInstallEnabled(item.match, !(item.match.enabled !== false))}
              />
            ) : manageableInstalledFiles ? (
              <ModToggleButton
                enabled={itemEnabled(item)}
                busy={busyKey === item.group?.key || busyKey === localToggleBusyKey}
                disabled={runtimeLock?.toggleLocked}
                onClick={() => setMatchedLocalFilesEnabled(item, !itemEnabled(item))}
              />
            ) : (
              <button className="ghost-button compact" type="button" onClick={() => void openInstalledModDetail(item.sourceMod, item.match)}>
                Open
              </button>
            );

            return (
              <InstalledModCard
                key={detailKey}
                className={`installed-library-card ${item.match.updateAvailable ? "update" : ""}`}
                title={displayModTitle(sourceMod)}
                source={sourceMod.source}
                sourceLabel={sourceLabel(sourceMod.source)}
                author={displayAuthor(sourceMod)}
                version={sourceMod.version ?? item.match.sourceFileVersion}
                thumbnailUrl={sourceMod.thumbnailUrl}
                bannerUrl={sourceMod.bannerUrl}
                tags={compactTagList}
                updatedLabel={installedUpdatedLabel(item.match)}
                enabled={!showMissingState && item.match.enabled !== false}
                stateLabel={showMissingState ? "Missing" : itemEnabled(item) ? (receiptBacked ? null : "Local") : "Off"}
                showStateBadge={showMissingState || !itemEnabled(item) || !receiptBacked}
                selected={selectedSet.has(selectionKey)}
                loadingLabel={detailLoadingKey === detailKey ? "Opening..." : null}
                canUseThumbnail={canUseInstalledThumbnail}
                onThumbnailFailed={rememberInstalledThumbnailFailure}
                selectionControl={massSelectionMode ? (
                  <label className="mass-card-check" onClick={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedSet.has(selectionKey)}
                      onChange={() => toggleSelected(selectionKey)}
                      aria-label={`Select ${sourceMod.name}`}
                    />
                  </label>
                ) : null}
                action={toggleAction}
                onOpen={() => void openInstalledModDetail(item.sourceMod, item.match)}
                moreActions={(
                  <>
                    <button type="button" onClick={() => openInstalledModDetail(item.sourceMod, item.match)}>Open details</button>
                    {manualMatchEditable(item.match) && <button type="button" onClick={() => setManualEditTarget({ sourceMod, match: item.match })}>Edit</button>}
                    {!showMissingState && <button type="button" onClick={() => openInstalledFileLocation(item.match)}>Open file location</button>}
                    <button type="button" onClick={() => openWebsite(item.sourceMod.pageUrl)}>Website</button>
                    {item.match.updateAvailable && <button type="button" onClick={() => updateInstalledMatch(item.sourceMod, item.match)}>Update</button>}
                    {crashCandidate && <button type="button" onClick={() => setCrashTestCandidateExcluded(selectionKey, !crashExcluded)}>{crashExcluded ? "Include in Crash Test" : "Exclude from Crash Test"}</button>}
                    {!showMissingState && <button type="button" onClick={() => receiptBacked ? void uninstallMatch(item.match, receiptBacked) : requestDelete(item.sourceMod.name, item.match.matchedFiles, `uninstall-${item.match.source}-${item.match.sourceId}`)}>Uninstall</button>}
                    {showMissingState && item.match.receiptId && <button type="button" onClick={() => removeBrokenReceipt(item.match)}>Remove broken receipt</button>}
                    {showMissingState && <button type="button" onClick={() => refreshInstalled()}>Re-scan</button>}
                    {showMissingState && <button type="button" onClick={() => setStatus("Keeping missing receipt. Tsuki will continue showing it as Missing/Broken until files return or the receipt is removed.")}>Keep Missing</button>}
                    {showMissingState && possibleReplacement && <button type="button" onClick={() => setStatus("Tracked files missing. Possible newer local version detected. Manual linking is required before Tsuki treats it as the same install.")}>Link later</button>}
                    {item.group && <button type="button" onClick={() => reinstallGroupFromTsuki(item.group!)}>Reinstall from Tsuki</button>}
                    {item.group && <button type="button" onClick={() => markGroupCustom(item.group)}>Mark Custom</button>}
                  </>
                )}
              />
            );
          })}

          {view === "all" && unmatchedGroups.slice(0, Math.max(0, renderLimit - visiblePaired.length)).map((group) => (
            (() => {
              const groupLocationLabel = group.files.some((file) => installedPathLooksWin64OrUe4ss(file.fullPath) || installedPathLooksWin64OrUe4ss(file.fileName))
                ? "Win64/UE4SS"
                : null;
              const groupCrashKey = groupSelectionKey(group);
              const crashCandidate = crashCandidateMap.get(groupCrashKey);
              const crashExcluded = Boolean(crashCandidate?.excluded);

              return (
                <InstalledModCard
                  key={`unpaired-${group.key}`}
                  className="installed-library-card local-unpaired-card"
                  title={group.label}
                  source="local"
                  sourceLabel="Local"
                  author={null}
                  tags={["Unknown local", groupLocationLabel, crashExcluded ? "Crash Test Excluded" : null, `${group.files.length} files`, ...group.files.slice(0, 4).map((file) => installedFileChipLabel(file.fileName))].filter(Boolean) as string[]}
                  enabled={group.enabled}
                  stateLabel={group.enabled ? "Local" : "Off"}
                  selected={selectedSet.has(groupSelectionKey(group))}
                  selectionControl={massSelectionMode ? (
                    <label className="mass-card-check" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedSet.has(groupSelectionKey(group))}
                        onChange={() => toggleSelected(groupSelectionKey(group))}
                        aria-label={`Select ${group.label}`}
                      />
                    </label>
                  ) : null}
                  action={(
                    <ModToggleButton
                      enabled={group.enabled}
                      busy={busyKey === group.key}
                      disabled={runtimeLock?.toggleLocked}
                      onClick={() => setGroupEnabled(group, !group.enabled)}
                    />
                  )}
                  moreActions={(
                    <>
                      <button type="button" onClick={() => void openLocalGroupDetail(group)}>Open details</button>
                      <button type="button" onClick={() => tryPairGroup(group)}>Try Pair</button>
                      <button type="button" onClick={() => setStatus("This raw local group does not have a Receipt v2 record yet. Run Refresh so Tsuki can create an unknown receipt, then use Edit on the receipt-backed card.")}>Edit</button>
                      <button type="button" onClick={() => markGroupCustom(group)}>Mark Custom</button>
                      {crashCandidate && <button type="button" onClick={() => setCrashTestCandidateExcluded(groupCrashKey, !crashExcluded)}>{crashExcluded ? "Include in Crash Test" : "Exclude from Crash Test"}</button>}
                      <button type="button" onClick={() => requestDelete(group.label, group.files.map((file) => file.fileName), `uninstall-${group.key}`)}>{busyKey === `uninstall-${group.key}` ? "..." : "Uninstall"}</button>
                    </>
                  )}
                />
              );
            })()
          ))}

          {visiblePaired.length === 0 && view !== "all" && (
            <article className="installed-empty card">
              <h2>No matches in this view</h2>
              <p>Try refreshing Installed or check Debug if pairing is not working.</p>
            </article>
          )}
        </div>
      )}

      {["all", "matched", "updates"].includes(view) && visiblePaired.length + (view === "all" ? unmatchedGroups.length : 0) > renderLimit && (
        <div className="installed-load-more">
          <button className="ghost-button compact" type="button" onClick={() => setRenderLimit((limit) => limit + 48)}>
            <ChevronDown size={16} aria-hidden="true" /> Show More
          </button>
          <span>{Math.min(renderLimit, visiblePaired.length + (view === "all" ? unmatchedGroups.length : 0))} of {visiblePaired.length + (view === "all" ? unmatchedGroups.length : 0)}</span>
        </div>
      )}

      {view === "unmatched" && (
        <RawGroupList
          title="Unmatched installed mods"
          groups={unmatchedGroups}
          busyKey={busyKey}
          onOpen={(group) => { void openLocalGroupDetail(group); }}
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
          onOpen={(group) => { void openLocalGroupDetail(group); }}
          onToggle={setGroupEnabled}
          onMarkCustom={markGroupCustom}
          onTryPair={tryPairGroup}
          onReinstall={reinstallGroupFromTsuki}
          onUninstall={(group) => requestDelete(group.label, group.files.map((file) => file.fileName), `uninstall-${group.key}`)}
          customGroups={customGroups}
        />
      )}

      {reinstallPicker && (
        <div className="confirm-overlay" role="dialog" aria-modal="true">
          <div className="confirm-panel reinstall-picker-panel">
            <p className="eyebrow">Reinstall from Tsuki</p>
            <h2>Choose files for {reinstallPicker.detail.name}</h2>
            <p className="reinstall-replace-note">
              Currently installed file(s): {reinstallPicker.replaceFileNames.length > 0 ? reinstallPicker.replaceFileNames.join(", ") : "none detected"}
            </p>

            <div className="reinstall-picker-list">
              {reinstallPickerFiles(reinstallPicker.detail).map(({ file, bucket, label }) => {
                const recommended = file.id === reinstallPicker.recommendedFileId;
                const checked = reinstallPickerSelectedIds.includes(file.id);
                const matchedNames = matchedFileNamesForSourceFile(file, reinstallPicker.sourceMatch);
                const installed = matchedNames.length > 0;
                const replaceNames = replaceNamesForReinstallFile(file, reinstallPicker);

                return (
                  <label className={`reinstall-file-choice ${bucket} ${checked ? "selected" : ""}`} key={file.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => {
                        setReinstallPickerSelectedIds((current) => {
                          if (event.target.checked) return [...new Set([...current, file.id])];
                          return current.filter((id) => id !== file.id);
                        });
                      }}
                    />
                    <div>
                      <strong title={file.name}>{file.name}</strong>
                      <span>{label.replace(" files", "")} - {sourceFileMetaLine(file)}</span>
                      <small>
                        {installed ? `Installed: ${matchedNames.join(", ")}` : "Not installed"}
                        {replaceNames.length > 0 ? ` - replaces ${replaceNames.join(", ")}` : ""}
                      </small>
                    </div>
                    {recommended && <em title={reinstallPicker.recommendedReason}>Recommended</em>}
                  </label>
                );
              })}
            </div>

            <div className="button-row">
              <button
                className="ghost-button compact"
                type="button"
                onClick={() => {
                  setReinstallPicker(null);
                  setReinstallPickerSelectedIds([]);
                }}
              >
                Cancel
              </button>
              <button
                className="ghost-button compact install-button"
                type="button"
                disabled={reinstallPickerSelectedIds.length === 0 || busyKey === `reinstall-${reinstallPicker.group.key}`}
                onClick={installSelectedReinstallFiles}
              >
                {busyKey === `reinstall-${reinstallPicker.group.key}` ? "Installing..." : `Install Selected (${reinstallPickerSelectedIds.length})`}
              </button>
            </div>
          </div>
        </div>
      )}

      {manualEditTarget && (
        <ManualReceiptEditModal
          target={manualEditTarget}
          sourceCatalog={sourceMods}
          profileId={profileId}
            sourceConfig={runtimeSourceConfig}
            gameName={gameName}
          onClose={() => setManualEditTarget(null)}
          onSaved={async () => { await refreshInstalled(); }}
        />
      )}
      {pendingDelete && (
        <div className="confirm-overlay" role="dialog" aria-modal="true">
          <div className="confirm-panel">
            <p className="eyebrow">Confirm delete</p>
            <h2>Delete {pendingDelete.title}?</h2>
            <p>Tsuki will permanently delete these files unless Keep Uninstalled Mods is enabled in Settings. Receipt installs use their full tracked file paths.</p>
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


const CUSTOM_TAGS_KEY = "tsuki-custom-tags:v1";
const MAX_CUSTOM_THUMBNAIL_BYTES = 8 * 1024 * 1024;
const THUMBNAIL_FILE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

type TagFilterSource = "all" | TagSource;
type TagFilterType = "all" | TagType;

interface SavedCustomThumbnail {
  path: string;
  fileName: string;
}
interface SourceTaxonomyEntry {
  source: "modworkshop" | "nexus" | string;
  sourceGameId: string;
  gameDomain?: string | null;
  tsukiGameKey?: string | null;
  taxonomyType: "category" | "descriptive" | string;
  sourceTaxonomyId?: string | null;
  label: string;
  canonicalKey: string;
}

interface SourceTaxonomyGame {
  source: "modworkshop" | "nexus" | string;
  sourceGameId: string;
  domainOrSlug?: string | null;
  displayName: string;
  tsukiGameKey?: string | null;
  categories: SourceTaxonomyEntry[];
  descriptiveTags: SourceTaxonomyEntry[];
}

interface SourceTaxonomyDatabase {
  schemaVersion: number;
  generatedAt: number;
  sources: {
    modworkshop: { games: SourceTaxonomyGame[] };
    nexus: { games: SourceTaxonomyGame[] };
  };
}

function isManualMatchKind(matchKind?: string | null) {
  return ["manual", "user-confirmed", "user-confirmed-sha256"].includes(matchKind ?? "");
}

function readCustomTagDefinitions(): TagDefinition[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CUSTOM_TAGS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => typeof item?.label === "string" && !rejectedTaxonomyLabelReason(item.label) ? customTagDefinition(item.label) : null)
      .filter((item): item is TagDefinition => Boolean(item));
  } catch {
    return [];
  }
}

function writeCustomTagDefinitions(tags: TagDefinition[]) {
  const customTags = mergeTagDefinitions(tags.filter((tag) => tag.source === "custom" || tag.type === "custom"));
  window.localStorage.setItem(CUSTOM_TAGS_KEY, JSON.stringify(customTags.map(({ label }) => ({ label }))));
}

function labelsToTagIds(labels: string[] | undefined, catalog: TagDefinition[]) {
  const byDisplay = new Map(catalog.map((tag) => [normalizeTagName(tagDisplayLabel(tag, catalog)), tag.id]));
  const byLabel = new Map(catalog.map((tag) => [normalizeTagName(tag.label), tag.id]));
  return [...new Set((labels ?? [])
    .filter((label) => label && !isSystemBadgeTag(label) && !rejectedTaxonomyLabelReason(label))
    .map((label) => byDisplay.get(normalizeTagName(label)) ?? byLabel.get(normalizeTagName(label)))
    .filter((id): id is string => Boolean(id)))];
}

function tagIdsToLabels(ids: string[], catalog: TagDefinition[]) {
  const byId = new Map(catalog.map((tag) => [tag.id, tag]));
  return ids.map((id) => {
    const tag = byId.get(id);
    return tag ? tagDisplayLabel(tag, catalog) : null;
  }).filter((label): label is string => Boolean(label));
}

function displayThumbnailUrl(value: string | null | undefined) {
  if (!value) return null;
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  return convertFileSrc(value);
}

async function resolveThumbnailSrc(value: string | null | undefined) {
  if (!value) return null;
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  try {
    return await invoke<string>("load_managed_thumbnail_data_url", { path: value });
  } catch {
    return displayThumbnailUrl(value);
  }
}

function sourceGameId(mod: SourceModSummary | SourceModDetail | null | undefined, sourceConfig?: GameProfileSourceConfig | null, profileId?: string | null) {
  const fallback = mod?.gameId ?? mod?.nexus?.gameId ?? null;
  const raw = mod?.source
    ? sourceGameRawIdFromConfig(sourceConfig, profileId ?? "", mod.source, fallback)
    : fallback ?? profileId ?? null;
  return raw ? normalizeGameId(raw) : null;
}
function taxonomyEntryToTag(entry: SourceTaxonomyEntry): TagDefinition | null {
  const source = entry.source === "modworkshop" || entry.source === "nexus" ? entry.source : null;
  const type = entry.taxonomyType === "category" ? "category" : entry.taxonomyType === "descriptive_tag" || entry.taxonomyType === "descriptive" ? "descriptive" : null;
  if (!source || !type || !entry.sourceGameId || !entry.canonicalKey || rejectedTaxonomyLabelReason(entry.label)) return null;
  const gameId = normalizeGameId(entry.tsukiGameKey ?? entry.gameDomain ?? entry.sourceGameId);
  return {
    id: entry.canonicalKey,
    key: entry.canonicalKey,
    canonicalKey: entry.canonicalKey,
    label: entry.label,
    source,
    gameId,
    type,
    sourceId: entry.sourceTaxonomyId ?? entry.canonicalKey,
  };
}

function tagsFromTaxonomyDatabase(database: SourceTaxonomyDatabase | null | undefined) {
  if (!database) return [];
  const games = [...(database.sources?.modworkshop?.games ?? []), ...(database.sources?.nexus?.games ?? [])];
  return mergeTagDefinitions(...games.flatMap((game) => [game.categories ?? [], game.descriptiveTags ?? []]).map((entries) => entries.map(taxonomyEntryToTag)));
}
function manualSourcePayloadFromSummary(summary: SourceModSummary, sourceConfig: GameProfileSourceConfig | null | undefined, profileId: string): ManualSourceMatchPayload {
  return {
    source: summary.source,
    sourceId: summary.sourceId,
    fileId: null,
    gameId: sourceGameRawIdFromConfig(sourceConfig, profileId, summary.source, summary.gameId ?? summary.nexus?.gameId),
    modName: summary.name,
    fileName: summary.name,
    version: summary.version ?? null,
    author: summary.author ?? null,
    thumbnailUrl: summary.thumbnailUrl ?? summary.bannerUrl ?? null,
    pageUrl: summary.pageUrl ?? null,
    sha256: null,
    confidence: 100,
    confidenceLevel: "manual",
    matchKind: "manual",
    reason: "User-confirmed manual source match from search result.",
  };
}

function MatchPreview({ match, onConfirm, onCancel, busy }: { match: ManualSourceMatchPayload; onConfirm: () => void; onCancel: () => void; busy: boolean }) {
  const image = displayThumbnailUrl(match.thumbnailUrl);
  return (
    <article className="edit-mod-match-preview">
      {image ? <img src={image} alt="" /> : <div className="edit-mod-thumb-empty">No image</div>}
      <div>
        <p className="eyebrow">Found mod</p>
        <h3>{match.modName}</h3>
        <dl>
          <div><dt>Source</dt><dd>{sourceLabel(match.source)} #{match.sourceId}</dd></div>
          {match.author && <div><dt>Author</dt><dd>{match.author}</dd></div>}
          {match.version && <div><dt>Version</dt><dd>{match.version}</dd></div>}
          {match.pageUrl && <div><dt>URL</dt><dd>{match.pageUrl}</dd></div>}
        </dl>
        <div className="edit-mod-inline-actions">
          <button className="ghost-button compact" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="ghost-button install-button" type="button" onClick={onConfirm} disabled={busy}>Confirm Match</button>
        </div>
      </div>
    </article>
  );
}

function SelectTagsOverlay({ catalog, initialSelected, refreshBusy, onRefreshTags, onCreateCustomTag, onCancel, onSave }: { catalog: TagDefinition[]; initialSelected: string[]; refreshBusy: boolean; onRefreshTags: () => void; onCreateCustomTag: (label: string) => TagDefinition | null; onCancel: () => void; onSave: (ids: string[]) => void }) {
  const [pending, setPending] = useState<string[]>(initialSelected);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<TagFilterSource>("all");
  const [typeFilter, setTypeFilter] = useState<TagFilterType>("all");
  const filtered = useMemo(() => rankTags(catalog.filter((tag) => {
    const sourceOk = sourceFilter === "all" || tag.source === sourceFilter;
    const typeOk = typeFilter === "all" || tag.type === typeFilter;
    return sourceOk && typeOk && tagMatchesQuery(tag, query);
  }), query), [catalog, query, sourceFilter, typeFilter]);
  const groups = useMemo(() => {
    const result = new Map<string, TagDefinition[]>();
    for (const tag of filtered) {
      const key = tagGroupLabel(tag);
      result.set(key, [...(result.get(key) ?? []), tag]);
    }
    return [...result.entries()];
  }, [filtered]);
  const selectedCount = pending.length;
  const normalizedQuery = normalizeTagName(query);
  const canCreate = normalizedQuery.length > 0 && !catalog.some((tag) => normalizeTagName(tag.label) === normalizedQuery);

  function toggle(tag: TagDefinition) {
    setPending((current) => current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id]);
  }

  function createCustom() {
    const created = onCreateCustomTag(query);
    if (!created) return;
    setPending((current) => current.includes(created.id) ? current : [...current, created.id]);
  }

  return (
    <div className="tag-picker-backdrop" role="dialog" aria-modal="true">
      <section className="tag-picker-panel">
        <header className="tag-picker-header">
          <div>
            <p className="eyebrow">Select tags</p>
            <h2>Tag Catalog</h2>
          </div>
          <button className="ghost-button compact" type="button" onClick={onCancel}>Close</button>
        </header>
        <div className="tag-picker-toolbar">
          <input className="setting-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tags" />
          <div className="segmented-control compact-segmented">
            {(["all", "modworkshop", "nexus", "custom"] as TagFilterSource[]).map((value) => <button key={value} className={sourceFilter === value ? "active" : ""} type="button" onClick={() => setSourceFilter(value)}>{value === "all" ? "All" : value === "modworkshop" ? "ModWorkshop" : value === "nexus" ? "Nexus" : "Custom"}</button>)}
          </div>
          <div className="segmented-control compact-segmented">
            {(["all", "category", "descriptive", "custom"] as TagFilterType[]).map((value) => <button key={value} className={typeFilter === value ? "active" : ""} type="button" onClick={() => setTypeFilter(value)}>{value === "all" ? "All Types" : value === "category" ? "Categories" : value === "descriptive" ? "Descriptive Tags" : "Custom Tags"}</button>)}
          </div>
          <button className="ghost-button compact" type="button" onClick={onRefreshTags} disabled={refreshBusy}>{refreshBusy ? "Refreshing..." : "Refresh Tags"}</button>
          {canCreate && <button className="ghost-button compact" type="button" onClick={createCustom}>Create Custom Tag</button>}
        </div>
        <div className="tag-picker-scroll">
          {groups.map(([group, tags]) => (
            <section className="tag-picker-group" key={group}>
              <h3>{group}</h3>
              <div className="tag-picker-chip-grid">
                {tags.map((tag) => <button key={tag.id} className={`tag-chip ${tagColorClass(tag)} ${pending.includes(tag.id) ? "selected" : ""}`} style={tagColorStyle(tag, catalog)} type="button" onClick={() => toggle(tag)} title={`${tag.source} / ${tag.type}${tag.sourceId ? ` #${tag.sourceId}` : ""}`}>{tagDisplayLabel(tag, catalog)}</button>)}
              </div>
            </section>
          ))}
          {groups.length === 0 && <p className="muted-text">No tags match the current filters.</p>}
        </div>
        <footer className="tag-picker-footer">
          <span>{selectedCount} selected</span>
          <div className="edit-mod-inline-actions">
            <button className="ghost-button compact" type="button" onClick={onCancel}>Cancel</button>
            <button className="ghost-button install-button" type="button" onClick={() => onSave(pending)}>Save Tags</button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function ManualReceiptEditModal({
  target,
  sourceCatalog,
  profileId,
  sourceConfig,
  gameName,
  onClose,
  onSaved,
}: {
  target: ManualEditTarget;
  sourceCatalog: SourceModSummary[];
  profileId: string;
  sourceConfig: GameProfileSourceConfig;
  gameName: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const gameId = useMemo(() => sourceGameId(target.sourceMod, sourceConfig, profileId) ?? normalizeGameId(profileId), [profileId, sourceConfig, target.sourceMod]);
  const modWorkshopGameKey = sourceConfig.modworkshopGameId || sourceConfig.modworkshopSlug || gameId || profileId;
  const hasModWorkshopSource = Boolean(sourceConfig.modworkshopGameId || sourceConfig.modworkshopSlug);
  const hasNexusSource = Boolean(sourceConfig.nexusDomain || sourceConfig.nexusGameId);
  void sourceCatalog;
  const initialTags = useMemo(() => (target.sourceMod.tags ?? []).filter((tag) => !isSystemBadgeTag(tag) && !rejectedTaxonomyLabelReason(tag)), [target.sourceMod.tags]);
  const [customTags, setCustomTags] = useState<TagDefinition[]>(() => readCustomTagDefinitions());
  const [taxonomyTags, setTaxonomyTags] = useState<TagDefinition[]>([]);
  const fallbackTags = useMemo(() => seedTagCatalog(gameId), [gameId]);
  const tagCatalog = useMemo(() => mergeTagDefinitions(taxonomyTags, fallbackTags, customTags), [customTags, fallbackTags, taxonomyTags]);
  const [displayName, setDisplayName] = useState(target.match.displayName ?? target.sourceMod.name ?? "");
  const [version, setVersion] = useState(target.match.sourceFileVersion ?? target.sourceMod.version ?? "");
  const [thumbnailUrl, setThumbnailUrl] = useState(target.match.thumbnailUrl ?? target.sourceMod.thumbnailUrl ?? target.sourceMod.bannerUrl ?? "");
  const [thumbnailPreview, setThumbnailPreview] = useState<string | null>(() => displayThumbnailUrl(target.match.thumbnailUrl ?? target.sourceMod.thumbnailUrl ?? target.sourceMod.bannerUrl));
  const [imageUrlInput, setImageUrlInput] = useState("");
  const [pendingImageUrl, setPendingImageUrl] = useState<string | null>(null);
  const [thumbnailError, setThumbnailError] = useState<string | null>(null);
  const [pageUrl, setPageUrl] = useState(target.match.pageUrl ?? target.sourceMod.pageUrl ?? "");
  const [author, setAuthor] = useState(target.match.author ?? target.sourceMod.author ?? "");
  const [notes, setNotes] = useState(target.match.notes ?? "");
  const [editDraftTags, setEditDraftTags] = useState<string[]>(() => labelsToTagIds(initialTags, tagCatalog));
  const [tagQuery, setTagQuery] = useState("");
  const [pickerPendingTags, setPickerPendingTags] = useState<string[] | null>(null);
  const [sourceSearchQuery, setSourceSearchQuery] = useState(target.sourceMod.name ?? "");
  const [sourceSearchResults, setSourceSearchResults] = useState<SourceModSummary[]>([]);
  const [pendingMatch, setPendingMatch] = useState<ManualSourceMatchPayload | null>(null);
  const [confirmedMatch, setConfirmedMatch] = useState<ManualSourceMatchPayload | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [status, setStatus] = useState("Manual edits save to the receipt and keep tracked files intact.");
  const [busy, setBusy] = useState(false);
  const [tagRefreshBusy, setTagRefreshBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hasManualMatch = isManualMatchKind(target.match.matchKind);
  const tagDefinitionsById = useMemo(() => new Map(tagCatalog.map((tag) => [tag.id, tag])), [tagCatalog]);
  const selectedTags = editDraftTags.map((id) => tagDefinitionsById.get(id)).filter((tag): tag is TagDefinition => Boolean(tag));
  const compactTagMatches = useMemo(() => rankTags(tagCatalog.filter((tag) => tagMatchesQuery(tag, tagQuery)), tagQuery).slice(0, 8), [tagCatalog, tagQuery]);

  useEffect(() => {
    let cancelled = false;
    void resolveThumbnailSrc(thumbnailUrl).then((src) => {
      if (!cancelled) setThumbnailPreview(src);
    });
    return () => { cancelled = true; };
  }, [thumbnailUrl]);

  useEffect(() => {
    let cancelled = false;
    invoke<SourceTaxonomyDatabase>("get_source_taxonomy_for_game", { gameId })
      .then((database) => {
        if (!cancelled) setTaxonomyTags(tagsFromTaxonomyDatabase(database));
      })
      .catch(() => {
        if (!cancelled) setTaxonomyTags([]);
      });
    return () => { cancelled = true; };
  }, [gameId]);

  function createCustomTag(label: string) {
    const clean = label.trim();
    if (!clean || isSystemBadgeTag(clean) || rejectedTaxonomyLabelReason(clean)) return null;
    const created = customTagDefinition(clean, gameId);
    const next = mergeTagDefinitions(customTags, [created]);
    setCustomTags(next);
    writeCustomTagDefinitions(next);
    return created;
  }

  function openTagPicker(seedIds: string[] = []) {
    setPickerPendingTags([...new Set([...editDraftTags, ...seedIds])]);
  }

  function selectCompactTag(tag: TagDefinition) {
    openTagPicker([tag.id]);
  }

  function createCompactCustomTag() {
    const label = tagQuery.trim() || window.prompt("Custom tag name")?.trim() || "";
    const created = createCustomTag(label);
    if (created) openTagPicker([created.id]);
  }

  async function refreshTagCatalog() {
    if (tagRefreshBusy) return;
    setTagRefreshBusy(true);
    setStatus(`Refreshing tag catalog for ${gameId}...`);
    try {
      const [taxonomyStatus, taxonomyDatabase, indexedMods] = await Promise.all([
        invoke("refresh_current_game_taxonomy", { gameId }).catch(() => null),
        invoke<SourceTaxonomyDatabase>("get_source_taxonomy_for_game", { gameId }).catch(() => null),
        invoke<SourceModSummary[]>("list_source_index", { source: null, limit: 1200, profileId }).catch(() => []),
      ]);
      void taxonomyStatus;
      const officialTags = tagsFromTaxonomyDatabase(taxonomyDatabase);
      void indexedMods;
      if (officialTags.length === 0) {
        setStatus(`Refresh failed: no valid official taxonomy entries were returned for ${gameId}. Custom tags were kept.`);
        return;
      }
      setTaxonomyTags(officialTags);
      setStatus(`Tag catalog refreshed: ${officialTags.length} valid official source taxonomy item(s) for ${gameId}. Custom tags were kept.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setTagRefreshBusy(false);
    }
  }

  async function loadMatchFromUrl() {
    const parsed = parseManualSourceUrl(pageUrl);
    if (!parsed) {
      setStatus(`Paste a supported ${gameName} ModWorkshop or Nexus mod page URL.`);
      return;
    }
    setBusy(true);
    setStatus(`Loading ${sourceLabel(parsed.source)} mod ${parsed.modId}...`);
    try {
      const detail = parsed.source === "nexus"
        ? await invoke<SourceModDetail>("fetch_nexus_mod_detail", { modId: parsed.modId, profileId, gameDomain: parsed.gameDomain ?? null })
        : await invoke<SourceModDetail>("fetch_modworkshop_mod_detail", { modId: parsed.modId, profileId });
      /* Source detail tags are intentionally not ingested into the selectable taxonomy. */
      setPendingMatch(sourceMatchPayloadFromDetail(detail, parsed.pageUrl, sourceConfig, profileId));
      setStatus("Review the found mod, then Confirm Match if it is the right pairing.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function searchForMod() {
    const query = sourceSearchQuery.trim();
    if (!query) {
      setStatus("Enter a mod name or keyword to search.");
      return;
    }
    setBusy(true);
    setStatus("Searching configured sources...");
    try {
      const [modworkshopResults, nexusResults, indexedResults] = await Promise.all([
        hasModWorkshopSource ? invoke<SourceModSummary[]>("search_modworkshop_mods_for_query", { query, page: 1, profileId, gameId: modWorkshopGameKey }).catch(() => []) : Promise.resolve([]),
        hasNexusSource ? invoke<SourceModSummary[]>("search_nexus_mods_for_query", { query, profileId }).catch(() => []) : Promise.resolve([]),
        invoke<SourceModSummary[]>("list_source_index", { source: null, limit: 1200, profileId }).catch(() => []),
      ]);
      const queryText = query.toLowerCase();
      const resultMap = new Map<string, SourceModSummary>();
      for (const mod of filterProfileSourceMods(profileId, [...modworkshopResults, ...nexusResults, ...indexedResults])) {
        const haystack = [mod.name, mod.author ?? "", ...(mod.tags ?? [])].join(" ").toLowerCase();
        if (haystack.includes(queryText)) resultMap.set(sourceKey(mod), mod);
      }
      const results = [...resultMap.values()].slice(0, 12);
      setSourceSearchResults(results);
      /* Source detail tags are intentionally not ingested into the selectable taxonomy. */
      setStatus(results.length ? `Found ${results.length} candidate${results.length === 1 ? "" : "s"}. Select one to review.` : "No matching mods found.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  function confirmMatch(match: ManualSourceMatchPayload) {
    setConfirmedMatch(match);
    setPendingMatch(null);
    setDisplayName(match.modName);
    setVersion(match.version ?? "");
    setAuthor(match.author ?? "");
    setPageUrl(match.pageUrl ?? pageUrl);
    if (match.thumbnailUrl) {
      setThumbnailUrl(match.thumbnailUrl);
      void resolveThumbnailSrc(match.thumbnailUrl).then(setThumbnailPreview);
    }
    setStatus("Manual match confirmed. Save to write it to the receipt.");
  }

  async function chooseThumbnail(file: File | null) {
    if (!file) return;
    if (!THUMBNAIL_FILE_TYPES.has(file.type)) {
      setThumbnailError("Choose a PNG, JPG, WEBP, or GIF image.");
      return;
    }
    if (file.size > MAX_CUSTOM_THUMBNAIL_BYTES) {
      setThumbnailError("Choose an image under 8 MB.");
      return;
    }
    if (!target.match.receiptId) {
      setThumbnailError("This card has no receipt ID, so a local thumbnail cannot be stored safely yet.");
      return;
    }
    setBusy(true);
    setThumbnailError(null);
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const saved = await invoke<SavedCustomThumbnail>("save_custom_receipt_thumbnail", { receiptId: target.match.receiptId, fileName: file.name, bytes });
      setThumbnailUrl(saved.path);
      setThumbnailPreview(await resolveThumbnailSrc(saved.path));
      setStatus(`Stored ${saved.fileName}. Save to attach it to this receipt.`);
    } catch (error) {
      setThumbnailError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function previewImageUrl() {
    const trimmed = imageUrlInput.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      setThumbnailError("Paste a valid http or https image URL.");
      return;
    }
    setPendingImageUrl(trimmed);
    setThumbnailError(null);
  }

  function resetThumbnail() {
    const fallback = confirmedMatch?.thumbnailUrl ?? target.sourceMod.thumbnailUrl ?? target.sourceMod.bannerUrl ?? "";
    setThumbnailUrl(fallback);
    void resolveThumbnailSrc(fallback).then(setThumbnailPreview);
    setPendingImageUrl(null);
    setImageUrlInput("");
    setThumbnailError(null);
  }

  async function save(clearSourceMatch = false) {
    if (!target.match.receiptId) {
      setStatus("This card has no receipt ID, so edits cannot be stored safely yet.");
      return;
    }
    if (clearSourceMatch && !window.confirm("Clear the manual match for this receipt? Tracked installed files stay intact.")) return;
    setBusy(true);
    setStatus(clearSourceMatch ? "Clearing manual match..." : "Saving receipt metadata...");
    try {
      await invoke("update_install_receipt_metadata", {
        profileId,
        update: {
          receiptId: target.match.receiptId,
          displayName,
          version,
          thumbnailUrl,
          pageUrl,
          author,
          notes,
          tags: tagIdsToLabels(editDraftTags, tagCatalog),
          sourceMatch: clearSourceMatch ? null : confirmedMatch,
          clearSourceMatch,
        },
      });
      invalidateInstalledSessionCache(profileId);
      await onSaved();
      onClose();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="manual-edit-backdrop" role="dialog" aria-modal="true">
      <section className="manual-edit-panel edit-mod-panel">
        <header className="manual-edit-header edit-mod-header">
          <div>
            <p className="eyebrow">Edit mod</p>
            <h2>{displayName || target.sourceMod.name}</h2>
          </div>
          <button className="ghost-button compact" type="button" onClick={onClose} disabled={busy}>Close</button>
        </header>

        <div className="edit-mod-main-grid">
          <div className="edit-mod-fields">
            <label>Display Name<input className="setting-input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
            <label>Version<input className="setting-input" value={version} onChange={(event) => setVersion(event.target.value)} /></label>
            <label>Author<input className="setting-input" value={author} onChange={(event) => setAuthor(event.target.value)} /></label>
          </div>

          <article className="edit-mod-thumbnail-editor">
            <p className="eyebrow">Thumbnail</p>
            <div className="edit-mod-thumbnail-preview">
              {thumbnailPreview ? <img src={thumbnailPreview} alt="" /> : <span>No thumbnail</span>}
              {pendingImageUrl && <img className="edit-mod-hidden-image-test" src={pendingImageUrl} alt="" onLoad={() => { setThumbnailUrl(pendingImageUrl); setThumbnailPreview(pendingImageUrl); setPendingImageUrl(null); setThumbnailError(null); }} onError={() => { setPendingImageUrl(null); setThumbnailError("That image URL could not be loaded. The previous thumbnail was kept."); }} />}
            </div>
            <div className="edit-mod-inline-actions">
              <button className="ghost-button compact" type="button" onClick={() => fileInputRef.current?.click()} disabled={busy}>Choose Image</button>
              <button className="ghost-button compact" type="button" onClick={resetThumbnail} disabled={busy}>Reset Thumbnail</button>
            </div>
            <input ref={fileInputRef} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => chooseThumbnail(event.currentTarget.files?.[0] ?? null)} />
            <div className="edit-mod-url-row">
              <input className="setting-input" value={imageUrlInput} onChange={(event) => setImageUrlInput(event.target.value)} placeholder="Paste image URL" />
              <button className="ghost-button compact" type="button" onClick={previewImageUrl} disabled={busy}>Preview URL</button>
            </div>
            {thumbnailError && <p className="error-text">{thumbnailError}</p>}
          </article>
        </div>

        <article className="manual-match-box edit-mod-section">
          <p className="eyebrow">Mod Page</p>
          <div className="manual-match-row">
            <input className="setting-input" value={pageUrl} onChange={(event) => setPageUrl(event.target.value)} placeholder="https://modworkshop.net/mod/12345 or https://www.nexusmods.com/<game>/mods/12345" />
            <button className="ghost-button compact" type="button" onClick={loadMatchFromUrl} disabled={busy}>Match Mod</button>
          </div>
          {pendingMatch && <MatchPreview match={pendingMatch} busy={busy} onCancel={() => setPendingMatch(null)} onConfirm={() => confirmMatch(pendingMatch)} />}
          {confirmedMatch && !pendingMatch && <p className="success-text">Manual match confirmed: {confirmedMatch.modName} ({sourceLabel(confirmedMatch.source)} #{confirmedMatch.sourceId})</p>}
        </article>

        <article className="edit-mod-section">
          <p className="eyebrow">Search for Mod</p>
          <div className="manual-match-row">
            <input className="setting-input" value={sourceSearchQuery} onChange={(event) => setSourceSearchQuery(event.target.value)} placeholder="Search current game sources" />
            <button className="ghost-button compact" type="button" onClick={searchForMod} disabled={busy}>Search</button>
          </div>
          {sourceSearchResults.length > 0 && <div className="edit-mod-search-results">
            {sourceSearchResults.map((result) => {
              const thumb = displayThumbnailUrl(result.thumbnailUrl ?? result.bannerUrl);
              return <button key={`${result.source}-${result.sourceId}`} className="edit-mod-search-result" type="button" onClick={() => setPendingMatch(manualSourcePayloadFromSummary(result, sourceConfig, profileId))}>
                {thumb ? <img src={thumb} alt="" /> : <span />}
                <strong>{result.name}</strong>
                <small>{sourceLabel(result.source)} #{result.sourceId}{result.author ? ` by ${result.author}` : ""}</small>
                <span>{(result.tags ?? []).filter((tag) => !isSystemBadgeTag(tag)).slice(0, 3).filter(Boolean).join(" - ")}</span>
              </button>;
            })}
          </div>}
        </article>

        <article className="edit-mod-section edit-mod-tags-section">
          <div className="edit-mod-section-title">
            <p className="eyebrow">Tags</p>
            <button className="ghost-button compact" type="button" onClick={() => openTagPicker()}>See All</button>
          </div>
          <div className="edit-mod-tag-search">
            <input className="setting-input" value={tagQuery} onChange={(event) => setTagQuery(event.target.value)} placeholder="Search tags" />
            <button className="ghost-button compact" type="button" onClick={createCompactCustomTag}>Create Custom Tag</button>
          </div>
          <div className="edit-mod-tag-results">
            {compactTagMatches.map((tag) => <button key={tag.id} className={`tag-chip ${tagColorClass(tag)}`} style={tagColorStyle(tag, tagCatalog)} type="button" onClick={() => selectCompactTag(tag)}>{tagDisplayLabel(tag, tagCatalog)}</button>)}
          </div>
          <div className="edit-mod-selected-tags">
            {selectedTags.length ? selectedTags.map((tag) => <span key={tag.id} className={`tag-chip selected ${tagColorClass(tag)}`} style={tagColorStyle(tag, tagCatalog)}>{tagDisplayLabel(tag, tagCatalog)}</span>) : <span className="muted-text">No tags selected.</span>}
          </div>
        </article>

        <details className="edit-mod-advanced" open={showAdvanced} onToggle={(event) => setShowAdvanced(event.currentTarget.open)}>
          <summary>Advanced / Technical Info</summary>
          <label>Notes<textarea className="setting-input" value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
          <dl>
            <div><dt>Receipt ID</dt><dd>{target.match.receiptId ?? "None"}</dd></div>
            <div><dt>Match kind</dt><dd>{target.match.matchKind}</dd></div>
            <div><dt>Source ID</dt><dd>{target.match.sourceId}</dd></div>
          </dl>
        </details>

        <p className="manual-edit-status">{status}</p>

        <footer className="manual-edit-actions edit-mod-actions">
          {hasManualMatch && <button className="ghost-button compact danger-button" type="button" onClick={() => save(true)} disabled={busy}>Clear Manual Match</button>}
          <span className="edit-mod-action-spacer" />
          <button className="ghost-button compact" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="ghost-button install-button" type="button" onClick={() => save(false)} disabled={busy}>{busy ? "Saving..." : "Save"}</button>
        </footer>

        {pickerPendingTags && <SelectTagsOverlay catalog={tagCatalog} initialSelected={pickerPendingTags} refreshBusy={tagRefreshBusy} onRefreshTags={refreshTagCatalog} onCreateCustomTag={createCustomTag} onCancel={() => setPickerPendingTags(null)} onSave={(ids) => { setEditDraftTags(ids); setPickerPendingTags(null); }} />}
      </section>
    </div>
  );
}
function InstalledSourceDetailPage({
  mod,
  match,
  profileId,
  busyKey,
  runtimeLocked,
  onBack,
  onOpenWebsite,
  onOpenFileLocation,
  onUninstall,
  onToggleReceipt,
  onUpdate,
  onEdit,
  onRefresh,
}: {
  mod: SourceModDetail;
  match: InstalledSourceMatch | null;
  profileId: string;
  busyKey: string | null;
  runtimeLocked: boolean;
  onBack: () => void;
  onOpenWebsite: (pageUrl?: string | null) => void;
  onOpenFileLocation: (match: InstalledSourceMatch) => void;
  onUninstall: (match: InstalledSourceMatch) => void;
  onToggleReceipt: (match: InstalledSourceMatch) => void;
  onUpdate: (match: InstalledSourceMatch) => void;
  onEdit: (match: InstalledSourceMatch) => void;
  onRefresh: () => Promise<void>;
}) {
  const [fileBusyKey, setFileBusyKey] = useState<string | null>(null);
  const [developerMode, setDeveloperMode] = useState(false);
  const uninstallBusy = match ? busyKey === `uninstall-${match.source}-${match.sourceId}` : false;
  const locationBusy = match ? busyKey === `open-location-${match.source}-${match.sourceId}` : false;
  const safeFiles = installableSourceFiles(Array.isArray(mod.files) ? mod.files : []);
  const fileGroups = groupedInstalledSourceFiles(Array.isArray(mod.files) ? mod.files : [], mod.source);
  const safeImages = Array.isArray(mod.images) ? mod.images : [];
  const safeStats = Array.isArray(mod.stats) ? mod.stats : [];
  const safeTags = Array.isArray(mod.tags) ? mod.tags : [];
  const safeMatchedFiles: string[] = Array.isArray(match?.matchedFiles) ? (match?.matchedFiles ?? []).filter((item): item is string => typeof item === "string") : [];
  const receiptBacked = Boolean(match?.installed && (match.ownershipClassification === "tsuki_installed" || match.ownershipClassification === "tsuki_imported"));
  const heroImage = mod.bannerUrl ?? mod.thumbnailUrl ?? match?.bannerUrl ?? match?.thumbnailUrl ?? null;

  useEffect(() => {
    let cancelled = false;
    invoke<{ developerMode?: boolean }>("get_app_settings")
      .then((settings) => { if (!cancelled) setDeveloperMode(Boolean(settings.developerMode)); })
      .catch(() => { if (!cancelled) setDeveloperMode(false); });
    const onDeveloperModeChanged = (event: Event) => setDeveloperMode(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener("tsuki-developer-mode-changed", onDeveloperModeChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("tsuki-developer-mode-changed", onDeveloperModeChanged);
    };
  }, []);
  function matchedNamesForFile(file: SourceModFile) {
    if (!match?.installed) return [];
    const fileName = file.name.toLowerCase();
    const fileStem = enabledFileName(fileName).replace(/\.[a-z0-9]{2,6}$/i, "");
    const fileId = file.id.toLowerCase();
    return safeMatchedFiles.filter((value) => {
      const clean = value.toLowerCase();
      const base = clean.split(/[\\/]/).pop() ?? clean;
      const normalizedBase = enabledFileName(base);
      return normalizedBase === enabledFileName(fileName)
        || normalizedBase.includes(fileStem)
        || clean.includes(fileId);
    });
  }

  async function installSourceFile(file: SourceModFile) {
    const busy = `install-${file.id}`;
    setFileBusyKey(busy);
    reportTaskProgress("Install mod", 12, `${mod.name} / ${file.name}`);
    try {
      const staged = await invoke<StagedDownloadResult>("stage_source_file_download", {
        source: mod.source,
        modId: mod.sourceId,
        fileId: file.id,
        fileName: file.name,
        downloadUrl: file.downloadUrl ?? null,
        modName: mod.name,
        description: mod.description,
        gameDomain: mod.source === "nexus" ? mod.gameId ?? null : null,
        profileId,
      });
      if (!staged.canInstallLater) {
        reportTaskProgress("Install failed", 100, "No installable files detected.");
        return;
      }
      reportTaskProgress("Install mod", 72, `Installing ${file.name}...`);
      await invoke<InstallApplyResult>("install_staged_file_to_game", {
        stagedFilePath: staged.stagedFilePath,
        modName: mod.name,
        source: mod.source,
        modId: mod.sourceId,
        fileId: file.id,
        version: file.version ?? mod.version ?? null,
        sourceFileName: file.name,
        sourceFileCategory: sourceFileBucket(file, groupedInstalledSourceFiles(mod.files, mod.source).main[0] ?? null, mod.source),
        sourceFileUploadedAt: file.uploadedAt ?? null,
        sourceFileVersion: file.version ?? mod.version ?? null,
        author: mod.author ?? null,
        thumbnailUrl: mod.thumbnailUrl ?? null,
        bannerUrl: mod.bannerUrl ?? null,
        pageUrl: mod.pageUrl ?? null,
        description: mod.description,
        replaceFileNames: [],
        profileId,
      });
      reportTaskProgress("Install mod", 100, `Installed ${file.name}.`);
      await onRefresh();
    } catch (error) {
      reportTaskProgress("Install failed", 100, error instanceof Error ? error.message : String(error));
    } finally {
      setFileBusyKey(null);
      clearTaskProgressSoon();
    }
  }

  async function uninstallSourceFile(fileNames: string[]) {
    if (fileNames.length === 0) return;
    setFileBusyKey(`uninstall-${fileNames.join("|")}`);
    reportTaskProgress("Uninstall mod", 20, `Removing ${fileNames.length} file(s)...`);
    try {
      await invoke<string>("uninstall_pak_mod_files", { fileNames, profileId });
      reportTaskProgress("Uninstall mod", 100, `Removed ${fileNames.length} file(s).`);
      await onRefresh();
    } catch (error) {
      reportTaskProgress("Uninstall failed", 100, error instanceof Error ? error.message : String(error));
    } finally {
      setFileBusyKey(null);
      clearTaskProgressSoon();
    }
  }

  async function setSourceFileEnabled(fileNames: string[], enabled: boolean) {
    if (fileNames.length === 0) return;
    setFileBusyKey(`toggle-${fileNames.join("|")}`);
    reportTaskProgress(enabled ? "Enable mod" : "Disable mod", 30, `${enabled ? "Enabling" : "Disabling"} ${fileNames.length} file(s)...`);
    try {
      await invoke<string>("set_pak_mod_files_enabled", { fileNames, enabled, profileId });
      reportTaskProgress(enabled ? "Enable mod" : "Disable mod", 100, `${enabled ? "Enabled" : "Disabled"} ${fileNames.length} file(s).`);
      await onRefresh();
    } catch (error) {
      reportTaskProgress(enabled ? "Enable failed" : "Disable failed", 100, error instanceof Error ? error.message : String(error));
    } finally {
      setFileBusyKey(null);
      clearTaskProgressSoon();
    }
  }

  async function openSourceFileLocation(fileNames: string[]) {
    if (!match || fileNames.length === 0) return;
    setFileBusyKey(`open-${fileNames.join("|")}`);
    reportTaskProgress("Open location", 40, "Opening File Explorer...");
    try {
      await invoke<string>("open_installed_mod_file_location", {
        source: match.source,
        sourceId: match.sourceId,
        matchedFiles: fileNames,
        matchKind: match.matchKind,
        profileId,
      });
      reportTaskProgress("Open location", 100, "Opened file location.");
    } catch (error) {
      reportTaskProgress("Open location failed", 100, error instanceof Error ? error.message : String(error));
    } finally {
      setFileBusyKey(null);
      clearTaskProgressSoon();
    }
  }

  const sourceFileGroups: UnifiedFileGroup[] = (["main", "optional", "old"] as SourceFileBucket[])
    .filter((bucket) => bucket !== "old" || fileGroups.old.length > 0)
    .map((bucket) => ({
      id: bucket,
      title: bucket === "main" ? "Main files" : bucket === "optional" ? "Optional files" : "Old files",
      subtitle: bucket === "main" ? "Primary source downloads" : bucket === "optional" ? "Optional downloads and requirements" : "Older source versions",
      rows: fileGroups[bucket].map((file) => {
        const matchedNames = matchedNamesForFile(file);
        const installed = matchedNames.length > 0;
        const disabled = matchedNames.some((name) => /\.disabled$/i.test(name));
        const busy = fileBusyKey?.includes(file.id) || matchedNames.some((name) => fileBusyKey?.includes(name));
        return {
          id: file.id,
          title: file.name,
          subtitle: sourceFileMetaLine(file),
          status: installed ? (disabled ? "Disabled" : "Installed") : "Available",
          tone: installed ? (disabled ? "warning" as const : "good" as const) : "neutral" as const,
          actions: installed ? (
            <>
              <button className="ghost-button compact" type="button" onClick={() => openSourceFileLocation(matchedNames)} disabled={Boolean(busy)}>Open Folder</button>
              <button className="ghost-button compact" type="button" onClick={() => setSourceFileEnabled(matchedNames, disabled)} disabled={runtimeLocked || Boolean(busy)}>{disabled ? "Enable" : "Disable"}</button>
              <button className="ghost-button compact danger-button" type="button" onClick={() => uninstallSourceFile(matchedNames)} disabled={runtimeLocked || Boolean(busy)}>Uninstall</button>
            </>
          ) : (
            <button className="ghost-button compact install-button" type="button" onClick={() => installSourceFile(file)} disabled={runtimeLocked || Boolean(busy)}>Install</button>
          ),
        };
      }),
      emptyLabel: `No ${bucket} source files are available.`,
    }));
  const installedFileGroups: UnifiedFileGroup[] = safeMatchedFiles.length ? [{
    id: "installed-files",
    title: receiptBacked ? "Receipt installed files" : "Local installed files",
    subtitle: receiptBacked ? "Files recorded in the install receipt." : "Files detected locally for this mod.",
    rows: safeMatchedFiles.map((fileName) => {
      const disabled = /\.disabled$/i.test(fileName);
      return {
        id: fileName,
        title: installedFileBaseName(fileName),
        subtitle: installedFileShortPath(fileName),
        meta: fileName,
        status: disabled ? "Disabled" : "Enabled",
        tone: disabled ? "warning" as const : "good" as const,
        actions: (
          <>
            <button className="ghost-button compact" type="button" onClick={() => openSourceFileLocation([fileName])} disabled={Boolean(fileBusyKey?.includes(fileName))}>Reveal</button>
            <button className="ghost-button compact" type="button" onClick={() => navigator.clipboard.writeText(fileName)}>Copy Path</button>
            <button className="ghost-button compact" type="button" onClick={() => navigator.clipboard.writeText(installedFileShortPath(fileName))}>Copy Relative Path</button>
            <button className="ghost-button compact" type="button" onClick={() => setSourceFileEnabled([fileName], disabled)} disabled={runtimeLocked || Boolean(fileBusyKey?.includes(fileName))}>{disabled ? "Enable" : "Disable"}</button>
            <button className="ghost-button compact danger-button" type="button" onClick={() => uninstallSourceFile([fileName])} disabled={runtimeLocked || Boolean(fileBusyKey?.includes(fileName))}>Delete</button>
          </>
        ),
      };
    }),
  }] : [];
  const changelogEntries = cleanSourceDescription(mod.changelog).split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const commentItems = (mod.comments ?? []).map(cleanSourceDescription).filter(Boolean).slice(0, 16).map((comment, index) => <p key={`installed-comment-${index}`}>{comment}</p>);
  const metadata: UnifiedInfoItem[] = [
    { label: "Install Status", value: match?.installed ? (match.enabled === false ? "Disabled" : "Installed") : "Local / unknown", tone: match?.installed ? "good" : "warning" },
    { label: "Verification", value: match ? `${match.confidence}% ${match.confidenceLevel ?? "match"}` : "Unmatched", tone: match ? "neutral" : "warning" },
    { label: "Match", value: matchKindLabel(match?.matchKind) ?? "Local" },
    { label: "Ownership", value: match?.ownershipClassification?.replace(/_/g, " ") ?? "unknown local" },
    { label: "Source Category", value: match?.sourceFileCategory ?? null },
    { label: "Tracked Files", value: safeMatchedFiles.length ? safeMatchedFiles.length.toLocaleString() : null },
  ];
  const statistics: UnifiedInfoItem[] = [
    ...safeStats.slice(0, 10),
    { label: "Installed Files", value: safeMatchedFiles.length ? safeMatchedFiles.length.toLocaleString() : null },
    { label: "Source Files", value: safeFiles.length ? safeFiles.length.toLocaleString() : null },
  ];
  const receiptItems: UnifiedInfoItem[] = match ? [
    { label: "Receipt", value: match.receiptId ?? "No receipt id" },
    { label: "Source File Version", value: match.sourceFileVersion ?? null },
    { label: "Source File", value: match.sourceFileName },
    { label: "Reason", value: match.reason },
  ] : [];
  const versionHistory: UnifiedTimelineItem[] = changelogEntries.slice(0, 20).map((entry, index) => ({ id: `changelog-${index}`, title: "Changelog", detail: entry, tone: "neutral" as const }));
  const updateItems: UnifiedTimelineItem[] = match ? [{
    id: "installed-update",
    title: match.updateAvailable ? "Update available" : "Installed version",
    detail: match.reason,
    date: match.sourceUpdatedAt ?? match.sourceFileUploadedAt ?? null,
    status: match.updateAvailable ? "Review update" : "Current",
    tone: match.updateAvailable ? "warning" : "good",
  }] : [];
  const actions: UnifiedAction[] = [
    { key: "website", label: "Visit Page", onClick: () => onOpenWebsite(mod.pageUrl), disabled: !mod.pageUrl, variant: "neutral" },
    match && manualMatchEditable(match) ? { key: "edit", label: "Edit Metadata", onClick: () => onEdit(match), variant: "neutral" } : null,
    match?.installed ? { key: "open-folder", label: locationBusy ? "Opening..." : "Open Folder", onClick: () => onOpenFileLocation(match), disabled: locationBusy, variant: "neutral" } : null,
    receiptBacked && match ? { key: "toggle", label: busyKey === `receipt-toggle-${match.source}-${match.sourceId}` ? "Working..." : (match.enabled !== false) ? "Disable" : "Enable", onClick: () => onToggleReceipt(match), disabled: runtimeLocked || busyKey === `receipt-toggle-${match.source}-${match.sourceId}`, variant: "neutral" } : null,
    match?.installed && match.updateAvailable ? { key: "update", label: busyKey === `update-${match.source}-${match.sourceId}` ? "Updating..." : "Update", onClick: () => onUpdate(match), disabled: runtimeLocked || busyKey === `update-${match.source}-${match.sourceId}`, variant: "update" } : null,
    safeFiles[0] ? { key: "reinstall", label: match?.installed ? "Reinstall" : "Install", onClick: () => installSourceFile(safeFiles[0]), disabled: runtimeLocked || Boolean(fileBusyKey), variant: match?.installed ? "neutral" : "install" } : null,
    match && manualMatchEditable(match) ? { key: "change-thumbnail", label: "Change Thumbnail", onClick: () => onEdit(match), variant: "neutral" } : null,
    { key: "refresh", label: "Repair / Refresh", onClick: () => { void onRefresh(); }, disabled: Boolean(fileBusyKey), variant: "neutral" },
    { key: "share", label: "Share", onClick: () => navigator.clipboard.writeText(mod.pageUrl ?? mod.name), variant: "neutral" },
    { key: "export", label: "Export", onClick: () => navigator.clipboard.writeText(JSON.stringify({ mod, match }, null, 2)), variant: "neutral" },
    match?.installed ? { key: "uninstall", label: uninstallBusy ? "Uninstalling..." : "Uninstall", onClick: () => onUninstall(match), disabled: runtimeLocked || uninstallBusy, variant: "danger" } : null,
  ].filter(Boolean) as UnifiedAction[];
  const developerItems: UnifiedInfoItem[] = [
    { label: "Receipt", value: match?.receiptId },
    { label: "Match Kind", value: match?.matchKind },
    { label: "Source ID", value: mod.sourceId },
    { label: "Source File ID", value: match?.sourceFileId },
    { label: "UID", value: mod.uid },
    { label: "Raw Match", detail: match ? JSON.stringify(match).slice(0, 1200) : null },
  ];
  const dependencies: UnifiedDependencyItem[] = (mod.dependencies ?? []).map((dependency) => {
    const enriched = enrichDependency({
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
    }, profileId);
    return { id: enriched.id, title: <DependencyName dependency={enriched} />, detail: `${dependencySourceLabel(enriched)}${enriched.versionConstraint ? ` - ${enriched.versionConstraint}` : ""}`, status: enriched.required ? "Required" : "Optional", tone: enriched.required ? "warning" : "neutral", actions: <DependencyActions dependency={enriched} /> };
  });

  return (
    <UnifiedModPage
      className="installed-unified-mod-page"
      backLabel="Back to Installed"
      onBack={onBack}
      source={mod.source}
      sourceLabel={sourceLabel(mod.source)}
      sourceAccent={sourceAccent(mod.source)}
      sourceId={mod.sourceId}
      title={displayModTitle(mod)}
      summary={cleanSourceDescription(mod.shortDescription || mod.description) || (match ? match.reason : "Installed local mod.")}
      description={mod.description || mod.shortDescription || match?.reason || "No description has been saved for this mod yet."}
      author={displayAuthor(mod)}
      version={mod.version ?? match?.sourceFileVersion ?? null}
      game={sourceGameId(mod) ?? null}
      category={match?.sourceFileCategory ?? null}
      fileSize={safeMatchedFiles.length ? `${safeMatchedFiles.length} tracked file(s)` : null}
      installDate={match?.installedModifiedUnix ? formatDateFromUnix(match.installedModifiedUnix) : null}
      lastUpdate={mod.updatedAt ?? match?.sourceUpdatedAt ?? null}
      installStatus={match?.installed ? (match.enabled === false ? "Disabled" : "Installed") : "Local / unknown"}
      verificationStatus={match ? `${match.confidence}% ${match.confidenceLevel ?? "match"}` : "Unmatched"}
      thumbnailUrl={mod.thumbnailUrl ?? match?.thumbnailUrl ?? null}
      bannerUrl={heroImage}
      pageUrl={mod.pageUrl ?? match?.pageUrl ?? null}
      tags={safeTags}
      badges={[
        { label: sourceLabel(mod.source), tone: "neutral" as const },
        match?.installed ? { label: match.enabled === false ? "Disabled" : "Installed", tone: match.enabled === false ? "warning" as const : "good" as const } : { label: "Unknown local", tone: "warning" as const },
        match?.updateAvailable ? { label: "Update Available", tone: "warning" as const } : null,
        receiptBacked ? { label: "Receipt backed", tone: "good" as const } : null,
      ].filter(Boolean) as Array<{ label: string; tone?: "good" | "warning" | "danger" | "neutral" }>}
      actions={actions}
      metadata={metadata}
      statistics={statistics}
      galleryImages={safeImages}
      fileGroups={sourceFileGroups}
      installedFileGroups={installedFileGroups}
      dependencies={dependencies}
      versionHistory={versionHistory}
      receiptItems={receiptItems}
      updateItems={updateItems}
      comments={commentItems}
      settingsContent={match && manualMatchEditable(match) ? <button className="ghost-button compact" type="button" onClick={() => onEdit(match)}>Edit metadata and manual match</button> : null}
      developerMode={developerMode}
      developerItems={developerItems}
      filesUnavailableMessage={safeFiles.length === 0 ? "Source files are unavailable right now. Tsuki is showing tracked local files when available." : null}
      onOpenExternal={onOpenWebsite}
    />
  );
}
function RawGroupList({
  title,
  groups,
  busyKey,
  onOpen,
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
  onOpen: (group: InstalledGroup) => void;
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
                {group.files.length} files - {group.enabled ? "enabled" : "disabled"}
                {inferModWorkshopId(group) ? ` - MW #${inferModWorkshopId(group)}` : ""}
              </small>
            </div>
            <div className="raw-row-actions">
              <ModToggleButton
                enabled={group.enabled}
                busy={busyKey === group.key}
                onClick={() => onToggle(group, !group.enabled)}
              />
              <button className="mini-action" type="button" onClick={() => onOpen(group)}>
                Open Details
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

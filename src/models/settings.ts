export interface SavedWindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface AppSettings {
  gamePath?: string | null;
  currentGameProfileId?: string | null;
  activeGameProfileId?: string | null;
  activeModProfileByGameProfileId?: Record<string, string>;
  themeId: string;
  appearanceMode: "system" | "light" | "dark";
  accentColor: string;
  interfaceDensity: "compact" | "comfortable" | "spacious";
  animationsEnabled: boolean;
  transparencyEnabled: boolean;
  fontScale: number;
  thumbnailSize: number;
  sidebarDensity: "comfortable" | "compact" | "icons";
  startupDestination: "home" | "browse" | "installed" | "games" | "last";
  notificationsEnabled: boolean;
  language: "system" | "en";
  defaultLaunchAction: "ask" | "vanilla" | "modded" | "remember";
  confirmDestructiveActions: boolean;
  autoUpdateChecks: boolean;
  rememberWindowState: boolean;
  windowState?: SavedWindowState | null;
  downloadFolder?: string | null;
  simultaneousDownloads: number;
  downloadRetryCount: number;
  downloadBandwidthLimitMbS: number;
  verifyHashes: boolean;
  keepDownloadedArchives?: boolean;
  keepUninstalledMods?: boolean;
  browserMode: "native" | "embedded" | "fallback" | "ask";
  externalLinkBehavior: "ask" | "external" | "block";
  rememberWebsiteLogins: boolean;
  interceptSupportedDownloads: boolean;
  keepEmbeddedBrowsingInSites: boolean;
  protectWrongGameDownloads: boolean;
  rememberLastWebsitePerProfile: boolean;
  profileDefaultSources: string[];
  profileDefaultDependencySetup: "ask" | "auto" | "off";
  profileDefaultBackupBehavior: "before-replace" | "every-install" | "needed" | "disabled";
  profileDefaultInstallationFlow: "guided" | "quick" | "ask";
  profileDefaultBrowserMode: "global" | "native" | "embedded" | "ask";
  profileDefaultIndexBehavior: "auto" | "manual" | "disabled";
  appUpdateManifestUrl?: string | null;
  updateChannel: "stable" | "beta" | "nightly";
  profileUpdateChecks: boolean;
  dependencyUpdateChecks: boolean;
  indexUpdateChecks: boolean;
  ignoredVersions: string[];
  sourceIndexV2RemoteEnabled?: boolean;
  sourceIndexV2RemoteUrl?: string | null;
  indexOvernight: boolean;
  indexPauseWhileGameRunning: boolean;
  indexPauseOnBattery: boolean;
  indexBuildMode: "metadata" | "manifest" | "full";
  indexBandwidthLimitMbS: number;
  indexTempStorageLimitGb: number;
  indexRemoteBehavior: "auto" | "ask" | "manual" | "disabled";
  modworkshopApiKey?: string | null;
  nexusApiKey?: string | null;
  showAgeRestrictedNexus?: boolean;
  developerMode?: boolean;
  verboseLogging: boolean;
  experimentalFeatures: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  activeModProfileByGameProfileId: {},
  themeId: "moonveil",
  appearanceMode: "system",
  accentColor: "#9b72ff",
  interfaceDensity: "comfortable",
  animationsEnabled: true,
  transparencyEnabled: true,
  fontScale: 100,
  thumbnailSize: 160,
  sidebarDensity: "comfortable",
  startupDestination: "home",
  notificationsEnabled: true,
  language: "system",
  defaultLaunchAction: "ask",
  confirmDestructiveActions: true,
  autoUpdateChecks: true,
  rememberWindowState: true,
  windowState: null,
  downloadFolder: null,
  simultaneousDownloads: 3,
  downloadRetryCount: 2,
  downloadBandwidthLimitMbS: 0,
  verifyHashes: true,
  keepDownloadedArchives: true,
  keepUninstalledMods: false,
  browserMode: "fallback",
  externalLinkBehavior: "ask",
  rememberWebsiteLogins: true,
  interceptSupportedDownloads: true,
  keepEmbeddedBrowsingInSites: true,
  protectWrongGameDownloads: true,
  rememberLastWebsitePerProfile: true,
  profileDefaultSources: ["modworkshop", "nexus", "github"],
  profileDefaultDependencySetup: "ask",
  profileDefaultBackupBehavior: "before-replace",
  profileDefaultInstallationFlow: "guided",
  profileDefaultBrowserMode: "global",
  profileDefaultIndexBehavior: "auto",
  appUpdateManifestUrl: null,
  updateChannel: "stable",
  profileUpdateChecks: true,
  dependencyUpdateChecks: true,
  indexUpdateChecks: true,
  ignoredVersions: [],
  sourceIndexV2RemoteEnabled: true,
  sourceIndexV2RemoteUrl: null,
  indexOvernight: false,
  indexPauseWhileGameRunning: true,
  indexPauseOnBattery: true,
  indexBuildMode: "metadata",
  indexBandwidthLimitMbS: 0,
  indexTempStorageLimitGb: 8,
  indexRemoteBehavior: "auto",
  modworkshopApiKey: null,
  nexusApiKey: null,
  showAgeRestrictedNexus: true,
  developerMode: false,
  verboseLogging: false,
  experimentalFeatures: false,
};

const THEME_ALIASES: Record<string, string> = {
  "basic-light": "classic-light",
};

export function normalizeThemeId(themeId: string | null | undefined) {
  const raw = String(themeId || DEFAULT_APP_SETTINGS.themeId).trim();
  return THEME_ALIASES[raw] || raw || DEFAULT_APP_SETTINGS.themeId;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, Math.round(next)));
}

function normalizeArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function normalizeAppSettings(settings: Partial<AppSettings> | null | undefined): AppSettings {
  const merged = { ...DEFAULT_APP_SETTINGS, ...(settings ?? {}) } as AppSettings;
  return {
    ...merged,
    themeId: normalizeThemeId(merged.themeId),
    accentColor: /^#[0-9a-f]{6}$/i.test(merged.accentColor) ? merged.accentColor : DEFAULT_APP_SETTINGS.accentColor,
    fontScale: clampNumber(merged.fontScale, DEFAULT_APP_SETTINGS.fontScale, 90, 125),
    thumbnailSize: clampNumber(merged.thumbnailSize, DEFAULT_APP_SETTINGS.thumbnailSize, 96, 280),
    simultaneousDownloads: clampNumber(merged.simultaneousDownloads, DEFAULT_APP_SETTINGS.simultaneousDownloads, 1, 8),
    downloadRetryCount: clampNumber(merged.downloadRetryCount, DEFAULT_APP_SETTINGS.downloadRetryCount, 0, 6),
    downloadBandwidthLimitMbS: clampNumber(merged.downloadBandwidthLimitMbS, DEFAULT_APP_SETTINGS.downloadBandwidthLimitMbS, 0, 250),
    indexBandwidthLimitMbS: clampNumber(merged.indexBandwidthLimitMbS, DEFAULT_APP_SETTINGS.indexBandwidthLimitMbS, 0, 250),
    indexTempStorageLimitGb: clampNumber(merged.indexTempStorageLimitGb, DEFAULT_APP_SETTINGS.indexTempStorageLimitGb, 1, 64),
    profileDefaultSources: normalizeArray(merged.profileDefaultSources, DEFAULT_APP_SETTINGS.profileDefaultSources),
    ignoredVersions: normalizeArray(merged.ignoredVersions, DEFAULT_APP_SETTINGS.ignoredVersions),
  };
}

export function applyAppearanceSettings(settings: Pick<AppSettings, "accentColor" | "interfaceDensity" | "animationsEnabled" | "transparencyEnabled" | "fontScale" | "thumbnailSize" | "sidebarDensity">) {
  const root = document.documentElement;
  root.style.setProperty("--tsuki-user-accent", settings.accentColor);
  root.style.setProperty("--accent", settings.accentColor);
  root.style.setProperty("--color-accent", settings.accentColor);
  root.style.setProperty("--tsuki-font-scale", `${settings.fontScale}%`);
  root.style.setProperty("--tsuki-thumbnail-size", `${settings.thumbnailSize}px`);
  root.dataset.interfaceDensity = settings.interfaceDensity;
  root.dataset.animations = settings.animationsEnabled ? "true" : "false";
  root.dataset.transparency = settings.transparencyEnabled ? "true" : "false";
  root.dataset.sidebarDensity = settings.sidebarDensity;
}

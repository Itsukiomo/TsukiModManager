import type { AppSettings } from "./settings";

export type ProfileBrowserMode = "inherit" | AppSettings["browserMode"];
export type ProfileLaunchAction = "inherit" | AppSettings["defaultLaunchAction"];
export type ProfileSourceId = "modworkshop" | "nexus" | "github" | "custom";

export interface ProfileSettings {
  gameVersion?: string | null;
  profileId: string;
  updatedAtUnix: number;
  gameRootOverride?: string | null;
  executableOverride?: string | null;
  workingDirectoryOverride?: string | null;
  launchArguments: string;
  launchEnvironment: string[];
  defaultLaunchAction: ProfileLaunchAction;
  browserModeOverride: ProfileBrowserMode;
  preferredBrowserSource: "auto" | ProfileSourceId;
  rememberLastWebsite: boolean;
  enabledSources: ProfileSourceId[];
  indexBehavior: "inherit" | AppSettings["profileDefaultIndexBehavior"];
  dependencySetup: "inherit" | AppSettings["profileDefaultDependencySetup"];
  dependencyUpdates: "inherit" | "auto" | "ask" | "off";
  backupBehavior: "inherit" | AppSettings["profileDefaultBackupBehavior"];
  backupRetentionCount: number;
  setupReminders: boolean;
  dismissedSetupChecks: string[];
  lastSettingsCategory?: string | null;
}

export const DEFAULT_PROFILE_SETTINGS: ProfileSettings = {
  profileId: "",
  updatedAtUnix: 0,
  gameRootOverride: null,
  executableOverride: null,
  workingDirectoryOverride: null,
  launchArguments: "",
  launchEnvironment: [],
  defaultLaunchAction: "inherit",
  browserModeOverride: "inherit",
  preferredBrowserSource: "auto",
  rememberLastWebsite: true,
  enabledSources: [],
  indexBehavior: "inherit",
  dependencySetup: "inherit",
  dependencyUpdates: "inherit",
  backupBehavior: "inherit",
  backupRetentionCount: 5,
  setupReminders: true,
  dismissedSetupChecks: [],
  lastSettingsCategory: null,
};

function cleanOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function uniqueChoices<T extends string>(value: unknown, allowed: readonly T[]) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<T>();
  for (const item of value) {
    if (typeof item === "string" && allowed.includes(item as T)) seen.add(item as T);
  }
  return [...seen];
}

function cleanStringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, Math.round(next)));
}

export function normalizeProfileSettings(value: Partial<ProfileSettings> | null | undefined, profileId: string): ProfileSettings {
  const merged = { ...DEFAULT_PROFILE_SETTINGS, ...(value ?? {}) };
  const sources = ["modworkshop", "nexus", "github", "custom"] as const;
  return {
    ...merged,
    profileId,
    gameVersion: cleanOptionalString(merged.gameVersion),
    updatedAtUnix: clampNumber(merged.updatedAtUnix, 0, 0, Number.MAX_SAFE_INTEGER),
    gameRootOverride: cleanOptionalString(merged.gameRootOverride),
    executableOverride: cleanOptionalString(merged.executableOverride),
    workingDirectoryOverride: cleanOptionalString(merged.workingDirectoryOverride),
    launchArguments: typeof merged.launchArguments === "string" ? merged.launchArguments : "",
    launchEnvironment: cleanStringList(merged.launchEnvironment),
    defaultLaunchAction: choice(merged.defaultLaunchAction, ["inherit", "ask", "vanilla", "modded", "remember"] as const, "inherit"),
    browserModeOverride: choice(merged.browserModeOverride, ["inherit", "native", "embedded", "fallback", "ask"] as const, "inherit"),
    preferredBrowserSource: choice(merged.preferredBrowserSource, ["auto", ...sources] as const, "auto"),
    rememberLastWebsite: merged.rememberLastWebsite !== false,
    enabledSources: uniqueChoices(merged.enabledSources, sources),
    indexBehavior: choice(merged.indexBehavior, ["inherit", "auto", "manual", "disabled"] as const, "inherit"),
    dependencySetup: choice(merged.dependencySetup, ["inherit", "ask", "auto", "off"] as const, "inherit"),
    dependencyUpdates: choice(merged.dependencyUpdates, ["inherit", "auto", "ask", "off"] as const, "inherit"),
    backupBehavior: choice(merged.backupBehavior, ["inherit", "before-replace", "every-install", "needed", "disabled"] as const, "inherit"),
    backupRetentionCount: clampNumber(merged.backupRetentionCount, DEFAULT_PROFILE_SETTINGS.backupRetentionCount, 0, 50),
    setupReminders: merged.setupReminders !== false,
    dismissedSetupChecks: cleanStringList(merged.dismissedSetupChecks),
    lastSettingsCategory: cleanOptionalString(merged.lastSettingsCategory),
  };
}

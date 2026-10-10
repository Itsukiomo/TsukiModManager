import type { GameProfile, GameProfileSourceConfig } from "./gameProfiles";

export interface ActiveProfileRuntime {
  profileId: string;
  definitionRevision: number;
  gameId: string;
  gameName: string;
  gameRoot?: string | null;
  executable?: string | null;
  namedPaths: string[];
  sources: string[];
  sourceConfig: GameProfileSourceConfig;
  modTypes: string[];
  installRules: string[];
  toggleRules: string[];
  dependencies: string[];
  conflictRules: string[];
  storagePath: string;
  installedStatePath: string;
  receiptsPath: string;
  backupsPath: string;
  disabledStatePath: string;
  browseCachePath: string;
  thumbnailCachePath: string;
  sourceIndexPath: string;
  dependencyStatePath: string;
  setupStatePath: string;
  launchConfiguration: unknown;
  loadedReceiptCount: number;
  loadedInstalledModCount: number;
  ready: boolean;
  error?: string | null;
}

function draftRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function draftArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function profileHasConfiguredSources(profile: GameProfile): boolean {
  const sourceConfig = profile.sourceConfig ?? {};
  if (Boolean(
    sourceConfig.sources?.some((source) => source.enabled !== false) ||
    sourceConfig.modworkshopGameId ||
    sourceConfig.modworkshopSlug ||
    sourceConfig.modworkshopGamePageUrl ||
    sourceConfig.modworkshopEmbeddedStartUrl ||
    sourceConfig.nexusDomain ||
    sourceConfig.nexusGameId ||
    sourceConfig.nexusGamePageUrl ||
    sourceConfig.nexusEmbeddedStartUrl ||
    sourceConfig.customBrowser ||
    sourceConfig.customBrowserStartUrl ||
    sourceConfig.customBrowserSources?.length
  )) {
    return true;
  }

  const draft = draftRecord(profile.draft);
  const sections = draftRecord(draft.sections);
  return draftArray(sections.sources).some((item) => {
    const record = draftRecord(item);
    return record.enabled !== false;
  });
}

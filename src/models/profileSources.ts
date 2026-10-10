import type {
  GameProfileBrowseMode,
  GameProfileSourceConfig,
  GameProfileSourceDefinition,
  GameProfileSourceProvider,
} from "./gameProfiles";

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : [];
}

export function canonicalModWorkshopRoute(value: unknown) {
  const normalized = clean(value).toLowerCase().replace(/[ _]+/g, "-");
  if (["payday2", "pd2", "1"].includes(normalized)) return "payday-2";
  if (["payday3", "pd3", "853"].includes(normalized)) return "payday-3";
  if (["2", "payday-the-heist", "pdth"].includes(normalized)) return "pdth";
  return normalized;
}

export function profileBrowseSessionIdentity(profileId: string, gameVersion: string | undefined, config: GameProfileSourceConfig) {
  return JSON.stringify([profileId, gameVersion, config]);
}

export function modWorkshopCardMatchesSource(gameId: string | null | undefined, tags: string[], source: GameProfileSourceDefinition | null, requestedGame: string) {
  if (!gameId || canonicalModWorkshopRoute(gameId) !== canonicalModWorkshopRoute(requestedGame)) return false;
  if (!source?.gameVersion) return true;
  const legacy = tags.some((tag) => tag.toLowerCase() === "ue4.27");
  return source.gameVersion === "UE4.27" ? legacy : !legacy;
}

export function canonicalModWorkshopUrl(value: unknown) {
  const raw = clean(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!/(^|\.)modworkshop\.net$/i.test(url.hostname)) return raw;
    const parts = url.pathname.split("/");
    const gameRouteIndex = parts.findIndex((part) => ["g", "game", "games"].includes(part.toLowerCase()));
    if (gameRouteIndex >= 0 && parts[gameRouteIndex + 1]) {
      parts[gameRouteIndex + 1] = canonicalModWorkshopRoute(parts[gameRouteIndex + 1]);
      url.pathname = parts.join("/");
    }
    return url.toString();
  } catch {
    return raw;
  }
}

export function normalizeProfileBrowseMode(value: unknown, provider: GameProfileSourceProvider): GameProfileBrowseMode {
  const normalized = clean(value).toLowerCase().replace(/[\s_-]+/g, " ");
  if (normalized.includes("external")) return "external";
  if (normalized.includes("iframe")) return provider === "nexus" ? "webview_window" : "iframe";
  if (normalized.includes("embedded") || normalized.includes("webview") || normalized.includes("browser")) return "webview_window";
  return provider === "custom" ? "webview_window" : "api";
}

function fallbackLabel(provider: GameProfileSourceProvider, mode: GameProfileBrowseMode) {
  if (provider === "nexus") return mode === "api" ? "Nexus Mods" : "Nexus Browser";
  if (provider === "modworkshop") return mode === "api" ? "ModWorkshop" : "ModWorkshop Browser";
  if (provider === "github") return mode === "api" ? "GitHub" : "GitHub Browser";
  return "Custom Browser";
}

function normalizeDefinition(raw: Partial<GameProfileSourceDefinition>, index: number): GameProfileSourceDefinition {
  const provider: GameProfileSourceProvider = ["modworkshop", "nexus", "github", "custom"].includes(clean(raw.provider))
    ? clean(raw.provider) as GameProfileSourceProvider
    : "custom";
  const browseMode = normalizeProfileBrowseMode(raw.browseMode, provider);
  const normalizeUrl = provider === "modworkshop" ? canonicalModWorkshopUrl : clean;
  return {
    id: clean(raw.id) || `source-${provider}-${index + 1}`,
    displayName: clean(raw.displayName) || fallbackLabel(provider, browseMode),
    provider,
    gameVersion: clean(raw.gameVersion) || undefined,
    enabled: raw.enabled !== false,
    browseMode,
    apiEnabled: raw.apiEnabled !== false,
    apiKeySource: clean(raw.apiKeySource) || null,
    gameName: clean(raw.gameName) || null,
    providerSlug: (provider === "modworkshop" ? canonicalModWorkshopRoute(raw.providerSlug) : clean(raw.providerSlug)) || null,
    providerGameId: clean(raw.providerGameId) || null,
    gamePageUrl: normalizeUrl(raw.gamePageUrl) || null,
    listingUrl: normalizeUrl(raw.listingUrl) || null,
    startUrl: normalizeUrl(raw.startUrl) || null,
    allowedDomains: cleanList(raw.allowedDomains),
    captureDownloads: raw.captureDownloads !== false,
  };
}

function uniqueSourceIds(sources: GameProfileSourceDefinition[]) {
  const counts = new Map<string, number>();
  return sources.map((source) => {
    const count = counts.get(source.id) ?? 0;
    counts.set(source.id, count + 1);
    return count === 0 ? source : { ...source, id: `${source.id}-${count + 1}` };
  });
}

export function profileSourcesFromConfig(config: GameProfileSourceConfig, gameName: string): GameProfileSourceDefinition[] {
  if (Array.isArray(config.sources) && config.sources.length > 0) {
    return uniqueSourceIds(config.sources.map(normalizeDefinition).filter((source) => source.enabled));
  }

  const legacy: GameProfileSourceDefinition[] = [];
  if (config.modworkshopGameId || config.modworkshopSlug || config.modworkshopGamePageUrl || config.modworkshopEmbeddedStartUrl) {
    legacy.push(normalizeDefinition({
      id: "source-modworkshop-api",
      displayName: config.modworkshopDisplayName || "ModWorkshop",
      provider: "modworkshop",
      enabled: true,
      browseMode: normalizeProfileBrowseMode(config.modworkshopBrowseMode, "modworkshop"),
      gameName: config.modworkshopGameName || gameName,
      providerSlug: config.modworkshopSlug,
      providerGameId: config.modworkshopGameId,
      gamePageUrl: config.modworkshopGamePageUrl,
      listingUrl: config.modworkshopCategoryUrl,
      startUrl: config.modworkshopEmbeddedStartUrl || config.modworkshopCategoryUrl || config.modworkshopGamePageUrl,
      allowedDomains: config.modworkshopAllowedDomains ?? [],
    }, legacy.length));
  }
  if (config.nexusDomain || config.nexusGameId || config.nexusGamePageUrl || config.nexusEmbeddedStartUrl) {
    legacy.push(normalizeDefinition({
      id: "source-nexus-api",
      displayName: config.nexusDisplayName || "Nexus Mods",
      provider: "nexus",
      enabled: true,
      browseMode: normalizeProfileBrowseMode(config.nexusBrowseMode, "nexus"),
      gameName: config.nexusGameName || gameName,
      providerSlug: config.nexusDomain,
      providerGameId: config.nexusGameId,
      gamePageUrl: config.nexusGamePageUrl,
      listingUrl: config.nexusCategoryUrl,
      startUrl: config.nexusEmbeddedStartUrl || config.nexusCategoryUrl || config.nexusGamePageUrl,
      allowedDomains: config.nexusAllowedDomains ?? [],
    }, legacy.length));
  }
  for (const [index, source] of (config.customBrowserSources ?? []).entries()) {
    const startUrl = clean(source.startUrl);
    const provider: GameProfileSourceProvider = /nexusmods\.com/i.test(startUrl)
      ? "nexus"
      : /modworkshop\.net/i.test(startUrl)
        ? "modworkshop"
        : "custom";
    legacy.push(normalizeDefinition({
      id: clean(source.id) || `source-custom-${index + 1}`,
      displayName: source.displayName,
      provider,
      enabled: true,
      browseMode: "webview_window",
      gameName,
      startUrl,
      gamePageUrl: startUrl,
      allowedDomains: source.allowedDomains ?? [],
      captureDownloads: Boolean(source.downloadCaptureRules?.length),
    }, legacy.length));
  }
  return uniqueSourceIds(legacy);
}

export function profileSourceCacheIdentity(profileId: string, source: GameProfileSourceDefinition) {
  return [
    source.provider,
    profileId,
    source.id,
    source.providerSlug ?? "",
    source.providerGameId ?? "",
    source.gameVersion ?? "",
  ].join(":");
}

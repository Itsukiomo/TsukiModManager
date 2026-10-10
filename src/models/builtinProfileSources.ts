import type { GameProfileSourceDefinition } from "./gameProfiles";

const NEXUS_ALLOWED_DOMAINS = [
  "nexusmods.com",
  "www.nexusmods.com",
  "staticdelivery.nexusmods.com",
  "users.nexusmods.com",
];

const MODWORKSHOP_ALLOWED_DOMAINS = [
  "modworkshop.net",
  "www.modworkshop.net",
  "storage.modworkshop.net",
  "api.modworkshop.net",
];

interface NexusSourcePairOptions {
  idPrefix: string;
  gameName: string;
  domain: string;
  numericGameId: string;
  labelSuffix?: string;
}

export function createNexusSourcePair({
  idPrefix,
  gameName,
  domain,
  numericGameId,
  labelSuffix = "",
}: NexusSourcePairOptions): GameProfileSourceDefinition[] {
  const suffix = labelSuffix ? ` - ${labelSuffix}` : "";
  const gamePageUrl = `https://www.nexusmods.com/${domain}`;
  const startUrl = `${gamePageUrl}/mods`;
  const shared = {
    provider: "nexus" as const,
    enabled: true,
    gameName,
    providerSlug: domain,
    providerGameId: numericGameId,
    gamePageUrl,
    listingUrl: startUrl,
    startUrl,
    allowedDomains: NEXUS_ALLOWED_DOMAINS,
    captureDownloads: true,
  };

  return [
    {
      ...shared,
      id: `${idPrefix}-nexus-api`,
      displayName: `Nexus Mods${suffix}`,
      browseMode: "api",
      apiEnabled: true,
      apiKeySource: "Global Settings",
    },
    {
      ...shared,
      id: `${idPrefix}-nexus-browser`,
      displayName: `Nexus Browser${suffix}`,
      browseMode: "webview_window",
      apiEnabled: false,
      apiKeySource: null,
    },
  ];
}

interface ModWorkshopSourcePairOptions {
  idPrefix: string;
  gameName: string;
  slug: string;
  numericGameId: string;
}

export function createModWorkshopSourcePair({
  idPrefix,
  gameName,
  slug,
  numericGameId,
}: ModWorkshopSourcePairOptions): GameProfileSourceDefinition[] {
  const gamePageUrl = `https://modworkshop.net/g/${slug}/mods`;
  const shared = {
    provider: "modworkshop" as const,
    enabled: true,
    gameName,
    providerSlug: slug,
    providerGameId: numericGameId,
    gamePageUrl,
    listingUrl: gamePageUrl,
    startUrl: gamePageUrl,
    allowedDomains: MODWORKSHOP_ALLOWED_DOMAINS,
    captureDownloads: true,
  };

  return [
    {
      ...shared,
      id: `${idPrefix}-modworkshop-api`,
      displayName: "ModWorkshop",
      browseMode: "api",
      apiEnabled: true,
      apiKeySource: null,
    },
    {
      ...shared,
      id: `${idPrefix}-modworkshop-browser`,
      displayName: "ModWorkshop Browser",
      browseMode: "webview_window",
      apiEnabled: false,
      apiKeySource: null,
    },
  ];
}

import borderlands2Cover from "../assets/borderlands-2-profile-cover.png";
import borderlands3Cover from "../assets/borderlands-3-profile-cover.png";
import borderlands4Cover from "../assets/borderlands-4-profile-cover.png";
import borderlandsCover from "../assets/borderlands-profile-cover.png";
import cyberpunk2077Cover from "../assets/cyberpunk-2077-profile-cover.png";
import monsterHunterWildsCover from "../assets/monster-hunter-wilds-profile-cover.png";
import outlastTrialsCover from "../assets/outlast-trials-profile-cover.png";
import payday2Cover from "../assets/payday2-profile-cover.jpg";
import payday3Cover from "../assets/payday3-profile-cover.png";
import paydayTheHeistCover from "../assets/payday-the-heist-profile-cover.png";
import residentEvil7Cover from "../assets/resident-evil-7-profile-cover.png";
import residentEvilRequiemCover from "../assets/resident-evil-requiem-profile-cover.png";
import residentEvilVillageCover from "../assets/resident-evil-village-profile-cover.png";
import spiderMan2Cover from "../assets/spider-man-2-profile-cover.png";
import spiderManRemasteredCover from "../assets/spider-man-remastered-profile-cover.png";
import tinyTinasWonderlandsCover from "../assets/tiny-tinas-wonderlands-profile-cover.png";
import { createModWorkshopSourcePair, createNexusSourcePair } from "./builtinProfileSources";
import { profileImageReferenceFromValue, type ProfileImageReference } from "./profileArtwork";

export type GameProfileType = "builtin_official" | "user_created" | "community" | "promoted_official";
export type GameProfileEditMode = "limited" | "full" | "none";
export type GameProfileLifecycleState = "official" | "draft" | "installed" | "community" | "disabled";
export type GameProfileSetupStatus = "ready" | "incomplete" | "setup_required" | "disabled" | "error";

export interface GameProfileArtwork {
  objectFit?: "cover" | "contain";
  focalX?: number;
  focalY?: number;
  scale?: number;
}

export interface GameProfileInstallation {
  checked: boolean;
  installed: boolean;
  storefront: "steam" | "manual" | null;
  gameRoot: string | null;
  matchedAppId: string | null;
}

export type GameProfileSourceProvider = "modworkshop" | "nexus" | "github" | "custom";
export type GameProfileBrowseMode = "api" | "webview_window" | "external" | "iframe";

export interface GameProfileSourceDefinition {
  gameVersion?: string;
  id: string;
  displayName: string;
  provider: GameProfileSourceProvider;
  enabled: boolean;
  browseMode: GameProfileBrowseMode;
  apiEnabled?: boolean;
  apiKeySource?: string | null;
  gameName?: string | null;
  providerSlug?: string | null;
  providerGameId?: string | null;
  gamePageUrl?: string | null;
  listingUrl?: string | null;
  startUrl?: string | null;
  allowedDomains: string[];
  captureDownloads: boolean;
}

export interface GameProfileSourceConfig {
  sources?: GameProfileSourceDefinition[];
  modworkshopDisplayName?: string;
  modworkshopGameName?: string;
  modworkshopGameId?: string;
  modworkshopSlug?: string;
  modworkshopGamePageUrl?: string;
  modworkshopCategoryUrl?: string;
  modworkshopEmbeddedStartUrl?: string;
  modworkshopAllowedDomains?: string[];
  modworkshopBrowseMode?: string;
  nexusDisplayName?: string;
  nexusGameName?: string;
  nexusDomain?: string;
  nexusGameId?: string;
  nexusGamePageUrl?: string;
  nexusCategoryUrl?: string;
  nexusEmbeddedStartUrl?: string;
  nexusAllowedDomains?: string[];
  nexusBrowseMode?: string;
  nexusApiBaseUrl?: string;
  customBrowser?: boolean;
  customBrowserStartUrl?: string;
  customBrowserAllowedDomains?: string[];
  customBrowserSources?: Array<{
    id?: string;
    sourceType?: string;
    displayName?: string;
    startUrl?: string | null;
    allowedDomains?: string[];
    currentGameUrlPatterns?: string[];
    downloadCaptureRules?: string[];
    authenticationRequirement?: string | null;
    crossGameProtection?: string | null;
  }>;
}

export interface GameProfile {
  profileVersion?: string;
  gameVersion?: string;
  gameVersions?: string[];
  profileId: string;
  gameKey: string;
  displayName: string;
  profileType: GameProfileType;
  profileTypeLabel: string;
  statusLabel: string;
  image: string;
  imageReference?: ProfileImageReference;
  artwork?: GameProfileArtwork;
  steamAppIds?: string[];
  sourceInstallSupport?: "ready" | "pending";
  installation?: GameProfileInstallation;
  isPermanent: boolean;
  isRemovable: boolean;
  editMode: GameProfileEditMode;
  normalUserEditMode?: GameProfileEditMode;
  maintainerEditMode?: GameProfileEditMode;
  allowNormalUserExport?: boolean;
  isDefault?: boolean;
  sourceConfig: GameProfileSourceConfig;
  bundledFallbackTaxonomyKey?: string;
  lifecycleState?: GameProfileLifecycleState;
  setupStatus?: GameProfileSetupStatus;
  setupProgress?: { configured: number; total: number; label: string };
  draft?: unknown;
  draftStoragePath?: string;
  createdAt?: string;
  updatedAt?: string;
}

export const BUILTIN_PAYDAY3_PROFILE_ID = "builtin.payday3";

interface BuiltinCatalogProfile {
  profileId: string;
  gameKey: string;
  displayName: string;
  image: string;
  steamAppIds: string[];
  sourceInstallSupport?: "ready" | "pending";
  artwork?: GameProfileArtwork;
  sourceConfig?: GameProfileSourceConfig;
  bundledFallbackTaxonomyKey?: string;
  isDefault?: boolean;
  setupStatus?: GameProfileSetupStatus;
}

function builtinCatalogProfile(definition: BuiltinCatalogProfile): GameProfile {
  return {
    profileId: definition.profileId,
    gameKey: definition.gameKey,
    displayName: definition.displayName,
    profileVersion: "1.0.0",
    gameVersion: definition.profileId === BUILTIN_PAYDAY3_PROFILE_ID ? "UE5.5" : undefined,
    gameVersions: definition.profileId === BUILTIN_PAYDAY3_PROFILE_ID ? ["UE5.5", "UE4.27"] : undefined,
    profileType: "builtin_official",
    profileTypeLabel: "Built-in / Official",
    statusLabel: definition.setupStatus === "ready" ? "Official" : "Profile setup required",
    image: definition.image,
    imageReference: profileImageReferenceFromValue(definition.image, "bundled"),
    artwork: definition.artwork ?? { objectFit: "cover", focalX: 50, focalY: 40, scale: 1 },
    steamAppIds: definition.steamAppIds,
    sourceInstallSupport: definition.sourceInstallSupport ?? "ready",
    installation: { checked: false, installed: false, storefront: null, gameRoot: null, matchedAppId: null },
    isPermanent: true,
    isRemovable: false,
    editMode: "limited",
    normalUserEditMode: "limited",
    maintainerEditMode: "full",
    allowNormalUserExport: false,
    isDefault: definition.isDefault,
    sourceConfig: definition.sourceConfig ?? {},
    bundledFallbackTaxonomyKey: definition.bundledFallbackTaxonomyKey,
    lifecycleState: "official",
    setupStatus: definition.setupStatus ?? "setup_required",
  };
}

export const BUILTIN_GAME_PROFILES: GameProfile[] = [
  builtinCatalogProfile({
    profileId: "builtin.cyberpunk2077",
    gameKey: "cyberpunk-2077",
    displayName: "Cyberpunk 2077",
    image: cyberpunk2077Cover,
    steamAppIds: ["1091500"],
    artwork: { objectFit: "cover", focalX: 50, focalY: 42, scale: 1 },
    setupStatus: "ready",
    sourceConfig: {
      sources: createNexusSourcePair({ idPrefix: "cyberpunk2077", gameName: "Cyberpunk 2077", domain: "cyberpunk2077", numericGameId: "3333" }),
    },
  }),
  builtinCatalogProfile({
    profileId: "builtin.outlast-trials",
    gameKey: "outlast-trials",
    displayName: "The Outlast Trials",
    image: outlastTrialsCover,
    steamAppIds: ["1304930"],
    setupStatus: "ready",
    sourceConfig: {
      sources: createNexusSourcePair({ idPrefix: "outlast-trials", gameName: "The Outlast Trials", domain: "theoutlasttrials", numericGameId: "5376" }),
    },
  }),
  builtinCatalogProfile({
    profileId: "builtin.payday-the-heist",
    gameKey: "payday-the-heist",
    displayName: "PAYDAY: The Heist",
    image: paydayTheHeistCover,
    steamAppIds: ["24240"],
    setupStatus: "ready",
    sourceConfig: {
      sources: [
        ...createModWorkshopSourcePair({ idPrefix: "payday-the-heist", gameName: "PAYDAY: The Heist", slug: "pdth", numericGameId: "2" }),
        ...createNexusSourcePair({ idPrefix: "payday-the-heist", gameName: "PAYDAY: The Heist", domain: "paydaytheheist", numericGameId: "4339" }),
      ],
    },
  }),
  builtinCatalogProfile({
    profileId: "builtin.payday2",
    gameKey: "payday-2",
    displayName: "PAYDAY 2",
    image: payday2Cover,
    steamAppIds: ["218620"],
    setupStatus: "ready",
    sourceConfig: {
      sources: [
        ...createModWorkshopSourcePair({ idPrefix: "payday2", gameName: "PAYDAY 2", slug: "payday-2", numericGameId: "1" }),
        ...createNexusSourcePair({ idPrefix: "payday2", gameName: "PAYDAY 2", domain: "payday2", numericGameId: "648" }),
      ],
    },
  }),
  builtinCatalogProfile({
    profileId: BUILTIN_PAYDAY3_PROFILE_ID,
    gameKey: "payday3",
    displayName: "PAYDAY 3",
    image: payday3Cover,
    steamAppIds: ["1272080"],
    artwork: { objectFit: "cover", focalX: 50, focalY: 43, scale: 1 },
    isDefault: true,
    setupStatus: "ready",
    sourceInstallSupport: "ready",
    bundledFallbackTaxonomyKey: "payday3",
    sourceConfig: {
      sources: [
        ...createModWorkshopSourcePair({ idPrefix: "payday3", gameName: "PAYDAY 3", slug: "payday-3", numericGameId: "853" }),
        ...createNexusSourcePair({ idPrefix: "payday3", gameName: "PAYDAY 3", domain: "payday3", numericGameId: "5717" }),
      ],
    },
  }),
  builtinCatalogProfile({
    profileId: "builtin.resident-evil-7",
    gameKey: "resident-evil-7",
    displayName: "Resident Evil 7 biohazard",
    image: residentEvil7Cover,
    steamAppIds: ["418370"],
    setupStatus: "ready",
    sourceConfig: { sources: createNexusSourcePair({ idPrefix: "resident-evil-7", gameName: "Resident Evil 7 biohazard", domain: "residentevil7", numericGameId: "3111" }) },
  }),
  builtinCatalogProfile({
    profileId: "builtin.resident-evil-village",
    gameKey: "resident-evil-village",
    displayName: "Resident Evil Village",
    image: residentEvilVillageCover,
    steamAppIds: ["1196590"],
    setupStatus: "ready",
    sourceConfig: { sources: createNexusSourcePair({ idPrefix: "resident-evil-village", gameName: "Resident Evil Village", domain: "residentevilvillage", numericGameId: "3669" }) },
  }),
  builtinCatalogProfile({
    profileId: "builtin.resident-evil-requiem",
    gameKey: "resident-evil-requiem",
    displayName: "Resident Evil Requiem",
    image: residentEvilRequiemCover,
    steamAppIds: ["3764200"],
    setupStatus: "ready",
    sourceConfig: { sources: createNexusSourcePair({ idPrefix: "resident-evil-requiem", gameName: "Resident Evil Requiem", domain: "residentevilrequiem", numericGameId: "8863" }) },
  }),
  builtinCatalogProfile({
    profileId: "builtin.borderlands",
    gameKey: "borderlands",
    displayName: "Borderlands",
    image: borderlandsCover,
    steamAppIds: ["8980", "729040"],
    setupStatus: "ready",
    sourceConfig: {
      sources: [
        ...createNexusSourcePair({
          idPrefix: "borderlands",
          gameName: "Borderlands Game of the Year",
          domain: "borderlands",
          numericGameId: "360",
          labelSuffix: "Classic",
        }),
        ...createNexusSourcePair({
          idPrefix: "borderlands-enhanced",
          gameName: "Borderlands Game of the Year Enhanced",
          domain: "borderlandsgotyenhanced",
          numericGameId: "2776",
          labelSuffix: "Enhanced",
        }),
      ],
    },
  }),
  builtinCatalogProfile({
    profileId: "builtin.borderlands2",
    gameKey: "borderlands-2",
    displayName: "Borderlands 2",
    image: borderlands2Cover,
    steamAppIds: ["49520"],
    setupStatus: "ready",
    sourceConfig: {
      sources: createNexusSourcePair({
        idPrefix: "borderlands2",
        gameName: "Borderlands 2",
        domain: "borderlands2",
        numericGameId: "428",
      }),
    },
  }),
  builtinCatalogProfile({
    profileId: "builtin.borderlands3",
    gameKey: "borderlands-3",
    displayName: "Borderlands 3",
    image: borderlands3Cover,
    steamAppIds: ["397540"],
    setupStatus: "ready",
    sourceConfig: { sources: createNexusSourcePair({ idPrefix: "borderlands3", gameName: "Borderlands 3", domain: "borderlands3", numericGameId: "2953" }) },
  }),
  builtinCatalogProfile({
    profileId: "builtin.borderlands4",
    gameKey: "borderlands-4",
    displayName: "Borderlands 4",
    image: borderlands4Cover,
    steamAppIds: ["1285190"],
    setupStatus: "ready",
    sourceConfig: { sources: createNexusSourcePair({ idPrefix: "borderlands4", gameName: "Borderlands 4", domain: "borderlands4", numericGameId: "8148" }) },
  }),
  builtinCatalogProfile({
    profileId: "builtin.tiny-tinas-wonderlands",
    gameKey: "tiny-tinas-wonderlands",
    displayName: "Tiny Tina's Wonderlands",
    image: tinyTinasWonderlandsCover,
    steamAppIds: ["1286680"],
    setupStatus: "ready",
    sourceConfig: { sources: createNexusSourcePair({ idPrefix: "tiny-tinas-wonderlands", gameName: "Tiny Tina's Wonderlands", domain: "tinytinaswonderlands", numericGameId: "4394" }) },
  }),
  builtinCatalogProfile({
    profileId: "builtin.spider-man-remastered",
    gameKey: "spider-man-remastered",
    displayName: "Marvel's Spider-Man Remastered",
    image: spiderManRemasteredCover,
    steamAppIds: ["1817070"],
    setupStatus: "ready",
    sourceConfig: { sources: createNexusSourcePair({ idPrefix: "spider-man-remastered", gameName: "Marvel's Spider-Man Remastered", domain: "marvelsspidermanremastered", numericGameId: "4536" }) },
  }),
  builtinCatalogProfile({
    profileId: "builtin.spider-man-2",
    gameKey: "spider-man-2",
    displayName: "Marvel's Spider-Man 2",
    image: spiderMan2Cover,
    steamAppIds: ["2651280"],
    setupStatus: "ready",
    sourceConfig: { sources: createNexusSourcePair({ idPrefix: "spider-man-2", gameName: "Marvel's Spider-Man 2", domain: "marvelsspiderman2", numericGameId: "6082" }) },
  }),
  builtinCatalogProfile({
    profileId: "builtin.monster-hunter-wilds",
    gameKey: "monster-hunter-wilds",
    displayName: "Monster Hunter Wilds",
    image: monsterHunterWildsCover,
    steamAppIds: ["2246340"],
    setupStatus: "ready",
    sourceConfig: { sources: createNexusSourcePair({ idPrefix: "monster-hunter-wilds", gameName: "Monster Hunter Wilds", domain: "monsterhunterwilds", numericGameId: "6993" }) },
  }),
];

export const GAME_PROFILES = BUILTIN_GAME_PROFILES;

export function getGameProfile(profileId?: string | null): GameProfile {
  return GAME_PROFILES.find((profile) => profile.profileId === profileId)
    ?? BUILTIN_GAME_PROFILES.find((profile) => profile.isDefault)
    ?? BUILTIN_GAME_PROFILES[0];
}

export function isKnownGameProfile(profileId?: string | null): profileId is string {
  return Boolean(profileId && GAME_PROFILES.some((profile) => profile.profileId === profileId));
}

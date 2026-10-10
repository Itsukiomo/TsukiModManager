import catalogJson from "../data/dependencies.json";
import type { SourceModSummary } from "./source";

export type DependencySourceKind = "nexus" | "modworkshop" | "github" | "official" | "external";

export interface DependencyDefinition {
  id: string;
  name: string;
  description?: string;
  games: string[];
  gameVersions?: string[];
  sourceKind: DependencySourceKind;
  preferredSource?: DependencySourceKind;
  nexus?: { gameDomain: string; numericGameId?: string; modId: string };
  modworkshop?: { numericGameId?: string; modId: string };
  github?: { owner: string; repo: string };
  official?: { canonicalUrl: string };
  external?: { canonicalUrl: string };
  homepageUrl?: string;
  downloadUrl?: string;
  documentationUrl?: string;
  releaseUrl?: string;
  installableByTsuki?: boolean;
  automaticInstallSafe?: boolean;
  managedToolDownload?: boolean;
  thumbnailUrl?: string | null;
  required?: boolean;
  recommended?: boolean;
  optional?: boolean;
  sourceUnverified?: boolean;
  requires?: string[];
  notes?: string;
  versionConstraint?: string;
  dynamic?: boolean;
}

export interface DynamicDependencyInput {
  name: string;
  required?: boolean;
  optional?: boolean;
  sourceKind?: DependencySourceKind;
  gameDomain?: string;
  numericGameId?: string;
  modId?: string;
  url?: string;
  notes?: string;
  versionConstraint?: string;
  thumbnailUrl?: string | null;
}

const managedDependencyIds = new Set([
  "pd2-superblt-x64", "pd2-beardlib", "pd2-legendary-armour-skins", "pdth-mod-overrides", "pd3-ue5-ue4ss-allow-pak",
  "borderlands-willow1-classic", "borderlands-willow1-enhanced", "borderlands2-willow2",
  "borderlands3-oak", "borderlands4-oak2", "borderlands-plugin-loader", "borderlands-open-hotfix-loader",
  "re-reframework", "mhw-reframework-nexus", "mhw-catlib",
]);
export const DEPENDENCY_CATALOG: DependencyDefinition[] = (catalogJson as DependencyDefinition[]).map((dependency) => {
  const managed = managedDependencyIds.has(dependency.id) || (dependency.id.startsWith("cyberpunk-") && Boolean(dependency.nexus));
  const managedToolDownload = ["outlast-iris", "outlast-janus", "outlast-odessa", "re-fluffy-mod-manager", "spiderman-overstrike-remastered", "borderlands2-openblcmm"].includes(dependency.id);
  return { ...dependency, managedToolDownload, ...(managed ? { installableByTsuki: true, automaticInstallSafe: true } : {}) };
});

function normalizeIdentity(value?: string | null) {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const aliases: Record<string, string> = {
  cet: "cyberpunk-cet",
  cyberenginetweaks: "cyberpunk-cet",
  red4ext: "cyberpunk-red4ext",
  redscript: "cyberpunk-redscript",
  archivexl: "cyberpunk-archivexl",
  tweakxl: "cyberpunk-tweakxl",
  codeware: "cyberpunk-codeware",
  nativesettingsui: "cyberpunk-native-settings-ui",
  inputloader: "cyberpunk-input-loader",
  modsettings: "cyberpunk-mod-settings",
  equipmentex: "cyberpunk-equipment-ex",
  virtualatelier: "cyberpunk-virtual-atelier",
  appearancemenumod: "cyberpunk-appearance-menu-mod",
  redmod: "cyberpunk-redmod",
  iris: "outlast-iris",
  janus: "outlast-janus",
  odessa: "outlast-odessa",
  pdthmodoverrides: "pdth-mod-overrides",
  dahm: "pdth-dahm",
  dorhud: "pdth-dahm",
  dahmdorhud: "pdth-dahm",
  beardlib: "pd2-beardlib",
  las: "pd2-legendary-armour-skins",
  legendaryarmourskins: "pd2-legendary-armour-skins",
  legendaryarmorskins: "pd2-legendary-armour-skins",
  superblt: "pd2-superblt-x64",
  pd3logicmodloader: "pd3-logic-mod-loader",
  logicmodloader: "pd3-logic-mod-loader",
  ue4ss: "pd3-ue4ss",
  allowmods: "pd3-allowmods",
  allowmodsmod: "pd3-allowmods",
  reframework: "re-reframework",
  fluffymodmanager: "re-fluffy-mod-manager",
  fluffy: "re-fluffy-mod-manager",
  willow1modmanager: "borderlands-willow1-classic",
  willow1modmanagerpythonsdk: "borderlands-willow1-classic",
  willow2modmanager: "borderlands2-willow2",
  willow2modmanagerpythonsdk: "borderlands2-willow2",
  pythonsdk: "borderlands2-willow2",
  openblcmm: "borderlands2-openblcmm",
  oakmodmanager: "borderlands3-oak",
  pluginloader: "borderlands-plugin-loader",
  bl3dx11injection: "borderlands-plugin-loader",
  pluginloaderbl3dx11injection: "borderlands-plugin-loader",
  openhotfixloader: "borderlands-open-hotfix-loader",
  oak2modmanager: "borderlands4-oak2",
  bl4live: "borderlands4-live",
  overstrike: "spiderman-overstrike-remastered",
  netdesktopruntime: "microsoft-dotnet-desktop-runtime",
  catlib: "mhw-catlib",
};

export function getDependencyPrimaryUrl(dep: DependencyDefinition): string | null {
  const preferred = dep.preferredSource ?? dep.sourceKind;
  if (preferred === "nexus" && dep.nexus) return `https://www.nexusmods.com/${dep.nexus.gameDomain}/mods/${dep.nexus.modId}`;
  if (preferred === "modworkshop" && dep.modworkshop) return `https://modworkshop.net/mod/${dep.modworkshop.modId}`;
  if (preferred === "github" && dep.github) return `https://github.com/${dep.github.owner}/${dep.github.repo}`;
  if (preferred === "official" && dep.official?.canonicalUrl) return dep.official.canonicalUrl;
  if (preferred === "external" && dep.external?.canonicalUrl) return dep.external.canonicalUrl;
  if (dep.nexus) return `https://www.nexusmods.com/${dep.nexus.gameDomain}/mods/${dep.nexus.modId}`;
  if (dep.modworkshop) return `https://modworkshop.net/mod/${dep.modworkshop.modId}`;
  if (dep.github) return `https://github.com/${dep.github.owner}/${dep.github.repo}`;
  return dep.official?.canonicalUrl ?? dep.external?.canonicalUrl ?? dep.homepageUrl ?? null;
}

export function getDependencyDownloadUrl(dep: DependencyDefinition): string | null {
  return dep.downloadUrl ?? dep.releaseUrl ?? getDependencyPrimaryUrl(dep);
}

export function getDependencyDocumentationUrl(dep: DependencyDefinition): string | null {
  return dep.documentationUrl ?? dep.homepageUrl ?? getDependencyPrimaryUrl(dep);
}

export function dependencySourceLabel(dep: DependencyDefinition) {
  const source = dep.preferredSource ?? dep.sourceKind;
  if (source === "nexus") return "Nexus Mods";
  if (source === "modworkshop") return "ModWorkshop";
  if (source === "github") return "GitHub";
  return source === "official" ? "Official" : dep.sourceUnverified ? "Source not verified" : "External";
}

export function dependenciesForProfile(profileId?: string | null, gameVersion?: string | null) {
  const version = gameVersion ?? (profileId === "builtin.payday3" ? "UE5.5" : null);
  return profileId ? DEPENDENCY_CATALOG.filter((dep) => dep.games.includes(profileId) && (!dep.gameVersions?.length || !version || dep.gameVersions.includes(version))) : [];
}

export function findDependency(value: string, profileId?: string | null, gameVersion?: string | null): DependencyDefinition | null {
  const normalized = normalizeIdentity(value);
  const candidates = profileId ? dependenciesForProfile(profileId, gameVersion) : DEPENDENCY_CATALOG;
  if (profileId === "builtin.payday3" && (gameVersion ?? "UE5.5") === "UE5.5"
      && ["ue4ss", "allowmods", "allowmodsmod", "payday3ue5ue4ss", "ue5pakenablement", "ue5allowmodsmod", "ue5dwmapiproxy"].includes(normalized)) {
    return candidates.find((dep) => dep.id === "pd3-ue5-ue4ss-allow-pak") ?? null;
  }
  const exact = candidates.find((dep) => dep.id === value || normalizeIdentity(dep.name) === normalized);
  if (exact) return exact;
  const aliasId = aliases[normalized];
  if (aliasId) {
    const alias = candidates.find((dep) => dep.id === aliasId);
    if (alias && (!profileId || alias.games.includes(profileId))) return alias;
  }
  return null;
}

export function enrichDependency(input: DynamicDependencyInput, profileId?: string | null): DependencyDefinition {
  const bySource = DEPENDENCY_CATALOG.find((dep) => {
    if (profileId && !dep.games.includes(profileId)) return false;
    if (input.sourceKind === "nexus" && input.modId && dep.nexus) return dep.nexus.modId === input.modId && (!input.gameDomain || dep.nexus.gameDomain === input.gameDomain);
    if (input.sourceKind === "modworkshop" && input.modId && dep.modworkshop) return dep.modworkshop.modId === input.modId;
    return false;
  });
  const known = bySource ?? findDependency(input.name, profileId);
  if (known) {
    const enriched = {
      ...known,
      required: input.required ?? known.required,
      optional: input.optional ?? known.optional,
      notes: input.notes ?? known.notes,
      versionConstraint: input.versionConstraint ?? known.versionConstraint,
      thumbnailUrl: input.thumbnailUrl ?? known.thumbnailUrl,
    };
    if (input.url && !getDependencyPrimaryUrl(enriched)) {
      return { ...enriched, sourceKind: "external", preferredSource: "external", external: { canonicalUrl: input.url }, sourceUnverified: false };
    }
    return enriched;
  }

  const sourceKind = input.sourceKind ?? (input.url ? "external" : "external");
  return {
    id: `dynamic-${normalizeIdentity(input.name) || "dependency"}-${normalizeIdentity(input.modId ?? input.url)}`,
    name: input.name,
    description: input.notes,
    games: profileId ? [profileId] : [],
    sourceKind,
    preferredSource: sourceKind,
    nexus: sourceKind === "nexus" && input.gameDomain && input.modId ? { gameDomain: input.gameDomain, numericGameId: input.numericGameId, modId: input.modId } : undefined,
    modworkshop: sourceKind === "modworkshop" && input.modId ? { numericGameId: input.numericGameId, modId: input.modId } : undefined,
    external: input.url ? { canonicalUrl: input.url } : undefined,
    required: input.required ?? !input.optional,
    optional: input.optional ?? false,
    recommended: false,
    sourceUnverified: !input.url && !input.modId,
    installableByTsuki: false,
    automaticInstallSafe: false,
    notes: input.notes,
    versionConstraint: input.versionConstraint,
    dynamic: true,
    thumbnailUrl: input.thumbnailUrl,
  };
}

export function migrateDependencyNames(names: string[], profileId?: string | null) {
  return names.map((name) => findDependency(name, profileId) ?? enrichDependency({ name }, profileId));
}

export interface DependencyGraphNode {
  dependency: DependencyDefinition;
  children: DependencyGraphNode[];
}

export function buildDependencyGraph(dependencies: DependencyDefinition[]): DependencyGraphNode[] {
  const available = new Map(DEPENDENCY_CATALOG.map((dep) => [dep.id, dep]));
  dependencies.forEach((dep) => available.set(dep.id, dep));
  const expanded = new Set<string>();
  const visit = (dep: DependencyDefinition, stack: Set<string>): DependencyGraphNode => {
    if (stack.has(dep.id)) return { dependency: dep, children: [] };
    const nextStack = new Set(stack).add(dep.id);
    return { dependency: dep, children: (dep.requires ?? []).map((id) => available.get(id)).filter((item): item is DependencyDefinition => Boolean(item)).map((item) => visit(item, nextStack)) };
  };
  const roots = dependencies.filter((dep) => {
    if (expanded.has(dep.id)) return false;
    expanded.add(dep.id);
    return true;
  });
  return roots.map((dep) => visit(dep, new Set()));
}

export function dependencyToSourceSummary(dep: DependencyDefinition): SourceModSummary | null {
  if (dep.nexus && (dep.preferredSource ?? dep.sourceKind) === "nexus") {
    return { source: "nexus", sourceId: dep.nexus.modId, gameId: dep.nexus.gameDomain, name: dep.name, pageUrl: getDependencyPrimaryUrl(dep), shortDescription: dep.description, tags: ["Dependency", "Nexus"] };
  }
  if (dep.modworkshop && (dep.preferredSource ?? dep.sourceKind) === "modworkshop") {
    return { source: "modworkshop", sourceId: dep.modworkshop.modId, gameId: dep.modworkshop.numericGameId, name: dep.name, pageUrl: getDependencyPrimaryUrl(dep), shortDescription: dep.description, tags: ["Dependency", "ModWorkshop"] };
  }
  return null;
}

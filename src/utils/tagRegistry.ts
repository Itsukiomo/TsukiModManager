export type TagSource = "modworkshop" | "nexus" | "custom" | "system" | "discovered";
export type TagType = "category" | "descriptive" | "custom" | "system" | "source";

export interface TagDefinition {
  id: string;
  key: string;
  canonicalKey: string;
  label: string;
  source: TagSource;
  gameId: string;
  type: TagType;
  sourceId?: string | null;
  aliases?: string[];
  discoveredAt?: number;
}

const FALLBACK_GAME_ID = "payday3";
const TAG_CACHE_VERSION = "v2.2-authoritative-taxonomy";
const CACHE_PREFIX = `tsuki-tag-registry:${TAG_CACHE_VERSION}`;

const FALLBACK_PAYDAY3_NEXUS_CATEGORIES = ["Audio", "Miscellaneous", "Phone Screens", "UI", "Vehicles"];
const FALLBACK_PAYDAY3_MODWORKSHOP_CATEGORIES = ["Audio", "Characters", "Custom Heists", "Equipment", "Interface", "Libraries", "Masks", "Misc", "Music", "Pickups", "Resources", "Tools", "Weapons", "World"];
const FALLBACK_PAYDAY3_MODWORKSHOP_TAGS = ["Add-on", "Add-on Heisters", "Add-on Weapon Mods", "AI-Generated", "Anime", "Audio", "Bugfix", "Client-side", "Custom Model", "Enemies", "Feedback Needed", "Fun", "Gameplay Changing", "Heisters", "HUD", "Instrumental", "Lorefriendly", "PAK Mod", "Quality of Life", "Retexture", "Self-updating", "Weapon Mods", "Work In Progress"];


const REJECTED_LABEL_KEYS = new Set([
  "matched by sha256", "matched by receipt", "unknown mod", "local", "enabled", "disabled", "txt", "ini", "lua", "bk2", "7z", "rar",
]);

export function rejectedTaxonomyLabelReason(label: string) {
  const trimmed = String(label ?? "").trim();
  const key = normalizeTagName(trimmed);
  if (!trimmed || !key) return "empty label";
  if (REJECTED_LABEL_KEYS.has(key)) return "reserved/system label";
  if (/\.(zip|rar|7z|txt|bk2|pak|dll|ini|lua|json|exe)$/i.test(trimmed)) return "filename/archive extension";
  if (/^[a-z]:\\/i.test(trimmed) || trimmed.includes("\\")) return "windows path";
  if (trimmed.includes("/") && /\.(zip|rar|7z|txt|bk2|pak|dll|ini|lua|json|exe)$/i.test(trimmed.split("/").pop() ?? "")) return "path-like value";
  return null;
}
export const SYSTEM_BADGE_KEYS = new Set([
  "payday 3", "payday3", "pd3", "local", "unknown", "matched", "manual match", "enabled", "disabled", "pak", "ue4ss", "win64", "modworkshop", "mod workshop", "nexus", "nexus mods", "mods", "mod", "installed", "off", "on", "receipt", "tsuki installed",
]);

const SEMANTIC_COLORS: Record<string, string> = {
  audio: "#0891b2",
  music: "#4f46e5",
  instrumental: "#0284c7",
  ui: "#2563eb",
  interface: "#1d4ed8",
  "phone screens": "#06b6d4",
  characters: "#e11d48",
  masks: "#c026d3",
  retexture: "#db2777",
  anime: "#a21caf",
  "custom model": "#7c3aed",
  "gameplay changing": "#ea580c",
  "quality of life": "#16a34a",
  bugfix: "#059669",
  "custom heists": "#d97706",
  libraries: "#475569",
  "pak mod": "#0d9488",
  "self updating": "#0e7490",
  "self-updating": "#0e7490",
  equipment: "#ca8a04",
  vehicles: "#dc2626",
  "work in progress": "#eab308",
  "feedback needed": "#a16207",
  "ai generated": "#8b5cf6",
  "ai-generated": "#8b5cf6",
  misc: "#64748b",
  miscellaneous: "#64748b",
};

const TAG_PALETTE = [
  "#06b6d4", "#14b8a6", "#10b981", "#22c55e", "#84cc16", "#d9f99d", "#eab308", "#f59e0b",
  "#f97316", "#fb7185", "#ef4444", "#e11d48", "#ec4899", "#d946ef", "#8b5cf6", "#6366f1",
  "#3b82f6", "#0ea5e9", "#67e8f9", "#5eead4", "#a7f3d0", "#facc15", "#b45309", "#c4b5fd",
  "#64748b", "#4682b4", "#2dd4bf", "#be123c", "#fdba74", "#a3e635", "#818cf8", "#2e8b57",
  "#e34234", "#da70d6", "#0891b2", "#0f766e", "#047857", "#15803d", "#65a30d", "#ca8a04",
  "#d97706", "#c2410c", "#b91c1c", "#9f1239", "#be185d", "#a21caf", "#7c3aed", "#4338ca",
  "#1d4ed8", "#0369a1", "#0e7490", "#0d9488", "#059669", "#4d7c0f", "#a16207", "#92400e",
  "#9d174d", "#86198f", "#6d28d9", "#3730a3", "#1e40af", "#075985", "#155e75", "#115e59",
];
export function normalizeTagName(value: string) {
  return String(value ?? "").trim().toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

export function normalizeGameId(value?: string | null) {
  const key = normalizeTagName(value || FALLBACK_GAME_ID).replace(/\s+/g, "-");
  if (["payday-3", "payday 3", "payday3", "pd3"].includes(key)) return "payday3";
  return key || FALLBACK_GAME_ID;
}

function titleCaseLabel(value: string) {
  return value.trim().replace(/\s+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()).replace(/\bOf\b/g, "of");
}

export function tagCanonicalKey(input: Pick<TagDefinition, "source" | "type" | "label"> & { gameId?: string | null; sourceId?: string | null }) {
  return [normalizeGameId(input.gameId), input.source, input.type, input.sourceId ? `id:${String(input.sourceId).toLowerCase()}` : normalizeTagName(input.label)].join(":");
}

function makeTag(input: { label: string; source: TagSource; type: TagType; gameId?: string | null; sourceId?: string | null; aliases?: string[] }): TagDefinition {
  const label = titleCaseLabel(input.label);
  const gameId = normalizeGameId(input.gameId);
  const canonicalKey = tagCanonicalKey({ ...input, label, gameId });
  return { id: canonicalKey, key: canonicalKey, canonicalKey, source: input.source, type: input.type, gameId, sourceId: input.sourceId ?? null, label, aliases: input.aliases, discoveredAt: Date.now() };
}

export function seedTagCatalog(gameId = FALLBACK_GAME_ID): TagDefinition[] {
  if (normalizeGameId(gameId) !== "payday3") return [];
  return [
    ...FALLBACK_PAYDAY3_MODWORKSHOP_CATEGORIES.map((label) => makeTag({ source: "modworkshop", type: "category", label, gameId })),
    ...FALLBACK_PAYDAY3_MODWORKSHOP_TAGS.map((label) => makeTag({ source: "modworkshop", type: "descriptive", label, gameId })),
    ...FALLBACK_PAYDAY3_NEXUS_CATEGORIES.map((label) => makeTag({ source: "nexus", type: "category", label, gameId })),
  ];
}

export function isSystemBadgeTag(label: string) {
  const key = normalizeTagName(label);
  if (!key || SYSTEM_BADGE_KEYS.has(key)) return true;
  if (/^\d+ files?$/.test(key)) return true;
  if (/^(~?mods|content|paks|binaries|win64)$/.test(key)) return true;
  if (/\.(pak|utoc|ucas|dll|lua|json|ini)$/.test(label.toLowerCase())) return true;
  if (/^[a-z]:\\/i.test(label) || label.includes("\\") || label.includes("/")) return true;
  return false;
}

export function customTagDefinition(label: string, gameId = "global"): TagDefinition {
  return makeTag({ source: "custom", type: "custom", label, gameId: gameId || "global" });
}

export function systemTagDefinition(label: string, gameId = FALLBACK_GAME_ID): TagDefinition | null {
  const clean = titleCaseLabel(label);
  if (!clean) return null;
  return makeTag({ source: "system", type: "system", label: clean, gameId });
}

export function sourceCategoryDefinition(label: string, source: Extract<TagSource, "modworkshop" | "nexus">, gameId = FALLBACK_GAME_ID, sourceId?: string | null): TagDefinition | null {
  const clean = titleCaseLabel(label);
  if (!clean || isSystemBadgeTag(clean) || rejectedTaxonomyLabelReason(clean)) return null;
  return makeTag({ source, type: "category", label: clean, gameId, sourceId });
}

export function discoveredTagDefinition(label: string, source: TagSource | "unknown" = "discovered", type: TagType = "source", gameId = FALLBACK_GAME_ID, sourceId?: string | null): TagDefinition | null {
  const clean = titleCaseLabel(label);
  if (!clean || isSystemBadgeTag(clean) || rejectedTaxonomyLabelReason(clean)) return null;
  const safeSource: TagSource = source === "unknown" ? "discovered" : source;
  const safeType: TagType = type === "source" && (safeSource === "modworkshop" || safeSource === "nexus") ? "descriptive" : type;
  return makeTag({ source: safeSource, type: safeType, label: clean, gameId, sourceId });
}

export function mergeTagDefinitions(...groups: Array<Array<TagDefinition | null | undefined>>) {
  const merged = new Map<string, TagDefinition>();
  for (const group of groups) {
    for (const tag of group) {
      if (!tag) continue;
      const normalized = makeTag({ source: tag.source, type: tag.type, label: tag.label, gameId: tag.gameId, sourceId: tag.sourceId, aliases: tag.aliases });
      const key = tag.canonicalKey || tag.key || normalized.canonicalKey;
      merged.set(key, { ...normalized, ...tag, id: key, key, canonicalKey: key });
    }
  }
  return [...merged.values()].sort((a, b) => groupRank(a) - groupRank(b) || a.label.localeCompare(b.label) || a.source.localeCompare(b.source));
}

function groupRank(tag: TagDefinition) {
  if (tag.source === "modworkshop" && tag.type === "category") return 0;
  if (tag.source === "modworkshop") return 1;
  if (tag.source === "nexus" && tag.type === "category") return 2;
  if (tag.source === "nexus") return 3;
  if (tag.source === "custom") return 4;
  if (tag.source === "system") return 5;
  return 6;
}

export function tagDisplayLabel(tag: TagDefinition, catalog: TagDefinition[] = []) {
  const duplicateLabel = catalog.some((other) => other.id !== tag.id && normalizeTagName(other.label) === normalizeTagName(tag.label));
  if (!duplicateLabel) return tag.label;
  return `${tag.label} - ${tagSourceLabel(tag.source)} ${tagTypeLabel(tag.type)}`;
}

export function tagSourceLabel(source: TagSource) {
  if (source === "modworkshop") return "ModWorkshop";
  if (source === "nexus") return "Nexus";
  if (source === "custom") return "Custom";
  if (source === "system") return "System";
  return "Discovered";
}

export function tagTypeLabel(type: TagType) {
  if (type === "category") return "Category";
  if (type === "descriptive") return "Tag";
  if (type === "custom") return "Tag";
  if (type === "system") return "Badge";
  return "Tag";
}

export function tagGroupLabel(tag: TagDefinition) {
  if (tag.source === "modworkshop" && tag.type === "category") return "MODWORKSHOP CATEGORIES";
  if (tag.source === "modworkshop") return "MODWORKSHOP TAGS";
  if (tag.source === "nexus" && tag.type === "category") return "NEXUS CATEGORIES";
  if (tag.source === "nexus") return "NEXUS TAGS";
  if (tag.source === "custom") return "CUSTOM TAGS";
  if (tag.source === "system") return "SYSTEM BADGES";
  return "DISCOVERED TAGS";
}

export function tagMatchesQuery(tag: TagDefinition, query: string) {
  const normalized = normalizeTagName(query);
  if (!normalized) return true;
  const haystack = [tag.label, tag.source, tag.type, tag.sourceId ?? "", tag.gameId, ...(tag.aliases ?? [])].map(normalizeTagName);
  return haystack.some((item) => item === normalized || item.startsWith(normalized) || item.split(" ").some((word) => word.startsWith(normalized)) || item.includes(normalized));
}

export function rankTags(tags: TagDefinition[], query: string) {
  const normalized = normalizeTagName(query);
  if (!normalized) return tags;
  function score(tag: TagDefinition) {
    const values = [tag.label, tag.sourceId ?? "", ...(tag.aliases ?? [])].map(normalizeTagName);
    if (values.some((value) => value === normalized)) return 0;
    if (values.some((value) => value.startsWith(normalized))) return 1;
    if (values.some((value) => value.split(" ").some((word) => word.startsWith(normalized)))) return 2;
    if (values.some((value) => value.includes(normalized))) return 3;
    return 9;
  }
  return [...tags].sort((a, b) => score(a) - score(b) || groupRank(a) - groupRank(b) || a.label.localeCompare(b.label));
}

export function tagColorClass(_tag: string | TagDefinition) {
  return "tag-color-dynamic";
}

export function tagColorStyle(tag: string | TagDefinition, catalog: Array<string | TagDefinition> = []): Record<string, string> {
  const definition = typeof tag === "string" ? discoveredTagDefinition(tag) : tag;
  const key = colorIdentityKey(definition, tag);
  const base = colorForTag(definition, key, catalog);
  const selected = mixHex(base, "#ffffff", 0.52);
  return {
    "--tag-bg": mixHex(base, "#020617", 0.27),
    "--tag-border": mixHex(base, "#ffffff", 0.48),
    "--tag-fg": mixHex(base, "#ffffff", 0.86),
    "--tag-selected-bg": mixHex(base, "#020617", 0.62),
    "--tag-selected-border": selected,
    "--tag-selected-fg": "#ffffff",
    backgroundColor: "var(--tag-bg)",
    borderColor: "var(--tag-border)",
    color: "var(--tag-fg)",
  };
}

function colorIdentityKey(definition: TagDefinition | null, fallback: string | TagDefinition) {
  if (!definition) return normalizeTagName(String(fallback));
  return [definition.source, definition.gameId, definition.type, definition.sourceId ?? "", normalizeTagName(definition.label)].join(":");
}

function colorForTag(definition: TagDefinition | null, key: string, catalog: Array<string | TagDefinition>) {
  const semantic = definition ? SEMANTIC_COLORS[normalizeTagName(definition.label)] : null;
  if (semantic && !catalog.some((item) => {
    const other = typeof item === "string" ? discoveredTagDefinition(item) : item;
    return other?.id !== definition?.id && SEMANTIC_COLORS[normalizeTagName(other?.label ?? "")] === semantic;
  })) {
    return semantic;
  }

  if (!catalog.length || !definition) return TAG_PALETTE[hashTag(key) % TAG_PALETTE.length];

  const sorted = mergeTagDefinitions(catalog.map((item) => typeof item === "string" ? discoveredTagDefinition(item) : item)).sort((a, b) => colorIdentityKey(a, a).localeCompare(colorIdentityKey(b, b)));
  const assigned = new Map<string, string>();
  const used = new Set<number>();

  for (const item of sorted) {
    const itemKey = colorIdentityKey(item, item);
    const preferred = hashTag(itemKey) % TAG_PALETTE.length;
    const stride = 1 + (hashTag(`${itemKey}:stride`) % (TAG_PALETTE.length - 1));
    let slot = preferred;
    let attempts = 0;
    while (used.has(slot) && attempts < TAG_PALETTE.length) {
      slot = (slot + stride) % TAG_PALETTE.length;
      attempts += 1;
    }

    if (attempts < TAG_PALETTE.length) {
      used.add(slot);
      assigned.set(itemKey, TAG_PALETTE[slot]);
    } else {
      const rank = sorted.findIndex((candidate) => colorIdentityKey(candidate, candidate) === itemKey);
      assigned.set(itemKey, generatedOverflowColor(itemKey, Math.max(0, rank)));
    }
  }

  return assigned.get(key) ?? TAG_PALETTE[hashTag(key) % TAG_PALETTE.length];
}

function generatedOverflowColor(key: string, rank: number) {
  const hue = (hashTag(key) + rank * 137) % 360;
  const saturation = 62 + (rank % 4) * 7;
  const lightness = 42 + (Math.floor(rank / 4) % 5) * 5;
  return hslToHex(hue, Math.min(saturation, 86), Math.min(lightness, 62));
}
export function tagCacheKey(gameId: string) {
  return `${CACHE_PREFIX}:${normalizeGameId(gameId)}`;
}

export function readCachedTagCatalog(gameId: string): TagDefinition[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(tagCacheKey(gameId)) ?? "null") as { tags?: TagDefinition[] } | null;
    if (!parsed || !Array.isArray(parsed.tags)) return [];
    return mergeTagDefinitions(parsed.tags);
  } catch {
    return [];
  }
}

export function writeCachedTagCatalog(gameId: string, tags: TagDefinition[]) {
  try {
    window.localStorage.setItem(tagCacheKey(gameId), JSON.stringify({ version: TAG_CACHE_VERSION, gameId: normalizeGameId(gameId), savedAt: Date.now(), tags: mergeTagDefinitions(tags) }));
  } catch {
    // Tag cache is optional.
  }
}

function hashTag(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function mixHex(hex: string, target: string, amount: number) {
  const source = parseHex(hex);
  const dest = parseHex(target);
  const mixed = source.map((channel, index) => Math.round(channel * amount + dest[index] * (1 - amount)));
  return `rgb(${mixed[0]} ${mixed[1]} ${mixed[2]})`;
}


function hslToHex(hue: number, saturation: number, lightness: number) {
  const s = saturation / 100;
  const l = lightness / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0]
    : hue < 120 ? [x, c, 0]
    : hue < 180 ? [0, c, x]
    : hue < 240 ? [0, x, c]
    : hue < 300 ? [x, 0, c]
    : [c, 0, x];
  return `#${[r, g, b].map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}
function parseHex(hex: string) {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((char) => char + char).join("") : clean;
  return [0, 2, 4].map((index) => parseInt(full.slice(index, index + 2), 16));
}
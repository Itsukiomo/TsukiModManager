import type { SourceCategory } from "../models/source";

export const CATEGORY_CACHE_VERSION = "v2.0.1-modworkshop-categories";
export const CATEGORY_CACHE_TTL_MS = 1000 * 60 * 60;

export interface ModWorkshopCategoryCacheEntry {
  categories: SourceCategory[];
  savedAt: number;
  stale: boolean;
  key: string;
}

export function modWorkshopCategoryCacheKey(profileId: string, sourceGameKey: string) {
  return [
    "tsuki-source-categories",
    CATEGORY_CACHE_VERSION,
    profileId || "unknown-profile",
    "modworkshop",
    sourceGameKey || "unknown-game",
  ].join(":");
}

function cleanCategories(categories: unknown): SourceCategory[] {
  if (!Array.isArray(categories)) return [];
  return categories
    .map((category) => {
      if (!category || typeof category !== "object" || Array.isArray(category)) return null;
      const record = category as Record<string, unknown>;
      const id = String(record.id ?? "").trim();
      const label = String(record.label ?? record.name ?? "").trim();
      return id && label ? { id, label } : null;
    })
    .filter((category): category is SourceCategory => Boolean(category));
}

export function readModWorkshopCategoryCacheEntry(profileId: string, sourceGameKey: string): ModWorkshopCategoryCacheEntry | null {
  if (typeof window === "undefined") return null;
  const key = modWorkshopCategoryCacheKey(profileId, sourceGameKey);

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { version?: string; savedAt?: number; categories?: unknown };
    if (parsed.version !== CATEGORY_CACHE_VERSION) return null;
    const categories = cleanCategories(parsed.categories);
    if (categories.length === 0) return null;
    const savedAt = typeof parsed.savedAt === "number" ? parsed.savedAt : 0;
    return {
      categories,
      savedAt,
      stale: Date.now() - savedAt > CATEGORY_CACHE_TTL_MS,
      key,
    };
  } catch {
    return null;
  }
}

export function readModWorkshopCategoryCache(profileId: string, sourceGameKey: string): SourceCategory[] {
  return readModWorkshopCategoryCacheEntry(profileId, sourceGameKey)?.categories ?? [];
}

export function writeModWorkshopCategoryCache(profileId: string, sourceGameKey: string, categories: SourceCategory[]) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      modWorkshopCategoryCacheKey(profileId, sourceGameKey),
      JSON.stringify({ version: CATEGORY_CACHE_VERSION, savedAt: Date.now(), categories: cleanCategories(categories) }),
    );
  } catch {
    // Category cache is optional.
  }
}

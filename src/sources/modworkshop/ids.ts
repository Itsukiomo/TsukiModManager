export function normalizeModWorkshopId(value: unknown): string | null {
  if (value == null) return null;

  const trimmed = String(value).trim();

  if (trimmed === "") return null;
  if (trimmed.toLowerCase() === "undefined") return null;
  if (trimmed.toLowerCase() === "null") return null;

  return trimmed;
}

export function requireModWorkshopId(value: unknown, label: string): string {
  const normalized = normalizeModWorkshopId(value);

  if (!normalized) {
    throw new Error(`Missing or invalid ModWorkshop ${label}`);
  }

  return normalized;
}

export function buildModWorkshopModKey(gameId: unknown, modId: unknown): string {
  const safeGameId = requireModWorkshopId(gameId, "gameId");
  const safeModId = requireModWorkshopId(modId, "modId");

  return `modworkshop:${safeGameId}:${safeModId}`;
}

export function buildModWorkshopFileKey(gameId: unknown, modId: unknown, fileId: unknown): string {
  const safeGameId = requireModWorkshopId(gameId, "gameId");
  const safeModId = requireModWorkshopId(modId, "modId");
  const safeFileId = requireModWorkshopId(fileId, "fileId");

  return `modworkshop:${safeGameId}:${safeModId}:${safeFileId}`;
}

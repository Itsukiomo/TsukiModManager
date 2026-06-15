export function normalizeNexusId(value: unknown): string | null {
  if (value == null) return null;

  const trimmed = String(value).trim();

  if (trimmed === "") return null;
  if (trimmed.toLowerCase() === "undefined") return null;
  if (trimmed.toLowerCase() === "null") return null;

  return trimmed;
}

export function requireNexusId(value: unknown, label: string): string {
  const normalized = normalizeNexusId(value);

  if (!normalized) {
    throw new Error(`Missing or invalid Nexus ${label}`);
  }

  return normalized;
}

export function buildNexusModKey(gameId: unknown, modId: unknown): string {
  const safeGameId = requireNexusId(gameId, "gameId");
  const safeModId = requireNexusId(modId, "modId");

  return `nexus:${safeGameId}:${safeModId}`;
}

export function buildNexusFileKey(gameId: unknown, modId: unknown, fileId: unknown): string {
  const safeGameId = requireNexusId(gameId, "gameId");
  const safeModId = requireNexusId(modId, "modId");
  const safeFileId = requireNexusId(fileId, "fileId");

  return `nexus:${safeGameId}:${safeModId}:${safeFileId}`;
}

function cleanBrowsePart(value: unknown): string {
  const normalized = normalizeNexusId(value);
  return normalized ? encodeURIComponent(normalized.toLowerCase()) : "";
}

export function buildNexusBrowseKey(parts: {
  gameDomainName: string;
  query?: string | null;
  sort?: string | null;
  category?: string | null;
  offset?: number;
  count?: number;
}): string {
  const gameDomainName = requireNexusId(parts.gameDomainName, "gameDomainName").toLowerCase();

  return [
    "nexus-browse",
    encodeURIComponent(gameDomainName),
    cleanBrowsePart(parts.query),
    cleanBrowsePart(parts.sort),
    cleanBrowsePart(parts.category),
    String(parts.offset ?? 0),
    String(parts.count ?? 24),
  ].join(":");
}

export interface InstalledThumbnailCandidates {
  receiptThumbnail?: string | null;
  exactSourceThumbnail?: string | null;
  manualThumbnail?: string | null;
  cachedSourceThumbnail?: string | null;
}

function cleanUrl(value?: string | null) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function resolveInstalledThumbnailUrl(
  candidates: InstalledThumbnailCandidates,
  canUse: (url: string) => boolean = () => true,
) {
  const ordered = [
    candidates.receiptThumbnail,
    candidates.exactSourceThumbnail,
    candidates.manualThumbnail,
    candidates.cachedSourceThumbnail,
  ];

  for (const candidate of ordered) {
    const url = cleanUrl(candidate);
    if (url && canUse(url)) return url;
  }

  return null;
}

export function installedSourceFallbackLabel(source?: string | null, title?: string | null) {
  if (source === "modworkshop") return "MW";
  if (source === "nexus") return "NX";
  const cleanTitle = String(title ?? "").trim().replace(/[^a-z0-9]/gi, "");
  return cleanTitle.slice(0, 2).toUpperCase() || "LO";
}

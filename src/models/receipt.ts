export type ReceiptSource = "modworkshop" | "nexus" | "manual" | "unknown";
export type ReceiptModType = "pak" | "ue4ss" | "mixed" | "unknown";

export interface InstallReceiptFile {
  relativePath: string;
  sizeBytes?: number;
  sha256?: string | null;
}

export interface InstallReceipt {
  id: string;
  displayName: string;
  source: ReceiptSource;
  modType: ReceiptModType;
  sourceModId?: string | null;
  sourceFileId?: string | null;
  version?: string | null;
  author?: string | null;
  thumbnailUrl?: string | null;
  pageUrl?: string | null;
  installedAtUnix?: number | null;
  files: InstallReceiptFile[];
}

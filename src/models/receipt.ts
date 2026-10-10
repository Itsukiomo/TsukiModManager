export type ReceiptSource = "modworkshop" | "nexus" | "manual" | "local" | "unknown" | string;
export type ReceiptModType = "pak" | "ue4ss" | "mixed" | "source-install" | "source-index-v2-match" | "unknown" | string;

export interface InstallReceiptFile {
  relativePath: string;
  archivePath?: string | null;
  installRoute?: string | null;
  fileType?: string | null;
  modRootFolder?: string | null;
  folderOwner?: string | null;
  sizeBytes?: number;
  sha256?: string | null;
  installPath?: string | null;
  originalPath?: string | null;
  backupPath?: string | null;
}

export interface ReceiptSourceIndexMatch {
  kind?: string | null;
  confidence?: number | null;
  reason?: string | null;
  sha256?: string | null;
  sourceIndexVersion?: string | null;
}

export interface ReceiptMigrationMetadata {
  migratedAt?: number | null;
  migratedFromVersion?: string | null;
}

export interface ReceiptManualMatchMetadata {
  source?: string | null;
  sourceId?: string | null;
  fileId?: string | null;
  pageUrl?: string | null;
  matchedAtUnix?: number | null;
  refreshedAtUnix?: number | null;
  userConfirmed?: boolean | null;
}

export interface InstallReceipt {
  receiptVersion?: number | null;
  id: string;
  displayName: string;
  modName?: string | null;
  source: ReceiptSource;
  game?: string | null;
  modType: ReceiptModType;
  modId?: string | null;
  sourceModId?: string | null;
  fileId?: string | null;
  sourceFileId?: string | null;
  sourceFileName?: string | null;
  sourceFileCategory?: string | null;
  sourceFileUploadedAt?: string | null;
  sourceFileVersion?: string | null;
  version?: string | null;
  author?: string | null;
  thumbnailUrl?: string | null;
  bannerUrl?: string | null;
  pageUrl?: string | null;
  installedAtUnix?: number | null;
  installedAt?: number | null;
  updatedAt?: number | null;
  enabled?: boolean | null;
  installMethod?: string | null;
  installPath?: string | null;
  originalPath?: string | null;
  backupPath?: string | null;
  profileId?: string | null;
  matchKind?: string | null;
  matchConfidence?: number | null;
  matchReason?: string | null;
  sourceIndexMatch?: ReceiptSourceIndexMatch | null;
  receiptCreatedByVersion?: string | null;
  migration?: ReceiptMigrationMetadata | null;
  manualMatch?: ReceiptManualMatchMetadata | null;
  notes?: string | null;
  tags?: string[];
  files: InstallReceiptFile[];
}

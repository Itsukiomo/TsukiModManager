export type ModSourceKind = "modworkshop" | "nexus";

export interface SourceSettings {
  modworkshopApiKey?: string | null;
  nexusApiKey?: string | null;
  showAgeRestrictedNexus?: boolean;
}

export interface NexusIdentity {
  gameId?: string | null;
  modId?: string | null;
  uid?: string | null;
}

export interface SourceModSummary {
  source: ModSourceKind;
  sourceId: string;
  uid?: string | null;
  gameId?: string | null;
  nexus?: NexusIdentity | null;
  name: string;
  author?: string | null;
  version?: string | null;
  thumbnailUrl?: string | null;
  bannerUrl?: string | null;
  pageUrl?: string | null;
  updatedAt?: string | null;
  downloads?: number | null;
  likes?: number | null;
  shortDescription?: string | null;
  tags: string[];
}

export interface SourceModFile {
  id: string;
  name: string;
  version?: string | null;
  sizeLabel?: string | null;
  uploadedAt?: string | null;
  downloadUrl?: string | null;
}

export interface SourceModImage {
  id: string;
  title?: string | null;
  imageUrl: string;
  thumbnailUrl?: string | null;
}

export interface SourceModDetail extends SourceModSummary {
  description: string;
  changelog?: string | null;
  files: SourceModFile[];
  images: SourceModImage[];
  comments?: string[];
  bugs?: string[];
  logs: string[];
  stats: Array<{ label: string; value: string }>;
}


export interface InstallPreviewItem {
  sourceName: string;
  routeKind: string;
  confidence: string;
  destination: string;
  reason: string;
  safetyNotes: string[];
}

export interface InstallPreview {
  gameRoot: string;
  items: InstallPreviewItem[];
  warnings: string[];
  blocked: boolean;
}


export interface ArchiveInspectEntry {
  archivePath: string;
  routeKind: string;
  destination: string;
  confidence: string;
  reason: string;
  blocked: boolean;
  sizeBytes: number;
}

export interface StagedDownloadResult {
  modName: string;
  fileName: string;
  stagedFilePath: string;
  stagedFolderPath: string;
  sizeBytes: number;
  archiveKind: string;
  entries: ArchiveInspectEntry[];
  warnings: string[];
  canInstallLater: boolean;
}


export interface InstalledSourceMatch {
  source: ModSourceKind;
  sourceId: string;
  installed: boolean;
  enabled: boolean;
  updateAvailable: boolean;
  confidence: number;
  reason: string;
  matchedFiles: string[];
  installedModifiedUnix?: number | null;
  sourceUpdatedAt?: string | null;
  sourceUpdatedUnix?: number | null;
  matchKind: string;
}


export interface AppliedInstallFile {
  archivePath: string;
  destination: string;
  sizeBytes: number;
}

export interface InstallApplyResult {
  modName: string;
  installedFiles: AppliedInstallFile[];
  replacedFiles: string[];
  receiptPath: string;
  warnings: string[];
}


export interface PersistentSourcePair {
  uid: string;
  source: ModSourceKind;
  game: string;
  modId: string;
  fileId?: string | null;
  displayName: string;
  fileName: string;
  version?: string | null;
  installType: string;
  location: string;
  installedFiles: string[];
  installedFileHashes: Record<string, string>;
  installedAt?: number | null;
  updatedAt?: string | null;
  confidence: number;
  matchKind: string;
  pageUrl?: string | null;
  thumbnailUrl?: string | null;
  bannerUrl?: string | null;
}

export interface SourceUpdateStatus {
  uid: string;
  source: ModSourceKind;
  modId: string;
  installedFileId?: string | null;
  latestFileId?: string | null;
  latestFileName?: string | null;
  installedVersion?: string | null;
  latestVersion?: string | null;
  updateAvailable: boolean;
  canUpdate: boolean;
  reason: string;
  pageUrl?: string | null;
}

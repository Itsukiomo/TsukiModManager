export interface PakBackupInfo {
  fileName: string;
  displayName: string;
  fullPath: string;
  sizeBytes: number;
  createdUnix?: number;
}

export interface PakBackupFileEntry {
  fileName: string;
  zipPath: string;
  extension: string;
  sizeBytes: number;
  priority?: number;
}

export interface PakBackupInspectResult {
  backup: PakBackupInfo;
  files: PakBackupFileEntry[];
  manifest?: string | null;
}

export interface PakModFile {
  fileName: string;
  fullPath: string;
  extension: string;
  sizeBytes: number;
  enabled: boolean;
  priority?: number | null;
  modifiedUnix?: number | null;
  sha256?: string | null;
}

export interface PakScanResult {
  gameRoot: string;
  pakModsPath: string;
  pakModsPathExists: boolean;
  pakFileCount: number;
  pakMods: PakModFile[];
}

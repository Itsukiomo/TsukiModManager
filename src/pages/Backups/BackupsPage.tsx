import "./BackupsPage.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import type {
  PakBackupFileEntry,
  PakBackupInfo,
  PakBackupInspectResult,
} from "../../models/backup";

interface BackupProgress {
  isRunning: boolean;
  message: string;
  current: number;
  total: number;
}

type BackupView = "list" | "inspect";
type BackupSortMode = "name" | "size" | "priority";

const idleProgress: BackupProgress = {
  isRunning: false,
  message: "Ready.",
  current: 0,
  total: 0,
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;

  for (const unit of units) {
    if (value < 1024) {
      return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
    }

    value /= 1024;
  }

  return `${value.toFixed(1)} TB`;
}

function formatDateFromUnix(seconds?: number) {
  if (!seconds) return "Unknown";

  return new Date(seconds * 1000).toLocaleString();
}

function sortBackupFiles(files: PakBackupFileEntry[], sortMode: BackupSortMode) {
  return [...files].sort((a, b) => {
    if (sortMode === "size") {
      return b.sizeBytes - a.sizeBytes;
    }

    if (sortMode === "priority") {
      const aPriority = a.priority ?? Number.MAX_SAFE_INTEGER;
      const bPriority = b.priority ?? Number.MAX_SAFE_INTEGER;

      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }
    }

    return a.fileName.localeCompare(b.fileName);
  });
}

export function BackupsPage() {
  const [view, setView] = useState<BackupView>("list");
  const [backupName, setBackupName] = useState("");
  const [backups, setBackups] = useState<PakBackupInfo[]>([]);
  const [selectedBackup, setSelectedBackup] = useState<PakBackupInspectResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<PakBackupFileEntry | null>(null);
  const [status, setStatus] = useState("Ready.");
  const [progress, setProgress] = useState<BackupProgress>(idleProgress);
  const [inspectSearch, setInspectSearch] = useState("");
  const [inspectSort, setInspectSort] = useState<BackupSortMode>("name");

  const isBusy = progress.isRunning;

  const totalBackupSize = useMemo(() => {
    return backups.reduce((total, backup) => total + backup.sizeBytes, 0);
  }, [backups]);

  const progressPercent = useMemo(() => {
    if (!progress.total) return 0;
    return Math.min(100, Math.round((progress.current / progress.total) * 100));
  }, [progress.current, progress.total]);

  const inspectedFiles = useMemo(() => {
    const query = inspectSearch.trim().toLowerCase();

    const filtered = (selectedBackup?.files ?? []).filter((file) => {
      return (
        query.length === 0 ||
        file.fileName.toLowerCase().includes(query) ||
        file.zipPath.toLowerCase().includes(query)
      );
    });

    return sortBackupFiles(filtered, inspectSort);
  }, [inspectSearch, inspectSort, selectedBackup]);

  async function refreshBackups() {
    try {
      const result = await invoke<PakBackupInfo[]>("list_pak_backups");
      setBackups(result);
      setStatus(`Found ${result.length} pak backups.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshBackupStatus() {
    try {
      const result = await invoke<BackupProgress>("get_backup_status");
      setProgress(result);
      setStatus(result.message || "Ready.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function createBackup() {
    const trimmedName = backupName.trim();

    if (!trimmedName) {
      setStatus("Name the backup first.");
      return;
    }

    setProgress({
      isRunning: true,
      message: "Starting backup...",
      current: 0,
      total: 0,
    });
    setStatus("Starting backup...");

    try {
      const result = await invoke<string>("create_pak_backup", {
        backupName: trimmedName,
      });
      setStatus(result);
      setBackupName("");
      await refreshBackups();
      await refreshBackupStatus();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      await refreshBackupStatus();
    }
  }

  async function openBackupsFolder() {
    try {
      const result = await invoke<string>("open_backups_folder");
      setStatus(result);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function openBackupFile(backup: PakBackupInfo) {
    try {
      const result = await invoke<string>("open_backup_file", {
        fileName: backup.fileName,
      });
      setStatus(result);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function inspectBackup(backup: PakBackupInfo) {
    setStatus(`Opening ${backup.displayName}...`);

    try {
      const result = await invoke<PakBackupInspectResult>("inspect_pak_backup", {
        fileName: backup.fileName,
      });
      setSelectedBackup(result);
      setSelectedFile(result.files[0] ?? null);
      setInspectSearch("");
      setInspectSort("name");
      setView("inspect");
      setStatus(`Opened ${result.backup.displayName}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }


  async function restoreBackup(backup: PakBackupInfo) {
    const confirmed = window.confirm(
      `Restore backup "${backup.displayName}"?\n\nThis will copy the backup PAK files back into ~mods. If matching files already exist, Tsuki will move the current files into its uninstalled/conflict folder first.`,
    );

    if (!confirmed) {
      return;
    }

    setStatus(`Restoring ${backup.displayName}...`);

    try {
      const result = await invoke<string>("restore_pak_backup", {
        fileName: backup.fileName,
      });
      setStatus(result);
      window.dispatchEvent(new CustomEvent("tsuki-data-refresh"));
      await refreshBackups();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function deleteBackup(backup: PakBackupInfo) {
    const confirmed = window.confirm(
      `Delete backup "${backup.displayName}"?\n\nThis deletes the backup zip permanently.`,
    );

    if (!confirmed) {
      return;
    }

    setStatus(`Deleting ${backup.displayName}...`);

    try {
      const result = await invoke<string>("delete_pak_backup", {
        fileName: backup.fileName,
      });
      setStatus(result);
      await refreshBackups();

      if (selectedBackup?.backup.fileName === backup.fileName) {
        setSelectedBackup(null);
        setSelectedFile(null);
        setView("list");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  function backToBackups() {
    setView("list");
    setSelectedBackup(null);
    setSelectedFile(null);
    setInspectSearch("");
  }

  useEffect(() => {
    void refreshBackups();
    void refreshBackupStatus();

    const unlistenPromise = listen<BackupProgress>("backup-progress", (event) => {
      setProgress(event.payload);
      setStatus(event.payload.message);

      if (!event.payload.isRunning) {
        void refreshBackups();
      }
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  if (view === "inspect" && selectedBackup) {
    return (
      <BackupInspector
        backup={selectedBackup}
        files={inspectedFiles}
        selectedFile={selectedFile}
        search={inspectSearch}
        sortMode={inspectSort}
        status={status}
        onBack={backToBackups}
        onSearch={setInspectSearch}
        onSort={setInspectSort}
        onSelectFile={setSelectedFile}
        onOpenBackup={() => openBackupFile(selectedBackup.backup)}
        onDelete={() => deleteBackup(selectedBackup.backup)}
      />
    );
  }

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Restore points</p>
          <h1>Pak Backups</h1>
          <p className="page-description">
            Create named zip backups of Payday 3 pak files from the ~mods folder.
            Open a backup to inspect its contents inside Tsuki before restore features arrive.
          </p>
        </div>

        <div className="button-row">
          <button className="ghost-button compact" type="button" onClick={openBackupsFolder}>
            Open Backups
          </button>
          <button className="ghost-button compact" type="button" onClick={refreshBackups}>
            Refresh
          </button>
        </div>
      </div>

      <div className="card-grid">
        <article className="card">
          <h2>Backups</h2>
          <p>Total named pak backups.</p>
          <div className="stat-number">{backups.length}</div>
        </article>

        <article className="card">
          <h2>Total Space</h2>
          <p>Space used by all backup zips.</p>
          <div className="stat-number">{formatBytes(totalBackupSize)}</div>
        </article>

        <article className="card">
          <h2>Status</h2>
          <p>{status}</p>
        </article>
      </div>

      <article className="card">
        <h2>Create Pak Backup</h2>
        <p>
          Give every backup a name so you can tell why you made it later. Tsuki adds a
          timestamp to the file so names do not collide.
        </p>

        <div className="backup-create-row">
          <input
            className="setting-input"
            value={backupName}
            onChange={(event) => setBackupName(event.target.value)}
            placeholder="Example: Before installing HUD mods"
            disabled={isBusy}
          />
          <button className="ghost-button" type="button" onClick={createBackup} disabled={isBusy}>
            {isBusy ? "Creating..." : "Create Backup"}
          </button>
        </div>

        {(isBusy || progress.current > 0 || progress.message !== "Ready.") && (
          <div className="backup-progress-box">
            <div className="backup-progress-header">
              <strong>{progress.message}</strong>
              <span>
                {progress.total > 0
                  ? `${progress.current} / ${progress.total} files (${progressPercent}%)`
                  : "Preparing..."}
              </span>
            </div>
            <div className="backup-progress-track">
              <div
                className="backup-progress-fill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}
      </article>

      <article className="card">
        <h2>Saved Backups</h2>

        {backups.length === 0 ? (
          <p>No backups yet.</p>
        ) : (
          <div className="backup-list">
            {backups.map((backup) => (
              <div className="backup-row" key={backup.fullPath}>
                <div>
                  <strong>{backup.displayName}</strong>
                  <p>{backup.fileName}</p>
                </div>

                <span>{formatBytes(backup.sizeBytes)}</span>
                <span>{formatDateFromUnix(backup.createdUnix)}</span>

                <div className="backup-row-actions">
                  <button
                    className="ghost-button compact"
                    type="button"
                    onClick={() => inspectBackup(backup)}
                  >
                    Open
                  </button>
                  <button
                    className="ghost-button compact"
                    type="button"
                    onClick={() => openBackupFile(backup)}
                  >
                    Explorer
                  </button>
                  <button
                    className="ghost-button compact"
                    type="button"
                    onClick={() => restoreBackup(backup)}
                    disabled={isBusy}
                  >
                    Restore
                  </button>
                  <button
                    className="ghost-button compact danger"
                    type="button"
                    onClick={() => deleteBackup(backup)}
                    disabled={isBusy}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </article>
    </section>
  );
}

interface BackupInspectorProps {
  backup: PakBackupInspectResult;
  files: PakBackupFileEntry[];
  selectedFile: PakBackupFileEntry | null;
  search: string;
  sortMode: BackupSortMode;
  status: string;
  onBack: () => void;
  onSearch: (value: string) => void;
  onSort: (value: BackupSortMode) => void;
  onSelectFile: (file: PakBackupFileEntry) => void;
  onOpenBackup: () => void;
  onDelete: () => void;
}

function BackupInspector({
  backup,
  files,
  selectedFile,
  search,
  sortMode,
  status,
  onBack,
  onSearch,
  onSort,
  onSelectFile,
  onOpenBackup,
  onDelete,
}: BackupInspectorProps) {
  const totalFileSize = backup.files.reduce((total, file) => total + file.sizeBytes, 0);

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <button className="ghost-button compact" type="button" onClick={onBack}>
            ← Back to Backups
          </button>
          <p className="eyebrow backup-inspector-eyebrow">Backup inspector</p>
          <h1>{backup.backup.displayName}</h1>
          <p className="page-description">
            Inspecting the files inside this backup. Friendly mod names, thumbnails,
            and mod pages will appear here later after ModWorkshop/Nexus metadata and
            Tsuki install receipts exist.
          </p>
        </div>

        <div className="button-row">
          <button className="ghost-button compact" type="button" onClick={onOpenBackup}>
            Open in Explorer
          </button>
          <button className="ghost-button compact danger" type="button" onClick={onDelete}>
            Delete Backup
          </button>
        </div>
      </div>

      <div className="card-grid">
        <article className="card">
          <h2>Files</h2>
          <p>Pak files inside this backup.</p>
          <div className="stat-number">{backup.files.length}</div>
        </article>

        <article className="card">
          <h2>Backup Size</h2>
          <p>Zip file size.</p>
          <div className="stat-number">{formatBytes(backup.backup.sizeBytes)}</div>
        </article>

        <article className="card">
          <h2>Raw File Size</h2>
          <p>Total size of indexed files.</p>
          <div className="stat-number">{formatBytes(totalFileSize)}</div>
        </article>
      </div>

      <div className="backup-inspector-layout">
        <article className="card">
          <div className="table-toolbar">
            <div>
              <h2>Backup File List</h2>
              <p>
                Showing {files.length} of {backup.files.length} files.
              </p>
            </div>

            <div className="table-controls">
              <input
                className="setting-input table-search"
                value={search}
                onChange={(event) => onSearch(event.target.value)}
                placeholder="Search backup files..."
              />

              <select
                className="select-input"
                value={sortMode}
                onChange={(event) => onSort(event.target.value as BackupSortMode)}
              >
                <option value="name">Sort: Name</option>
                <option value="priority">Sort: Priority</option>
                <option value="size">Sort: Size</option>
              </select>
            </div>
          </div>

          {files.length === 0 ? (
            <p>No files match the current search.</p>
          ) : (
            <div className="backup-file-list">
              {files.map((file) => (
                <button
                  className={`backup-file-card ${
                    selectedFile?.zipPath === file.zipPath ? "active" : ""
                  }`}
                  key={file.zipPath}
                  type="button"
                  onClick={() => onSelectFile(file)}
                >
                  <div className="backup-file-icon">📦</div>
                  <div>
                    <strong>{file.fileName}</strong>
                    <span>{file.zipPath}</span>
                  </div>
                  <small>{formatBytes(file.sizeBytes)}</small>
                </button>
              ))}
            </div>
          )}
        </article>

        <aside className="card backup-detail-panel">
          <h2>File Details</h2>

          {selectedFile ? (
            <>
              <div className="backup-detail-icon">📦</div>
              <h3>{selectedFile.fileName}</h3>
              <p>
                This is currently a raw backup file entry. Later, this panel will show
                the connected mod page, thumbnail, author, source, version, and restore
                comparison when metadata exists.
              </p>

              <div className="backup-detail-list">
                <span>Type</span>
                <strong>{selectedFile.extension}</strong>

                <span>Size</span>
                <strong>{formatBytes(selectedFile.sizeBytes)}</strong>

                <span>Priority</span>
                <strong>{selectedFile.priority ?? "None"}</strong>

                <span>Zip Path</span>
                <strong>{selectedFile.zipPath}</strong>
              </div>
            </>
          ) : (
            <p>Select a file to see details.</p>
          )}

          <br />
          <p>{status}</p>
        </aside>
      </div>
    </section>
  );
}

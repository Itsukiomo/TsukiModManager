import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useMemo, useState } from "react";
import { BUILTIN_PAYDAY3_PROFILE_ID } from "../models/gameProfiles";
import type { GameProfile } from "../models/gameProfiles";
import { ProfileArtwork } from "./ProfileArtwork";
import { safeLocalStorageSet } from "../utils/browserStorage";

interface ArchiveInspectEntry {
  archivePath: string;
  routeKind: string;
  destination: string;
  confidence: string;
  reason: string;
  blocked: boolean;
  sizeBytes: number;
}

interface DragDropMatchCandidate {
  source: string;
  sourceId: string;
  fileId?: string | null;
  gameId?: string | null;
  modName: string;
  fileName: string;
  version?: string | null;
  author?: string | null;
  thumbnailUrl?: string | null;
  pageUrl?: string | null;
  sha256?: string | null;
  confidence: number;
  confidenceLevel: string;
  matchKind: string;
  reason: string;
}

interface DragDropAnalysisItem {
  id: string;
  droppedPath: string;
  displayName: string;
  archiveKind: string;
  profileId: string;
  gameId: string;
  originalSha256?: string | null;
  entries: ArchiveInspectEntry[];
  matchCandidates: DragDropMatchCandidate[];
  suggestedMatch?: DragDropMatchCandidate | null;
  confidenceLevel: string;
  suggestedInstallTarget?: string | null;
  destinationPreview: string[];
  warnings: string[];
  conflictCount: number;
  requiresOverwriteConfirmation: boolean;
  conflictSummary: string[];
  blocked: boolean;
}

interface DragDropAnalysisResult {
  profileId: string;
  gameId: string;
  items: DragDropAnalysisItem[];
  warnings: string[];
}

interface InstallApplyResult {
  modName: string;
  installedFiles: Array<{ archivePath: string; destination: string; sizeBytes: number }>;
  replacedFiles: string[];
  receiptPath: string;
  warnings: string[];
}

interface DragDropInstallWizardProps {
  onInstalled?: () => void;
  currentGameProfile?: GameProfile | null;
  gameProfiles?: GameProfile[];
  requireGameChoice?: boolean;
}

const CURRENT_PROFILE_KEY = "tsuki-current-game-profile-id";
const ACTIVE_PROFILE_KEY = "tsuki-active-game-profile-id";
const LAST_DROP_PROFILE_KEY = "tsuki-drag-drop-last-profile-id";

function filePathsFromDrop(event: DragEvent) {
  const paths: string[] = [];

  for (const file of Array.from(event.dataTransfer?.files ?? [])) {
    const path = (file as File & { path?: string }).path || (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    if (path && !paths.includes(path)) paths.push(path);
  }

  const uriList = event.dataTransfer?.getData("text/uri-list") ?? "";
  for (const line of uriList.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    try {
      const url = new URL(line);
      if (url.protocol === "file:") {
        const decoded = decodeURIComponent(url.pathname.replace(/^\/(.:\/)/, "$1"));
        if (decoded && !paths.includes(decoded)) paths.push(decoded);
      }
    } catch {
      // Ignore non-file text payloads.
    }
  }

  return paths;
}

function defaultProfileId(profile?: GameProfile | null) {
  return profile?.profileId || window.localStorage.getItem(CURRENT_PROFILE_KEY) || window.localStorage.getItem(ACTIVE_PROFILE_KEY) || BUILTIN_PAYDAY3_PROFILE_ID;
}

function candidateKey(candidate: DragDropMatchCandidate) {
  return `${candidate.source}:${candidate.sourceId}:${candidate.fileId ?? ""}`;
}

function candidateLabel(candidate: DragDropMatchCandidate) {
  return `${candidate.modName} (${candidate.source} #${candidate.sourceId})`;
}

export function DragDropInstallWizard({ onInstalled, currentGameProfile = null, gameProfiles = [], requireGameChoice = false }: DragDropInstallWizardProps) {
  const [dragging, setDragging] = useState(false);
  const [analysis, setAnalysis] = useState<DragDropAnalysisResult | null>(null);
  const [pendingPaths, setPendingPaths] = useState<string[] | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState(() => window.localStorage.getItem(LAST_DROP_PROFILE_KEY) || defaultProfileId(currentGameProfile));
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedMatches, setSelectedMatches] = useState<Record<string, string>>({});
  const [localOnly, setLocalOnly] = useState<Record<string, boolean>>({});
  const [displayNames, setDisplayNames] = useState<Record<string, string>>({});
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [overwriteApprovals, setOverwriteApprovals] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const profileChoices = gameProfiles.length ? gameProfiles : currentGameProfile ? [currentGameProfile] : [];
  const activeProfileName = useMemo(() => {
    const id = analysis?.profileId ?? selectedProfileId ?? defaultProfileId(currentGameProfile);
    return profileChoices.find((profile) => profile.profileId === id)?.displayName ?? currentGameProfile?.displayName ?? id;
  }, [analysis?.profileId, currentGameProfile, profileChoices, selectedProfileId]);

  async function analyzePaths(paths: string[], profileId: string) {
    setBusy(true);
    setStatus("Analyzing dropped content...");
    try {
      safeLocalStorageSet(LAST_DROP_PROFILE_KEY, profileId);
      const result = await invoke<DragDropAnalysisResult>("analyze_drag_drop_install", {
        paths,
        profileId,
      });
      setAnalysis(result);
      setPendingPaths(null);
      setActiveIndex(0);
      setSelectedProfileId(result.profileId || profileId);
      setSelectedMatches(Object.fromEntries(result.items.map((item) => [item.id, item.suggestedMatch ? candidateKey(item.suggestedMatch) : ""])));
      setLocalOnly(Object.fromEntries(result.items.map((item) => [item.id, !item.suggestedMatch])));
      setDisplayNames(Object.fromEntries(result.items.map((item) => [item.id, item.suggestedMatch?.modName ?? item.displayName])));
      setVersions(Object.fromEntries(result.items.map((item) => [item.id, item.suggestedMatch?.version ?? ""])));
      setThumbnails(Object.fromEntries(result.items.map((item) => [item.id, item.suggestedMatch?.thumbnailUrl ?? ""])));
      setNotes({});
      setOverwriteApprovals(Object.fromEntries(result.items.map((item) => [item.id, false])));
      setStatus(result.warnings.length ? result.warnings.join(" ") : `${result.items.length} dropped item(s) ready for review.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    setSelectedProfileId((current) => current || defaultProfileId(currentGameProfile));
  }, [currentGameProfile]);

  useEffect(() => {
    let dragDepth = 0;
    let disposed = false;
    let unlistenTauriDrop: (() => void) | null = null;

    const handleDroppedPaths = (paths: string[]) => {
      if (paths.length === 0) {
        setStatus("The drop event did not expose file paths. Try dropping from File Explorer into the desktop app window.");
        return;
      }
      const profileId = defaultProfileId(currentGameProfile);
      setSelectedProfileId(profileId);
      if (requireGameChoice && profileChoices.length > 1) {
        setPendingPaths(paths);
        setStatus(null);
        return;
      }
      void analyzePaths(paths, profileId);
    };

    const onDragEnter = (event: DragEvent) => {
      event.preventDefault();
      dragDepth += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
    };
    const onDragLeave = () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragging(false);
    };
    const onDrop = async (event: DragEvent) => {
      event.preventDefault();
      dragDepth = 0;
      setDragging(false);
      handleDroppedPaths(filePathsFromDrop(event));
    };

    void getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setDragging(true);
      } else if (event.payload.type === "leave") {
        setDragging(false);
      } else if (event.payload.type === "drop") {
        setDragging(false);
        handleDroppedPaths(event.payload.paths);
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenTauriDrop = unlisten;
    }).catch(() => {
      // Browser-only development keeps the DOM drag/drop fallback below.
    });

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);

    return () => {
      disposed = true;
      unlistenTauriDrop?.();
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [currentGameProfile, profileChoices.length, requireGameChoice]);

  const item = analysis?.items[activeIndex] ?? null;
  const selectedMatch = useMemo(() => {
    if (!item || localOnly[item.id]) return null;
    const selectedKey = selectedMatches[item.id];
    return item.matchCandidates.find((candidate) => candidateKey(candidate) === selectedKey) ?? item.suggestedMatch ?? null;
  }, [item, localOnly, selectedMatches]);

  async function installCurrent() {
    if (!item) return;
    setBusy(true);
    setStatus(`Installing ${displayNames[item.id] || item.displayName}...`);
    try {
      const result = await invoke<InstallApplyResult>("install_drag_drop_item", {
        request: {
          item,
          selectedMatch,
          installAsLocal: Boolean(localOnly[item.id]),
          displayName: displayNames[item.id] || item.displayName,
          versionOverride: versions[item.id] || null,
          thumbnailOverride: thumbnails[item.id] || null,
          notes: notes[item.id] || null,
          allowOverwrite: Boolean(overwriteApprovals[item.id]),
        },
      });
      setStatus(`Installed ${result.modName}. ${result.installedFiles.length} file(s) tracked${result.replacedFiles.length ? `; ${result.replacedFiles.length} previous file(s) backed up` : ""}. ${result.warnings.join(" ")}`);
      window.dispatchEvent(new CustomEvent("tsuki-data-refresh"));
      onInstalled?.();
      setAnalysis((current) => {
        if (!current) return current;
        const remaining = current.items.filter((candidate) => candidate.id !== item.id);
        if (remaining.length === 0) return null;
        setActiveIndex((index) => Math.min(index, remaining.length - 1));
        return { ...current, items: remaining };
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!analysis && !dragging && !status && !pendingPaths) return null;

  return (
    <>
      {dragging && <div className="drag-drop-scrim"><div>Drop mods to analyze</div></div>}
      {pendingPaths && (
        <div className="drag-drop-review-backdrop" role="dialog" aria-modal="true">
          <section className="drag-drop-review-panel drag-drop-profile-panel">
            <header className="drag-drop-review-header">
              <div>
                <p className="eyebrow">Choose game profile</p>
                <h2>Analyze dropped mods</h2>
                <p>{pendingPaths.length} dropped item(s) will be matched against the selected profile.</p>
              </div>
              <button className="ghost-button compact" type="button" onClick={() => setPendingPaths(null)} disabled={busy}>Cancel</button>
            </header>

            <div className="drag-drop-profile-list">
              {profileChoices.map((profile) => (
                <button key={profile.profileId} className={`drag-drop-profile-option ${profile.profileId === selectedProfileId ? "active" : ""}`} type="button" onClick={() => setSelectedProfileId(profile.profileId)}>
                  <ProfileArtwork
                    imageReference={profile.imageReference}
                    legacySrc={profile.image}
                    profileId={profile.profileId}
                    alt=""
                    fit={profile.artwork?.objectFit ?? "cover"}
                    focalX={profile.artwork?.focalX ?? 50}
                    focalY={profile.artwork?.focalY ?? 35}
                    fallback={<span className="profile-artwork-placeholder" aria-hidden="true" />}
                  />
                  <span>
                    <strong>{profile.displayName}</strong>
                    <small>{profile.statusLabel}</small>
                  </span>
                </button>
              ))}
            </div>
            {status && <p className="drag-drop-status">{status}</p>}

            <footer className="drag-drop-review-actions">
              <button className="ghost-button compact" type="button" disabled={busy} onClick={() => setPendingPaths(null)}>Cancel</button>
              <button className="ghost-button install-button" type="button" disabled={busy} onClick={() => analyzePaths(pendingPaths, selectedProfileId || defaultProfileId(currentGameProfile))}>{busy ? "Analyzing..." : "Analyze"}</button>
            </footer>
          </section>
        </div>
      )}
      {analysis && item && (
        <div className="drag-drop-review-backdrop" role="dialog" aria-modal="true">
          <section className="drag-drop-review-panel">
            <header className="drag-drop-review-header">
              <div>
                <p className="eyebrow">Drag/drop install</p>
                <h2>{displayNames[item.id] || item.displayName}</h2>
                <p>{activeProfileName} - {item.gameId} - {item.archiveKind}</p>
              </div>
              <button className="ghost-button compact" type="button" onClick={() => setAnalysis(null)} disabled={busy}>Cancel</button>
            </header>

            <div className="drag-drop-review-grid">
              <article>
                <p className="eyebrow">Metadata</p>
                <label>Display name<input className="setting-input" value={displayNames[item.id] ?? item.displayName} onChange={(event) => setDisplayNames((current) => ({ ...current, [item.id]: event.target.value }))} /></label>
                <label>Version<input className="setting-input" value={versions[item.id] ?? ""} onChange={(event) => setVersions((current) => ({ ...current, [item.id]: event.target.value }))} /></label>
                <label>Thumbnail URL or local path<input className="setting-input" value={thumbnails[item.id] ?? ""} onChange={(event) => setThumbnails((current) => ({ ...current, [item.id]: event.target.value }))} /></label>
                <label>Notes<input className="setting-input" value={notes[item.id] ?? ""} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} /></label>
              </article>

              <article>
                <p className="eyebrow">Source match</p>
                {item.matchCandidates.length > 0 ? (
                  <select className="setting-input" value={selectedMatches[item.id] ?? ""} disabled={localOnly[item.id]} onChange={(event) => setSelectedMatches((current) => ({ ...current, [item.id]: event.target.value }))}>
                    {item.matchCandidates.map((candidate) => (
                      <option key={candidateKey(candidate)} value={candidateKey(candidate)}>{candidateLabel(candidate)}</option>
                    ))}
                  </select>
                ) : <p>No exact active-game hash match found.</p>}
                {selectedMatch && <p className="drag-drop-match-note">{selectedMatch.reason}</p>}
                <label className="drag-drop-checkbox"><input type="checkbox" checked={Boolean(localOnly[item.id])} onChange={(event) => setLocalOnly((current) => ({ ...current, [item.id]: event.target.checked }))} /> Install as local / do not match</label>
              </article>

              <article>
                <p className="eyebrow">Install target</p>
                <h3>{item.suggestedInstallTarget ?? "Needs review"}</h3>
                <p>{item.blocked ? "No confident target was detected." : `Destination preview is based on ${activeProfileName} paths.`}</p>
                <div className="drag-drop-destinations">
                  {item.destinationPreview.slice(0, 8).map((destination) => <small key={destination}>{destination}</small>)}
                  {item.destinationPreview.length > 8 && <small>+{item.destinationPreview.length - 8} more</small>}
                </div>
                {item.requiresOverwriteConfirmation && (
                  <label className="drag-drop-checkbox">
                    <input type="checkbox" checked={Boolean(overwriteApprovals[item.id])} onChange={(event) => setOverwriteApprovals((current) => ({ ...current, [item.id]: event.target.checked }))} />
                    Back up and replace {item.conflictCount} untracked existing file(s)
                  </label>
                )}
              </article>
            </div>

            <div className="drag-drop-file-summary">
              <strong>{item.entries.filter((entry) => !entry.blocked && entry.routeKind !== "folder").length} installable file(s)</strong>
              <span>{item.entries.filter((entry) => entry.blocked).length} blocked/skipped</span>
              <span>{item.originalSha256 ? `SHA256 ${item.originalSha256.slice(0, 12)}...` : "Folder/content hashes tracked after install"}</span>
            </div>

            {item.warnings.length > 0 && <div className="drag-drop-warning-list">{item.warnings.slice(0, 5).map((warning) => <p key={warning}>{warning}</p>)}</div>}
            {item.conflictSummary.length > 0 && <div className="drag-drop-warning-list">{item.conflictSummary.slice(0, 5).map((conflict) => <p key={conflict}>{conflict}</p>)}</div>}
            {status && <p className="drag-drop-status">{status}</p>}

            <footer className="drag-drop-review-actions">
              <span>{activeIndex + 1}/{analysis.items.length}</span>
              <button className="ghost-button compact" type="button" disabled={activeIndex === 0 || busy} onClick={() => setActiveIndex((index) => Math.max(0, index - 1))}>Back</button>
              <button className="ghost-button compact" type="button" disabled={activeIndex >= analysis.items.length - 1 || busy} onClick={() => setActiveIndex((index) => Math.min(analysis.items.length - 1, index + 1))}>Next</button>
              <button className="ghost-button install-button" type="button" disabled={busy || item.blocked || (item.requiresOverwriteConfirmation && !overwriteApprovals[item.id])} onClick={installCurrent}>{busy ? "Installing..." : "Install"}</button>
            </footer>
          </section>
        </div>
      )}
      {!analysis && !pendingPaths && status && <div className="drag-drop-toast"><button type="button" onClick={() => setStatus(null)}>x</button>{status}</div>}
    </>
  );
}

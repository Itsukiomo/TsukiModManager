import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { Download, LoaderCircle } from "lucide-react";
import type { DependencyDefinition } from "../models/dependency";
import { dependencySourceLabel, getDependencyDocumentationUrl, getDependencyDownloadUrl, getDependencyPrimaryUrl } from "../models/dependency";

interface DependencyActionsProps {
  dependency: DependencyDefinition;
  profileId?: string | null;
  compact?: boolean;
  onOpenNative?: (dependency: DependencyDefinition) => boolean | void;
  onInstall?: (dependency: DependencyDefinition) => void;
}

export async function openDependencyInManagedBrowser(dependency: DependencyDefinition, url = getDependencyPrimaryUrl(dependency)) {
  if (!url) return;
  await invoke<string>("open_embedded_browser_window", {
    label: `dependency-${dependency.id}`,
    url,
    title: `${dependency.name} - ${dependencySourceLabel(dependency)}`,
    x: null,
    y: null,
    width: null,
    height: null,
  });
}

export function DependencyName({ dependency, onOpenNative }: Pick<DependencyActionsProps, "dependency" | "onOpenNative">) {
  const primaryUrl = getDependencyPrimaryUrl(dependency);
  if (!primaryUrl) return <strong>{dependency.name}</strong>;
  const open = () => {
    if (onOpenNative?.(dependency) === true) return;
    void openDependencyInManagedBrowser(dependency);
  };
  return <button className="dependency-name-link" type="button" onClick={open}>{dependency.name}</button>;
}

export function DependencyActions({ dependency, profileId, compact = true, onOpenNative, onInstall }: DependencyActionsProps) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const primaryUrl = getDependencyPrimaryUrl(dependency);
  const downloadUrl = getDependencyDownloadUrl(dependency);
  const documentationUrl = getDependencyDocumentationUrl(dependency);
  const canInstall = Boolean(dependency.installableByTsuki && dependency.automaticInstallSafe);
  const install = async () => {
    if (onInstall) { onInstall(dependency); return; }
    setBusy(true);
    setStatus("");
    try {
      if (!profileId) throw new Error("Select a game profile before setting up dependencies.");
      const result = await invoke<{ messages: string[] }>(dependency.managedToolDownload ? "download_profile_dependency_tool" : "install_profile_dependency", { profileId, dependencyId: dependency.id });
      setStatus(result.messages.join(" "));
      window.dispatchEvent(new Event("tsuki-data-refresh"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };
  const openPrimary = () => {
    if (onOpenNative?.(dependency) === true) return;
    void openDependencyInManagedBrowser(dependency, primaryUrl);
  };
  return (
    <div className="dependency-actions" aria-label={`${dependency.name} source actions`}>
      {primaryUrl && <button className={`ghost-button${compact ? " compact" : ""}`} type="button" onClick={openPrimary}>View</button>}
      {canInstall && <button className={`ghost-button install-button${compact ? " compact" : ""}`} type="button" disabled={busy} title="Install or update the approved game-specific dependency and its requirements" onClick={() => void install()}>{busy ? <LoaderCircle size={14} /> : <Download size={14} />}{busy ? "Setting Up" : "Install / Update"}</button>}
      {dependency.managedToolDownload && <button className={`ghost-button${compact ? " compact" : ""}`} type="button" disabled={busy} onClick={() => void install()}>{busy ? <LoaderCircle size={14} /> : <Download size={14} />}{busy ? "Downloading" : "Download / Update Tool"}</button>}
      {!canInstall && !dependency.managedToolDownload && downloadUrl && downloadUrl !== primaryUrl && <button className={`ghost-button${compact ? " compact" : ""}`} type="button" onClick={() => void openDependencyInManagedBrowser(dependency, downloadUrl)}>Download</button>}
      {documentationUrl && documentationUrl !== primaryUrl && documentationUrl !== downloadUrl && <button className={`ghost-button${compact ? " compact" : ""}`} type="button" onClick={() => void openDependencyInManagedBrowser(dependency, documentationUrl)}>Documentation</button>}
      {!primaryUrl && <span className="dependency-source-unverified">Source not verified</span>}
      {status && <span className="dependency-setup-status" role="status">{status}</span>}
    </div>
  );
}

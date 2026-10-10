import { invoke } from "@tauri-apps/api/core";
import type { DependencyDefinition } from "../models/dependency";
import { dependencySourceLabel, getDependencyDocumentationUrl, getDependencyDownloadUrl, getDependencyPrimaryUrl } from "../models/dependency";

interface DependencyActionsProps {
  dependency: DependencyDefinition;
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

export function DependencyActions({ dependency, compact = true, onOpenNative, onInstall }: DependencyActionsProps) {
  const primaryUrl = getDependencyPrimaryUrl(dependency);
  const downloadUrl = getDependencyDownloadUrl(dependency);
  const documentationUrl = getDependencyDocumentationUrl(dependency);
  const canInstall = Boolean(dependency.installableByTsuki && dependency.automaticInstallSafe && onInstall);
  const openPrimary = () => {
    if (onOpenNative?.(dependency) === true) return;
    void openDependencyInManagedBrowser(dependency, primaryUrl);
  };
  return (
    <div className="dependency-actions" aria-label={`${dependency.name} source actions`}>
      {primaryUrl && <button className={`ghost-button${compact ? " compact" : ""}`} type="button" onClick={openPrimary}>View</button>}
      {canInstall && <button className={`ghost-button install-button${compact ? " compact" : ""}`} type="button" onClick={() => onInstall?.(dependency)}>Install</button>}
      {!canInstall && downloadUrl && downloadUrl !== primaryUrl && <button className={`ghost-button${compact ? " compact" : ""}`} type="button" onClick={() => void openDependencyInManagedBrowser(dependency, downloadUrl)}>Download</button>}
      {documentationUrl && documentationUrl !== primaryUrl && documentationUrl !== downloadUrl && <button className={`ghost-button${compact ? " compact" : ""}`} type="button" onClick={() => void openDependencyInManagedBrowser(dependency, documentationUrl)}>Documentation</button>}
      {!primaryUrl && <span className="dependency-source-unverified">Source not verified</span>}
    </div>
  );
}

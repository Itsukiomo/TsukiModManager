import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Puzzle, RotateCw } from "lucide-react";
import type { SourceDependency, SourceModDetail, SourceModSummary } from "../models/source";
import { buildDependencyGraph, dependencySourceLabel, dependencyToSourceSummary, enrichDependency, findDependency, type DependencyDefinition } from "../models/dependency";
import { DependencyActions, DependencyName } from "./DependencyActions";
import "./DependencyRequirements.css";

const metadata = new Map<string, { expires: number; promise: Promise<SourceModSummary> }>();
let running = 0;
const waiting: Array<() => void> = [];
async function limited<T>(action: () => Promise<T>): Promise<T> {
  if (running >= 3) await new Promise<void>(resolve => waiting.push(resolve));
  else running++;
  try { return await action(); }
  finally { const next = waiting.shift(); if (next) next(); else running--; }
}
function loadMetadata(dependency: DependencyDefinition, profileId: string) {
  const summary = dependencyToSourceSummary(dependency);
  if (!summary) return null;
  const key = JSON.stringify([profileId, summary.source, summary.gameId, summary.sourceId]);
  const cached = metadata.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = limited(() => invoke<SourceModSummary>("fetch_dependency_metadata", {
    profileId, source: summary.source, modId: summary.sourceId, gameDomain: summary.gameId ?? null,
  }));
  const entry = { expires: Date.now() + 10 * 60_000, promise };
  metadata.set(key, entry);
  void promise.catch(() => { entry.expires = Date.now() + 30_000; });
  if (metadata.size > 200) metadata.delete(metadata.keys().next().value!);
  return promise;
}

export function DependencyRequirementCard({ dependency, profileId }: { dependency: DependencyDefinition; profileId: string }) {
  const [details, setDetails] = useState<SourceModSummary | null>(null);
  const [failedImage, setFailedImage] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    setDetails(null); setFailedImage(false);
    const promise = loadMetadata(dependency, profileId);
    setLoading(Boolean(promise));
    if (promise) void promise.then(value => { if (active) setDetails(value); }).catch(() => {}).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [dependency.id, profileId]);
  const image = details?.thumbnailUrl ?? dependency.thumbnailUrl;
  const display = details ? { ...dependency, name: details.name } : dependency;
  return <article className="dependency-requirement-card">
    <div className="dependency-requirement-image">
      {image && !failedImage ? <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedImage(true)} /> : <Puzzle size={24} aria-label="No thumbnail available" />}
    </div>
    <div className="dependency-requirement-info">
      <DependencyName dependency={display} />
      <div className="dependency-requirement-labels"><span className={dependency.required ? "required" : "optional"}>{dependency.required ? "Required" : "Optional"}</span><span>{dependencySourceLabel(dependency)}</span>{details?.version && <span>v{details.version}</span>}{loading && <LoaderCircle size={12} className="dependency-spinner" aria-label="Loading dependency metadata" />}</div>
      {dependency.notes && <p>{dependency.notes}</p>}
    </div>
    <DependencyActions dependency={display} profileId={profileId} />
  </article>;
}

export function DependencyRequirements({ mod, profileId, onResolved, onLoadingChange }: { mod: SourceModDetail; profileId: string; onResolved?: (dependencies: SourceDependency[]) => void; onLoadingChange?: (loading: boolean) => void }) {
  const [requirements, setRequirements] = useState<SourceDependency[]>(mod.dependencies ?? []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const resolved = useRef(onResolved); resolved.current = onResolved;
  const loadingChanged = useRef(onLoadingChange); loadingChanged.current = onLoadingChange;
  useEffect(() => {
    let active = true;
    const initial = mod.dependencies ?? [];
    setRequirements(initial); setLoading(true); setError("");
    loadingChanged.current?.(true);
    const inferred: SourceDependency[] = profileId === "builtin.payday2" && /\(las\)|\[las\]|legendary armou?r skins/i.test(mod.name)
      ? [{ id: "inferred-las", name: "Legendary Armour Skins", required: true, notes: "LAS add-on framework" }] : [];
    void invoke<SourceDependency[]>("fetch_mod_requirements", { profileId, source: mod.source, modId: mod.sourceId, gameDomain: mod.gameId ?? null })
      .then(items => {
        if (!active) return;
        const merged = [...items, ...initial, ...inferred];
        const seen = new Set<string>();
        const unique = merged.filter(item => { const key = enrichDependency({ name: item.name, sourceKind: item.sourceKind, modId: item.modId ?? undefined, gameDomain: item.gameDomain ?? undefined, url: item.url ?? undefined }, profileId).id; if (seen.has(key)) return false; seen.add(key); return true; });
        setRequirements(unique); resolved.current?.(unique);
      }).catch(reason => { if (active) { setError(String(reason)); setRequirements([...initial, ...inferred]); } })
      .finally(() => { if (active) { setLoading(false); loadingChanged.current?.(false); } });
    return () => { active = false; };
  }, [mod.source, mod.sourceId, mod.gameId, profileId, attempt]);
  const definitions = requirements.map(item => enrichDependency({ ...item, gameDomain: item.gameDomain ?? undefined, numericGameId: item.numericGameId ?? undefined, modId: item.modId ?? undefined, url: item.url ?? undefined, notes: item.notes ?? undefined, versionConstraint: item.versionConstraint ?? undefined }, profileId));
  const flattened: DependencyDefinition[] = [];
  const seen = new Set<string>();
  const add = (dependency: DependencyDefinition) => {
    if (seen.has(dependency.id)) return;
    seen.add(dependency.id); flattened.push(dependency);
    for (const parent of dependency.requires ?? []) {
      const known = findDependency(parent, profileId);
      if (known) add({ ...known, required: dependency.required ?? true, optional: !dependency.required });
    }
  };
  buildDependencyGraph(definitions).forEach(node => add(node.dependency));
  return <section className="dependency-requirements" aria-label="Mod requirements">
    <header><strong>Requirements</strong>{loading ? <span role="status"><LoaderCircle size={14} className="dependency-spinner" /> Loading</span> : <span>{flattened.length}</span>}</header>
    {error && <div className="dependency-requirements-error" role="status"><span>Source requirements could not be fully loaded. {error}</span><button type="button" className="ghost-button compact" title="Retry requirements" aria-label="Retry requirements" onClick={() => setAttempt(value => value + 1)}><RotateCw size={14} /></button></div>}
    {flattened.map(dependency => <DependencyRequirementCard key={dependency.id} dependency={dependency} profileId={profileId} />)}
    {!loading && !error && flattened.length === 0 && <p className="dependency-requirements-empty">No requirements listed by this source.</p>}
  </section>;
}

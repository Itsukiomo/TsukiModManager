import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, RefreshCw, Trash2, ArrowUpCircle } from "lucide-react";
import "./ManagedLoaderStatus.css";

type LoaderStatus = { state: string; message: string; version?: string; authorized: boolean };

export function ManagedLoaderStatus({ profileId }: { profileId: string }) {
  const [status, setStatus] = useState<LoaderStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const run = useCallback(async (action: string, token = generation.current) => {
    setBusy(true); setError("");
    window.dispatchEvent(new CustomEvent("tsuki-task-progress", { detail: { active: true, label: "Native PAK support", detail: "Verifying external runtime", progress: null } }));
    try {
      const value = await invoke<LoaderStatus>("managed_loader_action", { action });
      if (generation.current === token) setStatus(value);
    } catch (reason) { if (generation.current === token) setError(String(reason)); }
    finally {
      if (generation.current === token) setBusy(false);
      window.dispatchEvent(new CustomEvent("tsuki-task-progress", { detail: { active: false, label: "Native PAK support" } }));
    }
  }, []);
  useEffect(() => {
    const token = ++generation.current;
    setStatus(null); setError(""); setBusy(false);
    if (profileId !== "builtin.outlast-trials") return;
    void invoke<LoaderStatus>("managed_loader_status").then((value) => {
      if (generation.current !== token) return;
      setStatus(value);
      if (value.state === "missing" && value.authorized) void run("ensure", token);
    }).catch((reason) => { if (generation.current === token) setError(String(reason)); });
    return () => { generation.current++; };
  }, [profileId, run]);
  if (profileId !== "builtin.outlast-trials" || (!status && !error)) return null;
  return <section className="managed-loader-status" aria-label="Native PAK support" aria-busy={busy}>
    <div><strong>Native PAK support{status?.version ? ` ${status.version}` : ""}</strong><span role={error ? "alert" : "status"}>{error || status?.message}</span></div>
    {status?.state === "disclosure" && <button type="button" disabled={busy} onClick={() => void run("authorize")}><Download size={14} /> Enable Support</button>}
    {status?.authorized && status.state !== "unconfigured" && <button type="button" disabled={busy} onClick={() => void run(status.state === "ready" ? "repair" : "ensure")}><RefreshCw size={14} />{busy ? "Verifying" : status.state === "ready" ? "Repair" : "Retry"}</button>}
    {status?.state === "ready" && <button type="button" title="Restore the original PAK and remove only Tsuki's loader runtime" disabled={busy} onClick={() => void run("uninstall")}><Trash2 size={14} /> Remove Loader</button>}
    {status?.state === "ready" && <button type="button" title="Check for and install a signed loader update; never required by a game update" aria-label="Update Native PAK loader" disabled={busy} onClick={() => void run("update")}><ArrowUpCircle size={15} /></button>}
  </section>;
}

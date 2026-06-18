import "./SettingsPage.css";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { AppSettings } from "../../models/settings";
import { APP_THEMES } from "../../models/theme";

interface SettingsPageProps {
  activeThemeId: string;
  onThemeChange: (themeId: string) => void;
}

interface AppUpdateStatus {
  currentVersion: string;
  currentSemver: string;
  latestVersion?: string | null;
  updateAvailable: boolean;
  notes?: string | null;
  pubDate?: string | null;
  downloadUrl?: string | null;
  releaseUrl?: string | null;
  sha256?: string | null;
  manifestUrl?: string | null;
  checkedAtUnix: number;
  error?: string | null;
}

interface CacheStats {
  appDataPath: string;
  cachePath: string;
  downloadCachePath: string;
  extractionCachePath: string;
  uninstalledPath: string;
  downloadCacheSizeBytes: number;
  extractionCacheSizeBytes: number;
  totalCacheSizeBytes: number;
  cachedDownloadCount: number;
  temporaryExtractionFolderCount: number;
  uninstalledStorageSizeBytes: number;
  uninstalledEntryCount: number;
}

function maskKey(value: string) {
  if (!value) return "Not saved";
  if (value.length <= 6) return "******";
  return `${"*".repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}

type SettingsTab = "game" | "sources" | "cache" | "updates" | "themes";

const SETTINGS_CATEGORIES: Array<{ id: SettingsTab; label: string }> = [
  { id: "game", label: "Game" },
  { id: "sources", label: "Sources" },
  { id: "cache", label: "Cache" },
  { id: "updates", label: "Updates" },
  { id: "themes", label: "Themes" },
];

function reportTaskProgress(label: string, progress: number | null = null, detail = "") {
  window.dispatchEvent(new CustomEvent("tsuki-task-progress", {
    detail: { active: true, label, detail, progress },
  }));
}

function clearTaskProgressSoon(ms = 700) {
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent("tsuki-task-progress", {
      detail: { active: false, label: "", detail: "", progress: null },
    }));
  }, ms);
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function SettingsPage({ activeThemeId, onThemeChange }: SettingsPageProps) {
  const [detectedPath, setDetectedPath] = useState("Not checked yet.");
  const [manualPath, setManualPath] = useState("");
  const [modworkshopApiKey, setModworkshopApiKey] = useState("");
  const [nexusApiKey, setNexusApiKey] = useState("");
  const [showAgeRestrictedNexus, setShowAgeRestrictedNexus] = useState(true);
  const [showKeys, setShowKeys] = useState(false);
  const [sourceStatus, setSourceStatus] = useState("Sources not verified yet.");
  const [saveStatus, setSaveStatus] = useState("Settings loaded from AppData when available.");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("game");
  const [adminStatus, setAdminStatus] = useState("Admin state not checked yet.");
  const [appUpdateStatus, setAppUpdateStatus] = useState("App update check has not run yet.");
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);
  const [keepDownloadedArchives, setKeepDownloadedArchives] = useState(true);
  const [keepUninstalledMods, setKeepUninstalledMods] = useState(false);
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [cacheStatus, setCacheStatus] = useState("Cache stats not loaded yet.");
  const [cacheBusy, setCacheBusy] = useState(false);

  const nexusConnected = nexusApiKey.trim().length > 0;
  const modworkshopAdvanced = modworkshopApiKey.trim().length > 0;

  async function loadSettings() {
    try {
      const settings = await invoke<AppSettings>("get_app_settings");
      setManualPath(settings.gamePath ?? "");
      setModworkshopApiKey(settings.modworkshopApiKey ?? "");
      setNexusApiKey(settings.nexusApiKey ?? "");
      setShowAgeRestrictedNexus(settings.showAgeRestrictedNexus ?? true);
      setKeepDownloadedArchives(settings.keepDownloadedArchives ?? true);
      setKeepUninstalledMods(settings.keepUninstalledMods ?? false);
      // Theme is loaded once by App. Do not re-apply it here or Settings can snap back when reopened.
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function detectPayday3() {
    try {
      const result = await invoke<string>("detect_payday3_path");
      setDetectedPath(result);
    } catch (error) {
      setDetectedPath(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveManualPath() {
    try {
      const result = await invoke<string>("save_game_path", { gamePath: manualPath });
      setSaveStatus(result);
      window.dispatchEvent(new Event("tsuki-data-refresh"));
      await detectPayday3();
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function clearManualPath() {
    try {
      const result = await invoke<string>("clear_game_path");
      setManualPath("");
      setSaveStatus(result);
      window.dispatchEvent(new Event("tsuki-data-refresh"));
      await detectPayday3();
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveTheme(themeId: string) {
    onThemeChange(themeId);

    try {
      const result = await invoke<string>("save_theme", { themeId });
      setSaveStatus(result);
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveSourceKeys() {
    try {
      const result = await invoke<string>("save_source_api_keys", {
        modworkshopApiKey,
        nexusApiKey,
        showAgeRestrictedNexus,
      });
      setSaveStatus(result);
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function clearSourceKeys() {
    try {
      const result = await invoke<string>("clear_source_api_keys");
      setModworkshopApiKey("");
      setNexusApiKey("");
      setSourceStatus("Source keys cleared.");
      setSaveStatus(result);
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function loginWithNexus() {
    try {
      const result = await invoke<string>("open_nexus_login_page");
      setSourceStatus(result);
    } catch (error) {
      setSourceStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function checkAdminState() {
    try {
      const isAdmin = await invoke<boolean>("is_running_as_admin");
      setAdminStatus(isAdmin ? "Tsuki is running as administrator." : "Tsuki is not running as administrator.");
    } catch (error) {
      setAdminStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function relaunchAsAdmin() {
    try {
      const result = await invoke<string>("relaunch_tsuki_as_admin");
      setAdminStatus(result);
    } catch (error) {
      setAdminStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function copyNexusKey() {
    if (!nexusApiKey.trim()) {
      setSourceStatus("No Nexus API key to copy.");
      return;
    }

    await navigator.clipboard.writeText(nexusApiKey);
    setSourceStatus("Copied Nexus API key.");
  }

  function formatAppUpdateStatus(result: AppUpdateStatus) {
    if (result.error) return result.error;

    if (result.updateAvailable) {
      return [
        `Update available: ${result.latestVersion}`,
        `Current: ${result.currentSemver}`,
        result.notes ? `Notes: ${result.notes}` : null,
        result.downloadUrl ? "Download URL present." : "No download URL in manifest.",
      ].filter(Boolean).join(" | ");
    }

    return `Tsuki is up to date. Current: ${result.currentSemver}${result.latestVersion ? ` Latest: ${result.latestVersion}` : ""}.`;
  }

  async function checkAppUpdateFromSettings() {
    if (appUpdateBusy) return;
    setAppUpdateBusy(true);
    setAppUpdateStatus("Checking app update manifest...");

    try {
      const result = await invoke<AppUpdateStatus>("check_app_update", { manifestUrl: null });
      setAppUpdateStatus(formatAppUpdateStatus(result));
    } catch (error) {
      setAppUpdateStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setAppUpdateBusy(false);
    }
  }

  async function downloadAndLaunchAppUpdateFromSettings() {
    if (appUpdateBusy) return;
    setAppUpdateBusy(true);
    setAppUpdateStatus("Downloading latest Tsuki installer...");

    try {
      const result = await invoke<string>("download_and_launch_app_update", { manifestUrl: null });
      setAppUpdateStatus(result);
    } catch (error) {
      setAppUpdateStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setAppUpdateBusy(false);
    }
  }

  async function refreshCacheStats(message = "Cache stats refreshed.") {
    try {
      const stats = await invoke<CacheStats>("get_cache_stats");
      setCacheStats(stats);
      setCacheStatus(message);
    } catch (error) {
      setCacheStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function openTsukiDataFolder() {
    try {
      const result = await invoke<string>("open_app_data_folder");
      setCacheStatus(result);
    } catch (error) {
      setCacheStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function openCacheFolder() {
    try {
      const result = await invoke<string>("open_cache_folder");
      setCacheStatus(result);
    } catch (error) {
      setCacheStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveKeepDownloadedArchives(next: boolean) {
    setKeepDownloadedArchives(next);
    try {
      const result = await invoke<string>("save_cache_settings", { keepDownloadedArchives: next });
      setCacheStatus(result);
      await refreshCacheStats(result);
    } catch (error) {
      setKeepDownloadedArchives(!next);
      setCacheStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveKeepUninstalledMods(next: boolean) {
    setKeepUninstalledMods(next);
    try {
      const result = await invoke<string>("save_uninstall_storage_settings", { keepUninstalledMods: next });
      setCacheStatus(result);
      await refreshCacheStats(result);
    } catch (error) {
      setKeepUninstalledMods(!next);
      setCacheStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function clearCache(command: "clear_download_cache" | "clear_extraction_cache" | "clear_all_download_cache", label: string) {
    const confirmed = window.confirm(`Clear ${label}? This only deletes Tsuki cache files and does not delete receipts, backups, profiles, or logs.`);
    if (!confirmed || cacheBusy) return;

    setCacheBusy(true);
    setCacheStatus(`Clearing ${label}...`);
    reportTaskProgress("Clear Cache", 10, `Clearing ${label}...`);

    try {
      const result = await invoke<string>(command);
      reportTaskProgress("Clear Cache", 72, "Refreshing cache stats...");
      await refreshCacheStats(result);
      reportTaskProgress("Clear Cache", 100, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCacheStatus(message);
      reportTaskProgress("Cache cleanup failed", 100, message);
    } finally {
      setCacheBusy(false);
      clearTaskProgressSoon();
    }
  }

  useEffect(() => {
    void loadSettings();
    void detectPayday3();
    void checkAdminState();
    void refreshCacheStats("Cache stats loaded.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="page settings-page modern-settings-page">
      <div className="settings-hero hero-glass">
        <div>
          <p className="eyebrow">Control panel</p>
          <h1>Settings</h1>
          <p className="page-description">
            Configure PAYDAY 3 paths, source keys, updates, and themes. Advanced diagnostics live in the secret debug panel.
          </p>
        </div>
        <div className="settings-category-nav">
          {SETTINGS_CATEGORIES.map((item) => (
            <button
              className={`ghost-button compact ${settingsTab === item.id ? "active" : ""}`}
              key={item.id}
              type="button"
              onClick={() => setSettingsTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-tab-panel" id="settings-game" hidden={settingsTab !== "game"}>
      <div className="settings-layout">
        <div className="card settings-section-card">
          <h2>Game Path</h2>
          <div className="setting-block">
            <label htmlFor="gamePath">Detected Payday 3 install folder</label>
            <input id="gamePath" className="setting-input" value={detectedPath} readOnly />
          </div>

          <br />

          <div className="setting-block">
            <label htmlFor="manualGamePath">Manual Payday 3 folder override</label>
            <input
              id="manualGamePath"
              className="setting-input"
              value={manualPath}
              onChange={(event) => setManualPath(event.target.value)}
              placeholder="Example: C:\Program Files (x86)\Steam\steamapps\common\PAYDAY3"
            />
          </div>

          <br />

          <div className="button-row">
            <button className="ghost-button" type="button" onClick={detectPayday3}>
              Detect Payday 3
            </button>
            <button className="ghost-button" type="button" onClick={saveManualPath}>
              Save Manual Path
            </button>
            <button className="ghost-button" type="button" onClick={clearManualPath}>
              Clear Manual Path
            </button>
          </div>

          <br />
          <p>{saveStatus}</p>
        </div>

        <div className="card settings-section-card">
          <h2>Admin Access</h2>
          <p>{adminStatus}</p>
          <br />
          <div className="button-row">
            <button className="ghost-button" type="button" onClick={checkAdminState}>
              Check Admin State
            </button>
            <button className="ghost-button" type="button" onClick={relaunchAsAdmin}>
              Relaunch as Admin
            </button>
          </div>
        </div>

      </div>
      </div>

      <article className="card settings-section-card settings-tab-panel" id="settings-sources" hidden={settingsTab !== "sources"}>
        <h2>Sources</h2>
        <p>
          ModWorkshop can use the public API for browsing. Nexus supports manual API key
          entry now, with login flow reserved for the next real OAuth step.
        </p>

        <div className="source-card-grid settings-source-grid">
          <div className="card settings-source-card">
            <h3>ModWorkshop</h3>
            <div className="source-status-line">
              <strong>Public API</strong>
              <span>Ready without login</span>
            </div>
            <p className="source-mini-note">
              Personal key is optional/advanced. Most users should leave this empty.
            </p>

            <br />

            <div className="setting-block">
              <label htmlFor="modworkshopApiKey">ModWorkshop API Key Optional</label>
              <input
                id="modworkshopApiKey"
                className="setting-input"
                type={showKeys ? "text" : "password"}
                value={modworkshopApiKey}
                onChange={(event) => setModworkshopApiKey(event.target.value)}
                placeholder="Optional"
              />
            </div>

            <p className="source-mini-note">
              Status: {modworkshopAdvanced ? "Advanced key saved locally." : "Using public access."}
            </p>
          </div>

          <div className="card settings-source-card">
            <h3>Nexus Mods</h3>
            <div className="source-status-line">
              <strong>{nexusConnected ? "Connected" : "Not connected"}</strong>
              <span className="masked-key">{maskKey(nexusApiKey)}</span>
            </div>

            <br />

            <div className="setting-block">
              <label htmlFor="nexusApiKey">Nexus API Key</label>
              <input
                id="nexusApiKey"
                className="setting-input"
                type={showKeys ? "text" : "password"}
                value={nexusApiKey}
                onChange={(event) => setNexusApiKey(event.target.value)}
                placeholder="Paste Nexus personal API key"
              />
            </div>

            <label className="source-toggle-row">
              <input
                type="checkbox"
                checked={showAgeRestrictedNexus}
                onChange={(event) => setShowAgeRestrictedNexus(event.target.checked)}
              />
              <span>Show age-restricted Nexus mods when your Nexus account/API key allows it</span>
            </label>

            <div className="source-key-actions">
              <button className="ghost-button compact" type="button" onClick={loginWithNexus}>
                Open Nexus API Page
              </button>
              <button className="ghost-button compact" type="button" onClick={copyNexusKey}>
                Copy Key
              </button>
            </div>

            <p className="source-mini-note">
              Login currently opens the Nexus account/API page. Full automatic callback
              login needs app registration/callback support later.
            </p>
          </div>
        </div>

        <br />

        <div className="button-row source-save-row">
          <button className="ghost-button compact" type="button" onClick={() => setShowKeys(!showKeys)}>
            {showKeys ? "Hide Keys" : "Show Keys"}
          </button>
          <button className="ghost-button install-button save-api-button" type="button" onClick={saveSourceKeys}>
            Save API Keys
          </button>
          <button className="ghost-button compact" type="button" onClick={clearSourceKeys}>
            Clear API Keys
          </button>
        </div>

        <br />
        <p>{sourceStatus}</p>
      </article>


      <article className="card settings-section-card settings-tab-panel" id="settings-cache" hidden={settingsTab !== "cache"}>
        <h2>Cache Management</h2>
        <p>
          Downloads are stored for reinstall/debugging unless you turn archive retention off.
          Temporary extraction folders are used only for archive inspection and install routing.
        </p>

        <label className="source-toggle-row">
          <input
            type="checkbox"
            checked={keepDownloadedArchives}
            onChange={(event) => saveKeepDownloadedArchives(event.target.checked)}
          />
          <span>Keep Downloaded Archives</span>
        </label>

        <label className="source-toggle-row">
          <input
            type="checkbox"
            checked={keepUninstalledMods}
            onChange={(event) => saveKeepUninstalledMods(event.target.checked)}
          />
          <span>Keep Uninstalled Mods</span>
        </label>

        <div className="source-card-grid settings-source-grid">
          <div className="card settings-source-card">
            <h3>Storage</h3>
            <div className="source-status-line">
              <strong>{formatBytes(cacheStats?.totalCacheSizeBytes ?? 0)}</strong>
              <span>Total cache</span>
            </div>
            <p className="source-mini-note">Download cache: {formatBytes(cacheStats?.downloadCacheSizeBytes ?? 0)}</p>
            <p className="source-mini-note">Extraction cache: {formatBytes(cacheStats?.extractionCacheSizeBytes ?? 0)}</p>
            <p className="source-mini-note">Cached downloads: {cacheStats?.cachedDownloadCount ?? 0}</p>
            <p className="source-mini-note">Temporary extraction folders: {cacheStats?.temporaryExtractionFolderCount ?? 0}</p>
            <p className="source-mini-note">Uninstalled storage: {formatBytes(cacheStats?.uninstalledStorageSizeBytes ?? 0)}</p>
            <p className="source-mini-note">Uninstalled entries: {cacheStats?.uninstalledEntryCount ?? 0}</p>
          </div>

          <div className="card settings-source-card">
            <h3>Folders</h3>
            <p className="source-mini-note">Tsuki data: {cacheStats?.appDataPath ?? "%APPDATA%/Tsuki Mod Manager"}</p>
            <p className="source-mini-note">Cache: {cacheStats?.cachePath ?? "%APPDATA%/Tsuki Mod Manager/cache"}</p>
            <p className="source-mini-note">Uninstalled: {cacheStats?.uninstalledPath ?? "%APPDATA%/Tsuki Mod Manager/uninstalled"}</p>
            <div className="source-key-actions">
              <button className="ghost-button compact" type="button" onClick={openTsukiDataFolder}>
                Open Tsuki Data Folder
              </button>
              <button className="ghost-button compact" type="button" onClick={openCacheFolder}>
                Open Cache Folder
              </button>
            </div>
          </div>
        </div>

        <br />

        <div className="button-row source-save-row">
          <button className="ghost-button compact" type="button" onClick={() => refreshCacheStats()} disabled={cacheBusy}>
            Refresh Cache Stats
          </button>
          <button className="ghost-button compact" type="button" onClick={() => clearCache("clear_download_cache", "download cache")} disabled={cacheBusy}>
            Clear Download Cache
          </button>
          <button className="ghost-button compact" type="button" onClick={() => clearCache("clear_extraction_cache", "extraction cache")} disabled={cacheBusy}>
            Clear Extraction Cache
          </button>
          <button className="ghost-button compact danger-button" type="button" onClick={() => clearCache("clear_all_download_cache", "all download and extraction cache")} disabled={cacheBusy}>
            Clear All Cache
          </button>
        </div>

        <br />
        <p>{cacheStatus}</p>
      </article>


      <article className="card settings-section-card settings-tab-panel" id="settings-updates" hidden={settingsTab !== "updates"}>
        <h2>App Update</h2>
        <p>
          Tsuki can check a public latest.json manifest on launch. When a newer version exists,
          an Update Available pill appears in the title bar.
        </p>

        <p className="source-mini-note">
          Update checks now use Tsuki's built-in latest.json on GitHub. There is no custom URL to configure.
        </p>

        <div className="button-row">
          <button className="ghost-button" type="button" onClick={checkAppUpdateFromSettings} disabled={appUpdateBusy}>
            {appUpdateBusy ? "Checking..." : "Check for Updates"}
          </button>
          <button className="ghost-button install-button" type="button" onClick={downloadAndLaunchAppUpdateFromSettings} disabled={appUpdateBusy}>
            {appUpdateBusy ? "Working..." : "Download + Launch Update"}
          </button>
        </div>

        <p>{appUpdateStatus}</p>
      </article>

      <article className="card settings-section-card settings-tab-panel" id="settings-themes" hidden={settingsTab !== "themes"}>
        <h2>Themes</h2>
        <p>Pick the visual style for Tsuki. Each theme gets its own symbol and color mood.</p>

        <div className="theme-grid">
          {APP_THEMES.map((theme) => (
            <button
              className={`theme-card theme-preview-${theme.id} ${
                activeThemeId === theme.id ? "active" : ""
              }`}
              key={theme.id}
              type="button"
              onClick={() => saveTheme(theme.id)}
            >
              <span className="theme-symbol">{theme.symbol}</span>
              <span>
                <strong>{theme.name}</strong>
                <small>{theme.description}</small>
              </span>
            </button>
          ))}
        </div>
      </article>

    </section>
  );
}

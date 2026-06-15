import "./SettingsPage.css";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import type { AppSettings } from "../../models/settings";
import type { InstallReceipt } from "../../models/receipt";
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

interface NexusAccountIntegrationStatus {
  apiKeySaved: boolean;
  validated: boolean;
  userName?: string | null;
  canLoadUpdatedMods: boolean;
  canResolveDownloadLinks: boolean;
  notes: string[];
}

const fallbackDebugReport = [
  "Tsuki Mod Manager Debug Report",
  "Version: 0.20.0-source-completeness-polish",
  "Backend: unavailable",
  "Payday 3 Path: not configured",
  "Last Error: backend debug command has not responded yet",
].join("\n");

function maskKey(value: string) {
  if (!value) return "Not saved";
  if (value.length <= 6) return "******";
  return `${"*".repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}

const SETTINGS_CATEGORIES = [
  { id: "game", label: "Game/Admin" },
  { id: "sources", label: "Sources" },
  { id: "updates", label: "App Update" },
  { id: "receipts", label: "Receipts" },
  { id: "themes", label: "Themes" },
  { id: "debug", label: "Debug" },
] as const;

type SettingsTab = typeof SETTINGS_CATEGORIES[number]["id"];

export function SettingsPage({ activeThemeId, onThemeChange }: SettingsPageProps) {
  const [debugReport, setDebugReport] = useState(fallbackDebugReport);
  const [debugCopied, setDebugCopied] = useState(false);
  const [healthStatus, setHealthStatus] = useState("Health check has not been run yet.");
  const [detectedPath, setDetectedPath] = useState("Not checked yet.");
  const [manualPath, setManualPath] = useState("");
  const [modworkshopApiKey, setModworkshopApiKey] = useState("");
  const [nexusApiKey, setNexusApiKey] = useState("");
  const [showAgeRestrictedNexus, setShowAgeRestrictedNexus] = useState(true);
  const [showKeys, setShowKeys] = useState(false);
  const [sourceStatus, setSourceStatus] = useState("Sources not verified yet.");
  const [receipts, setReceipts] = useState<InstallReceipt[]>([]);
  const [saveStatus, setSaveStatus] = useState("Settings loaded from AppData when available.");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("game");
  const [adminStatus, setAdminStatus] = useState("Admin state not checked yet.");
  const [appUpdateManifestUrl, setAppUpdateManifestUrl] = useState("");
  const [appUpdateStatus, setAppUpdateStatus] = useState("App update check has not run yet.");
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);

  const nexusConnected = nexusApiKey.trim().length > 0;
  const modworkshopAdvanced = modworkshopApiKey.trim().length > 0;

  const receiptStats = useMemo(() => {
    const fileCount = receipts.reduce((total, receipt) => total + receipt.files.length, 0);
    return { count: receipts.length, fileCount };
  }, [receipts]);

  async function loadSettings() {
    try {
      const settings = await invoke<AppSettings>("get_app_settings");
      setManualPath(settings.gamePath ?? "");
      setModworkshopApiKey(settings.modworkshopApiKey ?? "");
      setNexusApiKey(settings.nexusApiKey ?? "");
      setShowAgeRestrictedNexus(settings.showAgeRestrictedNexus ?? true);
      setAppUpdateManifestUrl(settings.appUpdateManifestUrl ?? "");
      // Theme is loaded once by App. Do not re-apply it here or Settings can snap back when reopened.
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadReceipts() {
    try {
      const result = await invoke<InstallReceipt[]>("list_install_receipts");
      setReceipts(result);
    } catch {
      setReceipts([]);
    }
  }

  async function refreshDebugReport() {
    try {
      const report = await invoke<string>("get_debug_report");
      setDebugReport(report);
    } catch (error) {
      setDebugReport(
        [
          fallbackDebugReport,
          "",
          "Frontend Error:",
          error instanceof Error ? error.message : String(error),
        ].join("\n"),
      );
    }
  }

  async function copyDebugReport() {
    try {
      const report = await invoke<string>("get_debug_report");
      setDebugReport(report);
      await navigator.clipboard.writeText(report);
      setDebugCopied(true);
      window.setTimeout(() => setDebugCopied(false), 1800);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDebugReport([fallbackDebugReport, "", "Copy Error:", message].join("\n"));
    }
  }

  async function runHealthCheck() {
    try {
      const report = await invoke<string>("run_health_check");
      setHealthStatus(report);
    } catch (error) {
      setHealthStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function detectPayday3() {
    try {
      const result = await invoke<string>("detect_payday3_path");
      setDetectedPath(result);
      await refreshDebugReport();
    } catch (error) {
      setDetectedPath(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveManualPath() {
    try {
      const result = await invoke<string>("save_game_path", { gamePath: manualPath });
      setSaveStatus(result);
      await detectPayday3();
      await refreshDebugReport();
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function clearManualPath() {
    try {
      const result = await invoke<string>("clear_game_path");
      setManualPath("");
      setSaveStatus(result);
      await detectPayday3();
      await refreshDebugReport();
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveTheme(themeId: string) {
    onThemeChange(themeId);

    try {
      const result = await invoke<string>("save_theme", { themeId });
      setSaveStatus(result);
      await refreshDebugReport();
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
      await refreshDebugReport();
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
      await refreshDebugReport();
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

  async function verifySources() {
    try {
      const result = await invoke<string>("verify_source_settings");
      setSourceStatus(result);
      await refreshDebugReport();
    } catch (error) {
      setSourceStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function checkNexusAccountIntegration() {
    try {
      const result = await invoke<NexusAccountIntegrationStatus>("nexus_account_integration_status");
      setSourceStatus(
        [
          `Nexus key saved: ${result.apiKeySaved ? "yes" : "no"}`,
          `validated: ${result.validated ? "yes" : "no"}`,
          `user: ${result.userName ?? "unknown"}`,
          `updated mods API: ${result.canLoadUpdatedMods ? "yes" : "no"}`,
          `download link API: ${result.canResolveDownloadLinks ? "ready when a real file is selected" : "not ready"}`,
          ...result.notes,
        ].join(" | "),
      );
      await refreshDebugReport();
    } catch (error) {
      setSourceStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function checkNexusGraphqlV2() {
    try {
      const result = await invoke<string>("nexus_graphql_v2_status");
      const diagnostic = await invoke<string>("get_nexus_graphql_diagnostic").catch(() => "");
      setSourceStatus(diagnostic ? `${result}\n\n${diagnostic}` : result);
      await refreshDebugReport();
    } catch (error) {
      setSourceStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function showNexusGraphqlDiagnostic() {
    try {
      const result = await invoke<string>("get_nexus_graphql_diagnostic");
      setSourceStatus(result);
      await refreshDebugReport();
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

  function jumpToSettingsSection(sectionId: SettingsTab) {
    setSettingsTab(sectionId);
    window.setTimeout(() => {
      document.getElementById(`settings-${sectionId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 30);
  }

  async function copyNexusKey() {
    if (!nexusApiKey.trim()) {
      setSourceStatus("No Nexus API key to copy.");
      return;
    }

    await navigator.clipboard.writeText(nexusApiKey);
    setSourceStatus("Copied Nexus API key.");
  }


  async function saveAppUpdateManifestUrl() {
    try {
      const result = await invoke<string>("save_app_update_settings", { manifestUrl: appUpdateManifestUrl });
      setAppUpdateStatus(result);
      setSaveStatus(result);
      await refreshDebugReport();
    } catch (error) {
      setAppUpdateStatus(error instanceof Error ? error.message : String(error));
    }
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
      const result = await invoke<AppUpdateStatus>("check_app_update", { manifestUrl: appUpdateManifestUrl || null });
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
      const result = await invoke<string>("download_and_launch_app_update", { manifestUrl: appUpdateManifestUrl || null });
      setAppUpdateStatus(result);
    } catch (error) {
      setAppUpdateStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setAppUpdateBusy(false);
    }
  }

  useEffect(() => {
    void loadSettings();
    void loadReceipts();
    void refreshDebugReport();
    void detectPayday3();
    void checkAdminState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  void jumpToSettingsSection;

  return (
    <section className="page">
      <div className="settings-hero hero-glass">
        <div>
          <p className="eyebrow">Control panel</p>
          <h1>Settings</h1>
          <p className="page-description">
            Configure Payday 3 paths, admin mode, source API keys, receipts, themes,
            debug tools, and health checks.
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
          <h2>Admin Mode</h2>
          <p>{adminStatus}</p>
          <br />
          <div className="button-row">
            <button className="ghost-button" type="button" onClick={checkAdminState}>
              Check Admin
            </button>
            <button className="ghost-button danger-button" type="button" onClick={relaunchAsAdmin}>
              Relaunch as Admin
            </button>
          </div>
          <p className="source-mini-note">
            Use this when replacing files in Program Files, especially Content\\Movies video replacers.
          </p>
        </div>

        <div className="card settings-section-card" id="settings-debug" hidden>
          <h2>Debug Tools</h2>
          <p>Copy a backend-generated report you can paste into chat when something breaks.</p>
          <br />
          <div className="button-row">
            <button className="ghost-button" type="button" onClick={copyDebugReport}>
              {debugCopied ? "Copied!" : "Copy Debug Report"}
            </button>
            <button className="ghost-button" type="button" onClick={runHealthCheck}>
              Run Health Check
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

        <div className="source-card-grid">
          <div className="card">
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

          <div className="card">
            <h3>Nexus Mods</h3>
            <div className="source-status-line">
              <strong>{nexusConnected ? "Connected" : "Not connected"}</strong>
              <span>{maskKey(nexusApiKey)}</span>
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
              <button className="ghost-button" type="button" onClick={loginWithNexus}>
                Login with Nexus
              </button>
              <button className="ghost-button" type="button" onClick={copyNexusKey}>
                Copy
              </button>
              <button className="ghost-button" type="button" onClick={checkNexusAccountIntegration}>
                Check Nexus Account
              </button>
              <button className="ghost-button" type="button" onClick={checkNexusGraphqlV2}>
                Check GraphQL v2
              </button>
              <button className="ghost-button" type="button" onClick={showNexusGraphqlDiagnostic}>
                Show GraphQL Diagnostic
              </button>
            </div>

            <p className="source-mini-note">
              Login currently opens the Nexus account/API page. Full automatic callback
              login needs app registration/callback support later.
            </p>
          </div>
        </div>

        <br />

        <div className="button-row">
          <button className="ghost-button" type="button" onClick={() => setShowKeys(!showKeys)}>
            {showKeys ? "Hide Keys" : "Show Keys"}
          </button>
          <button className="ghost-button" type="button" onClick={saveSourceKeys}>
            Save API Keys
          </button>
          <button className="ghost-button" type="button" onClick={verifySources}>
            Verify Sources
          </button>
          <button className="ghost-button" type="button" onClick={clearSourceKeys}>
            Clear API Keys
          </button>
        </div>

        <br />
        <p>{sourceStatus}</p>
      </article>


      <article className="card settings-section-card settings-tab-panel" id="settings-updates" hidden={settingsTab !== "updates"}>
        <h2>App Update</h2>
        <p>
          Tsuki can check a public latest.json manifest on launch. When a newer version exists,
          an Update Available pill appears in the title bar.
        </p>

        <div className="setting-block">
          <label htmlFor="appUpdateManifestUrl">Public update manifest URL</label>
          <input
            id="appUpdateManifestUrl"
            className="setting-input"
            value={appUpdateManifestUrl}
            onChange={(event) => setAppUpdateManifestUrl(event.target.value)}
            placeholder="https://raw.githubusercontent.com/your-name/your-repo/main/latest.json"
          />
        </div>

        <p className="source-mini-note">
          Recommended: host latest.json on GitHub Releases, a GitHub repo, or a public gist. The manifest can point to your latest Windows setup .exe.
        </p>

        <div className="button-row">
          <button className="ghost-button" type="button" onClick={saveAppUpdateManifestUrl}>
            Save Update URL
          </button>
          <button className="ghost-button" type="button" onClick={checkAppUpdateFromSettings} disabled={appUpdateBusy}>
            {appUpdateBusy ? "Checking..." : "Check for Updates"}
          </button>
          <button className="ghost-button install-button" type="button" onClick={downloadAndLaunchAppUpdateFromSettings} disabled={appUpdateBusy}>
            {appUpdateBusy ? "Working..." : "Download + Launch Update"}
          </button>
        </div>

        <p>{appUpdateStatus}</p>

        <div className="debug-box mini">
{`latest.json example:
{
  "version": "1.0.7.28",
  "notes": "Fixes and polish.",
  "pubDate": "2026-06-15T00:00:00Z",
  "releaseUrl": "https://github.com/YOURNAME/TsukiModManager/releases/latest",
  "downloadUrl": "https://github.com/YOURNAME/TsukiModManager/releases/download/v1.0.7.28/Tsuki_Mod_Manager_v1.0.7.28_Setup.exe",
  "sha256": "optional sha256 of the exe"
}`}
        </div>
      </article>

      <article className="card settings-section-card settings-tab-panel" id="settings-receipts" hidden={settingsTab !== "receipts"}>
        <h2>Install Receipts</h2>
        <p>
          Receipts will power safe uninstall, enable/disable, update checks, mod names,
          thumbnails, backup matching, and hash verification.
        </p>

        <div className="card-grid">
          <div className="card">
            <h3>Receipts</h3>
            <div className="stat-number">{receiptStats.count}</div>
          </div>
          <div className="card">
            <h3>Tracked Files</h3>
            <div className="stat-number">{receiptStats.fileCount}</div>
          </div>
          <div className="card">
            <h3>Storage</h3>
            <p>%APPDATA%\Tsuki Mod Manager\receipts</p>
          </div>
        </div>

        {receipts.length > 0 && (
          <div className="receipt-preview-list">
            {receipts.slice(0, 5).map((receipt) => (
              <div className="receipt-preview-row" key={receipt.id}>
                <strong>{receipt.displayName}</strong>
                <span>{receipt.files.length} files</span>
              </div>
            ))}
          </div>
        )}
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

      <div className="settings-tab-panel" id="settings-debug-panel" hidden={settingsTab !== "debug"}>
        <div className="card">
          <h2>Debug Tools</h2>
          <p>Copy a backend-generated report you can paste into chat when something breaks.</p>
          <br />
          <div className="button-row">
            <button className="ghost-button" type="button" onClick={copyDebugReport}>
              {debugCopied ? "Copied!" : "Copy Debug Report"}
            </button>
            <button className="ghost-button" type="button" onClick={runHealthCheck}>
              Run Health Check
            </button>
          </div>
        </div>

        <div className="card">
          <h2>Health Check</h2>
          <p>{healthStatus}</p>
        </div>

        <div className="debug-box">{debugReport}</div>
      </div>
    </section>
  );
}

import React, { Component, type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { clearTemporaryLocalStorageCaches, pruneLegacyLocalStorageCaches } from "./utils/browserStorage";
import { migrateLocalStorageTextEncoding } from "./utils/textEncoding";

pruneLegacyLocalStorageCaches();
try {
  migrateLocalStorageTextEncoding();
} catch (error) {
  console.warn("Local storage text migration was skipped:", error);
}

class RootCrashGuard extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Tsuki root render failed:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="boot-screen">
        <section className="boot-card" role="alert">
          <p className="eyebrow">Recovery mode</p>
          <h1>Tsuki could not open this screen</h1>
          <p>{this.state.error.message || "An unexpected interface error occurred."}</p>
          <div className="hero-actions">
            <button type="button" className="ghost-button" onClick={() => window.location.reload()}>
              Reload Tsuki
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                clearTemporaryLocalStorageCaches(true);
                window.location.reload();
              }}
            >
              Clear temporary caches and reload
            </button>
          </div>
        </section>
      </main>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RootCrashGuard>
      <App />
    </RootCrashGuard>
  </React.StrictMode>,
);

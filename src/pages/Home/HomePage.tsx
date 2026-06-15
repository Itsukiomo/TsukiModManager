export function HomePage() {
  return (
    <section className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Moonlit control room</p>
          <h1>Welcome back, heister.</h1>
          <p className="page-description">
            Tsuki Mod Manager will handle safe installs, custom profiles, backups,
            updates, and debugging for Payday 3 mods. The app can now detect Payday 3
            and scan pak-related files in the ~mods folder.
          </p>
        </div>
        <span className="status-pill">Phase 4</span>
      </div>

      <div className="card-grid">
        <article className="card">
          <h2>Installed Pak Files</h2>
          <p>Open the Installed page to refresh the real count.</p>
          <div className="stat-number">~mods</div>
        </article>

        <article className="card">
          <h2>Profiles</h2>
          <p>Profiles will be fully custom, never preset assumptions.</p>
          <div className="stat-number">1</div>
        </article>

        <article className="card">
          <h2>Updates</h2>
          <p>ModWorkshop and Nexus checks will be added later.</p>
          <div className="stat-number">0</div>
        </article>
      </div>

      <article className="card">
        <h2>Next Build Target</h2>
        <p>
          Add settings persistence and manual Payday 3 path selection. After that, we can
          group pak/ucas/utoc sets into actual mod entries instead of raw files.
        </p>
      </article>
    </section>
  );
}

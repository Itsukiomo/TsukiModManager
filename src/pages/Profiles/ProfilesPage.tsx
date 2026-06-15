export function ProfilesPage() {
  return (
    <section className="page">
      <div>
        <p className="eyebrow">Custom loadouts</p>
        <h1>Profiles</h1>
        <p className="page-description">
          Profiles are fully custom. Tsuki will not assume what a stealth, loud,
          recording, or testing setup should contain. You choose the name, enabled mods,
          priorities, launch arguments, notes, and backup snapshot.
        </p>
      </div>

      <div className="panel-list">
        <div className="panel-row">
          <div>
            <strong>Default</strong>
            <p className="page-description">
              The starting profile. Profile editing will be added after mod scanning.
            </p>
          </div>
          <span className="status-pill">Active</span>
        </div>

        <div className="panel-row">
          <div>
            <strong>Create your own profile</strong>
            <p className="page-description">
              Coming soon: name it anything and save the exact mod setup you want.
            </p>
          </div>
          <button className="ghost-button" type="button" disabled>
            Create Profile
          </button>
        </div>
      </div>
    </section>
  );
}

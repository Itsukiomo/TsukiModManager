interface TopBarProps {
  title: string;
  themeSymbol: string;
}

export function TopBar({ title, themeSymbol }: TopBarProps) {
  return (
    <header className="top-bar">
      <div className="brand-block">
        <div className="brand-mark">{themeSymbol}</div>
        <div className="brand-title">
          <strong>Tsuki Mod Manager</strong>
          <span>{title}</span>
        </div>
      </div>

      <div className="window-actions">
        <button className="launch-button" type="button">
          Launch Vanilla
        </button>
        <button className="launch-button primary" type="button">
          Launch Modded
        </button>
      </div>
    </header>
  );
}

export function StatusBar() {
  return (
    <footer className="status-bar">
      <div className="status-left">
        <span className="status-dot" />
        <span>Ready</span>
        <span>Payday 3 not detected yet</span>
      </div>
      <div className="status-right">
        <span>Profile: Default</span>
        <span>Debug: Available soon</span>
      </div>
    </footer>
  );
}

import { LoaderCircle, ToggleLeft, ToggleRight } from "lucide-react";
import "./ModToggleButton.css";

interface ModToggleButtonProps {
  enabled: boolean;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export function ModToggleButton({ enabled, busy = false, disabled = false, onClick }: ModToggleButtonProps) {
  const Icon = busy ? LoaderCircle : enabled ? ToggleRight : ToggleLeft;
  return <button type="button" className={`toggle-pill mod-state-toggle ${enabled ? "on" : "off"}`} aria-pressed={enabled} aria-busy={busy} disabled={disabled || busy} onClick={onClick} title={busy ? "Updating mod state..." : enabled ? "Disable mod" : "Enable mod"}>
    <Icon size={15} className={busy ? "task-spinner" : undefined} aria-hidden="true" />
    <span>{enabled ? "On" : "Off"}</span>
  </button>;
}

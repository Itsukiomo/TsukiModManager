import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, X } from "lucide-react";
import { tagColorClass, tagColorStyle } from "../utils/tagRegistry";
import "./ModTagList.css";

export function ModTagList({ tags, limit = 3 }: { tags: string[]; limit?: number }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const shown = tags.slice(0, limit);
  const overflow = tags.length - shown.length;

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }

  useLayoutEffect(() => {
    if (!open) return;
    const positionPanel = () => {
      const rect = trigger.current?.getBoundingClientRect();
      const menu = panel.current;
      if (!rect || !menu) return;
      const left = Math.max(12, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 12));
      const top = rect.bottom + menu.offsetHeight + 8 <= innerHeight - 12
        ? rect.bottom + 8 : Math.max(12, rect.top - menu.offsetHeight - 8);
      setPosition({ top, left });
    };
    positionPanel();
    panel.current?.focus();
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    return () => {
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("scroll", positionPanel, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="tsuki-mod-card-tags mod-tag-list" aria-label="Mod tags">
      {(shown.length ? shown : ["Mod"]).map(tag => (
        <span className={tagColorClass(tag)} style={tagColorStyle(tag, tags)} title={tag} key={tag}>{tag}</span>
      ))}
      {overflow > 0 && <button ref={trigger} type="button" className="mod-tags-expand" title={`Show all ${tags.length} tags`} aria-label={`Show all ${tags.length} tags`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>
        <Plus size={12} aria-hidden="true" /><span>{overflow}</span>
      </button>}
      {open && createPortal(<div ref={panel} id={id} role="dialog" aria-label="All mod tags" tabIndex={-1} className="mod-tags-popover" style={position} onClick={event => event.stopPropagation()}>
        <div className="mod-tags-heading"><strong>Tags <small>{tags.length}</small></strong><button type="button" aria-label="Close tags" title="Close tags" onClick={() => close(true)}><X size={14} /></button></div>
        <div className="mod-tags-expanded-list">{tags.map(tag => <span className={tagColorClass(tag)} style={tagColorStyle(tag, tags)} key={tag}>{tag}</span>)}</div>
      </div>, document.body)}
    </div>
  );
}

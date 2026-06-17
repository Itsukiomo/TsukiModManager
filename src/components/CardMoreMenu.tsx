import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

interface CardMoreMenuProps {
  children: ReactNode;
  label?: string;
}

export function CardMoreMenu({ children, label = "More options" }: CardMoreMenuProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;

    const updatePosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;

      const menuWidth = menuRef.current?.offsetWidth ?? 190;
      const menuHeight = menuRef.current?.offsetHeight ?? 180;
      const gap = 8;
      const margin = 12;
      const below = rect.bottom + gap;
      const above = rect.top - menuHeight - gap;
      const top = below + menuHeight <= window.innerHeight - margin ? below : Math.max(margin, above);
      const left = Math.min(
        Math.max(margin, rect.right - menuWidth),
        Math.max(margin, window.innerWidth - menuWidth - margin),
      );

      setPosition({ top, left });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span className={`card-more-menu ${open ? "open" : ""}`}>
      <button
        ref={buttonRef}
        className="card-more-menu-trigger"
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        ...
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="card-more-menu card-more-menu-portal open"
          style={{ top: position.top, left: position.left }}
          onClick={() => setOpen(false)}
        >
          <div>{children}</div>
        </div>,
        document.body,
      )}
    </span>
  );
}

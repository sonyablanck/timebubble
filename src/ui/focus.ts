import { useLayoutEffect } from "preact/hooks";
type RefObject<T> = { current: T | null };

// ui/ §9: keyboard focus for panels. Modal dialogs trap Tab inside; every panel takes focus when it
// opens (unless told not to) and gives it back when it closes; Esc closes the topmost panel first, so
// it never falls through to "leave walk mode" while a panel is open (§11: Esc unwinds in order).

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hidden && el.getClientRects().length > 0);
}

/** Open panels, innermost last: only the last one answers Esc. */
const stack: HTMLElement[] = [];

export interface PanelFocusOptions {
  /** Trap Tab and Shift+Tab inside (modal dialogs). */
  modal?: boolean;
  /** Move focus into the panel when it opens (default true). Info cards opened mid-walk don't. */
  takeFocus?: boolean;
  /** Focus the panel itself rather than its first control, so single-key shortcuts keep working (field guide). */
  focusRoot?: boolean;
  /** Called on Esc while this is the topmost panel. */
  onEscape?: () => void;
  /** Where focus goes on close if the element that had it is gone (default: leave it). */
  fallback?: () => HTMLElement | null;
}

export function usePanelFocus(ref: RefObject<HTMLElement>, opts: PanelFocusOptions = {}): void {
  const { modal = false, takeFocus = true, focusRoot = false, onEscape, fallback } = opts;
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const opener = document.activeElement as HTMLElement | null;
    stack.push(root);
    if (takeFocus && !root.contains(document.activeElement)) {
      ((focusRoot ? null : focusables(root)[0]) ?? root).focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== root) return;
      if (e.key === "Escape" && onEscape) {
        e.preventDefault(); e.stopImmediatePropagation();
        onEscape();
        return;
      }
      if (e.key !== "Tab" || !modal) return;
      const els = focusables(root);
      if (!els.length) { e.preventDefault(); return; }
      const first = els[0]!, last = els[els.length - 1]!;
      const inside = root.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      const i = stack.lastIndexOf(root);
      if (i >= 0) stack.splice(i, 1);
      // give focus back only if it was inside the panel (or lost with it)
      const active = document.activeElement;
      if (active && active !== document.body && !root.contains(active)) return;
      const target = opener && opener.isConnected && opener !== document.body && !root.contains(opener) ? opener : fallback?.();
      target?.focus({ preventScroll: true });
    };
  }, []);
}

import { useEffect, useRef, type RefObject } from "react";

const focusableSelector =
  "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function dialogFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) =>
      !element.hidden &&
      !element.closest("[inert]") &&
      !element.closest('[aria-hidden="true"]'),
  );
}

export function trapDialogTabKey(event: KeyboardEvent, dialog: HTMLElement): void {
  if (event.key !== "Tab") return;

  const focusable = dialogFocusableElements(dialog);
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus({ preventScroll: true });
    return;
  }

  const active = document.activeElement;
  if (!dialog.contains(active)) {
    event.preventDefault();
    focusable[0]?.focus({ preventScroll: true });
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last?.focus({ preventScroll: true });
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first?.focus({ preventScroll: true });
  }
}

/** Keep keyboard focus inside a blocking desktop dialog. */
export function useDialogFocus(
  dialogRef: RefObject<HTMLElement | null>,
  initialFocusRef?: RefObject<HTMLElement | null>,
  onEscape?: () => void,
  enabled = true,
): void {
  const onEscapeRef = useRef(onEscape);

  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!enabled) return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const preferred = initialFocusRef?.current;
    if (
      preferred &&
      !preferred.hasAttribute("disabled") &&
      !preferred.closest("[inert]") &&
      !preferred.closest('[aria-hidden="true"]')
    ) {
      preferred.focus({ preventScroll: true });
    } else {
      const first = dialogFocusableElements(dialog)[0];
      if (first) first.focus({ preventScroll: true });
      else dialog.focus({ preventScroll: true });
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && onEscapeRef.current) {
        event.preventDefault();
        onEscapeRef.current();
        return;
      }
      trapDialogTabKey(event, dialog);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialogRef, enabled, initialFocusRef]);
}

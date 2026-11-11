import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const dialogStack: symbol[] = [];
let dialogRevision = 0;
let renderedDialogs = 0;

/** Async workflows may only publish into the dialog scope where they started. */
export function currentDialogScope(): { readonly revision: number; readonly open: boolean } {
  return { revision: dialogRevision, open: renderedDialogs > 0 };
}

function trapTab(event: KeyboardEvent, panel: HTMLDivElement): void {
  const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  const outside = active === null || !panel.contains(active);
  if (event.shiftKey && (active === first || active === panel || outside)) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && (active === last || outside)) {
    event.preventDefault();
    first?.focus();
  }
}

export function useDialogKeyboard(rendered: boolean, panelRef: RefObject<HTMLDivElement>, requestClose: () => void): void {
  const stackTokenRef = useRef<symbol>(Symbol('dialog'));
  useLayoutEffect(() => {
    if (!rendered) return;
    dialogRevision++;
    renderedDialogs++;
    return () => {
      renderedDialogs--;
    };
  }, [rendered]);
  useEffect(() => {
    if (!rendered) return;
    const token = stackTokenRef.current;
    dialogStack.push(token);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (dialogStack.at(-1) !== token) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      } else if (event.key === 'Tab' && panelRef.current !== null) {
        trapTab(event, panelRef.current);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      const index = dialogStack.indexOf(token);
      if (index !== -1) dialogStack.splice(index, 1);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [panelRef, rendered, requestClose]);
}

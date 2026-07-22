// Pointer-drag ghost for the session rail's "move window to another session"
// drag-and-drop (SessionRail.tsx).
//
// Why a hand-rolled ghost instead of the HTML5 drag image: the SPA also runs
// inside the Tauri desktop shell's WKWebView, where wry's native drag layer
// interferes with in-page HTML5 DnD on macOS regardless of its
// dragDropEnabled flag (verified on stamped builds both ways) — and the
// planned native file-drop shell mode disables in-page HTML5 DnD outright.
// The rail therefore drags with POINTER events, which never hand the engine a
// drag image at all; this helper renders the "row follows the cursor"
// affordance manually. (This replaced setStandaloneDragImage, the
// setDragImage-based helper the HTML5 flow used.)
//
// The clone is appended to document.body — OUTSIDE the rail's backdrop-filter
// compositing layer — for the same reason the old helper parked its clone
// there: WebKit resolves a .session-item inside the rail's glass layer
// against that whole layer, ghosting neighbor rows' labels into the visual.
// A body-level clone composites standalone on every engine.
//
// pointer-events:none is load-bearing twice over: it keeps the ghost out of
// hit-testing so document.elementFromPoint (SessionRail's drop-target probe)
// sees THROUGH the ghost to the group header underneath, and it keeps the
// ghost from swallowing the very pointer events that drive the drag.
//
// move() positions via transform:translate3d — compositor-only, no layout —
// rather than top/left, which would trigger relayout on every pointermove.

export interface PointerGhost {
  /** Reposition the ghost so the original grab point tracks (x, y). */
  move(x: number, y: number): void;
  /** Remove the ghost from the DOM. Safe to call more than once. */
  destroy(): void;
}

/**
 * Clone `el` as a cursor-following drag ghost. `grabX`/`grabY` are the
 * client coordinates where the pointer first went down on the row — the
 * ghost is offset so that exact point stays under the cursor, instead of the
 * row visually snapping its top-left corner to the pointer when the drag arms.
 */
export function createPointerGhost(el: HTMLElement, grabX: number, grabY: number): PointerGhost {
  const rect = el.getBoundingClientRect();
  const offsetX = grabX - rect.left;
  const offsetY = grabY - rect.top;
  const ghost = el.cloneNode(true) as HTMLElement;
  ghost.setAttribute('aria-hidden', 'true'); // pure visual — out of the a11y tree
  ghost.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    `width:${rect.width}px`,
    'margin:0',
    'pointer-events:none',
    'opacity:0.9',
    // Above every app surface (styles.css tops out at z-index 1000).
    'z-index:2000',
    'will-change:transform',
  ].join(';');
  const move = (x: number, y: number): void => {
    ghost.style.transform = `translate3d(${x - offsetX}px, ${y - offsetY}px, 0)`;
  };
  move(grabX, grabY); // position BEFORE the append — no corner flash on first paint
  document.body.appendChild(ghost);
  return { move, destroy: () => ghost.remove() };
}

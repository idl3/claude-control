// Explicit HTML5 drag-image for rows that live inside a compositing layer.
//
// WebKit (Safari, and therefore the desktop shell's WKWebView) derives the
// default drag ghost by snapshotting the dragged element's COMPOSITING LAYER,
// not the element itself. The session rail is a backdrop-filter layer
// (styles.css .rail — see the layer-resolution caveats commented there), so a
// native drag of a .session-item ghosts neighboring rows' labels and renders
// the row twice. Chromium snapshots just the element, which is why the bug is
// shell/Safari-only. Handing every engine an explicit, standalone drag image
// removes the divergence: clone the row, park it fixed offscreen OUTSIDE the
// rail's stacking context, point setDragImage at it, and remove it on the
// next frame (engines capture the image synchronously during dragstart).
export function setStandaloneDragImage(
  e: Pick<DragEvent, 'clientX' | 'clientY'> & {
    dataTransfer: Pick<DataTransfer, 'setDragImage'> | null;
  },
  el: HTMLElement,
): void {
  if (!e.dataTransfer?.setDragImage) return; // jsdom / very old engines
  const rect = el.getBoundingClientRect();
  const ghost = el.cloneNode(true) as HTMLElement;
  ghost.style.cssText = [
    'position:fixed',
    'top:-1000px',
    'left:0',
    `width:${rect.width}px`,
    'margin:0',
    'pointer-events:none',
    // its own opaque surface — never inherits the rail's glass backdrop
    'z-index:-1',
  ].join(';');
  document.body.appendChild(ghost);
  try {
    e.dataTransfer.setDragImage(ghost, e.clientX - rect.left, e.clientY - rect.top);
  } finally {
    // The engine snapshots during dragstart; removing on the next frame is
    // safe and keeps the clone out of the a11y tree / hit-testing.
    requestAnimationFrame(() => ghost.remove());
  }
}

// Orientation-aware physical screen height for the installed-PWA viewport
// fill (see main.tsx's fillStandaloneViewport + styles.css's `html.pwa-fill`
// doc comment for the full under-report story).
//
// window.screen.width/height report the PHYSICAL screen dimensions, but on
// iOS/iPadOS they are ORIENTATION-BLIND: window.screen.height stays pinned to
// the device's native/portrait height in BOTH orientations (it does not swap
// with width on rotation the way window.innerWidth/innerHeight do). Reading
// it directly and setting --screen-h to it works by coincidence on an
// iPhone PWA (portrait-locked by the manifest, so the "wrong for landscape"
// case never triggers) but breaks on iPad, which supports landscape: in
// landscape the .app column is pinned to the taller portrait dimension,
// pushing the composer and sidebar rail-footer off the bottom of the actual
// (shorter) landscape viewport.
//
// Fix: derive the correct dimension for the CURRENT orientation from the
// screen's own two measurements instead of trusting whichever one the
// platform happens to label "height". A device's screen has one long edge
// and one short edge, regardless of rotation; landscape is always the short
// edge, portrait is always the long edge.
export function computeScreenH(
  screenWidth: number,
  screenHeight: number,
  isLandscape: boolean,
): number {
  return isLandscape ? Math.min(screenWidth, screenHeight) : Math.max(screenWidth, screenHeight);
}

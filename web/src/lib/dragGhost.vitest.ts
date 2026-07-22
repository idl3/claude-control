// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setStandaloneDragImage } from './dragGhost';

function makeRow(): HTMLElement {
  const rail = document.createElement('div');
  rail.className = 'rail';
  const row = document.createElement('div');
  row.className = 'session-item';
  row.textContent = 'my session';
  rail.appendChild(row);
  document.body.appendChild(rail);
  return row;
}

describe('setStandaloneDragImage', () => {
  it('points setDragImage at a body-level clone outside the rail layer', () => {
    const row = makeRow();
    const setDragImage = vi.fn();
    setStandaloneDragImage(
      { clientX: 10, clientY: 5, dataTransfer: { setDragImage } },
      row,
    );
    expect(setDragImage).toHaveBeenCalledTimes(1);
    const ghost = setDragImage.mock.calls[0][0] as HTMLElement;
    expect(ghost).not.toBe(row);
    // Standalone: parked under <body>, NOT inside the backdrop-filter rail.
    expect(ghost.parentElement).toBe(document.body);
    expect(ghost.closest('.rail')).toBeNull();
    expect(ghost.style.position).toBe('fixed');
    expect(ghost.textContent).toBe('my session');
  });

  it('removes the ghost on the next animation frame', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const row = makeRow();
    const before = document.body.querySelectorAll('.session-item').length;
    setStandaloneDragImage(
      { clientX: 0, clientY: 0, dataTransfer: { setDragImage: vi.fn() } },
      row,
    );
    expect(document.body.querySelectorAll('.session-item').length).toBe(before);
    vi.unstubAllGlobals();
  });

  it('no-ops without dataTransfer/setDragImage (jsdom-native drags)', () => {
    const row = makeRow();
    expect(() =>
      setStandaloneDragImage({ clientX: 0, clientY: 0, dataTransfer: null }, row),
    ).not.toThrow();
  });
});

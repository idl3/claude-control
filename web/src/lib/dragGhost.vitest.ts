// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createPointerGhost } from './dragGhost';

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

describe('createPointerGhost', () => {
  it('appends a body-level clone outside the rail layer', () => {
    const row = makeRow();
    const g = createPointerGhost(row, 10, 5);
    const ghost = document.body.lastElementChild as HTMLElement;
    expect(ghost).not.toBe(row);
    // Standalone: parked under <body>, NOT inside the backdrop-filter rail —
    // WebKit would composite an in-rail clone against the whole glass layer.
    expect(ghost.parentElement).toBe(document.body);
    expect(ghost.closest('.rail')).toBeNull();
    expect(ghost.textContent).toBe('my session');
    expect(ghost.style.position).toBe('fixed');
    // Must never intercept hit-testing (elementFromPoint drop probe) nor the
    // pointer events driving the drag.
    expect(ghost.style.pointerEvents).toBe('none');
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    g.destroy();
  });

  it('move() repositions via transform translate3d honoring the grab offset', () => {
    // jsdom rects are all zeros, so a grab at (10, 5) IS the offset: the
    // initial placement lands the row's origin at (0, 0) and every move()
    // keeps that grab point under the cursor.
    const row = makeRow();
    const g = createPointerGhost(row, 10, 5);
    const ghost = document.body.lastElementChild as HTMLElement;
    expect(ghost.style.transform).toBe('translate3d(0px, 0px, 0)');
    g.move(110, 55);
    expect(ghost.style.transform).toBe('translate3d(100px, 50px, 0)');
    // Compositor-only motion: top/left stay parked at 0, never animated.
    expect(ghost.style.top).toBe('0px');
    expect(ghost.style.left).toBe('0px');
    g.destroy();
  });

  it('destroy() removes the ghost and is safe to call twice', () => {
    const row = makeRow();
    const g = createPointerGhost(row, 0, 0);
    const withGhost = document.body.querySelectorAll('.session-item').length;
    g.destroy();
    expect(document.body.querySelectorAll('.session-item').length).toBe(withGhost - 1);
    expect(() => g.destroy()).not.toThrow();
  });
});

#!/usr/bin/env python3
"""Hermetic E2E acceptance gate for two agent-terminal-overlay bugs:

  BUG 2 (drag-select): in copy/select mode, `.agent-term-canvas .term-canvas`'s
  `overflow-x:auto` scroll container claimed a press-drag as a pan instead of
  letting it reach xterm's native SelectionService. Fixed with a copy-mode-
  scoped CSS override (styles.css) that sets `overflow-x:hidden;
  touch-action:none` only when `[data-copy-mode='true']`.

  BUG 1 (cursor/input-row offset): `applyPaneScale`'s fontSize convergence
  loop (XtermHost.tsx) could land on a fractional fontSize -> fractional cell
  height, which the DOM renderer (active whenever the WebGL addon is
  unavailable -- real WebKit here, matching the operator's Safari/iOS) rounds
  per row, accumulating drift down the pane. Fixed by rounding fontSize to an
  integer in the convergence loop.

Reuses the hermetic "throwaway server.js instance" idiom from
web/scratch/artifact-gallery-e2e.py wholesale: own scratch port, own token
state (tokenless via a HOME override), own media/projects root, real :4317
never touched, synthetic tmux pane instead of a spawned `claude` process.

Two modes:
  - default: full strict gate -- BUG 2 (Chromium: real drag-select + Copy +
    typing-mode pan) and BUG 1 (WebKit: cursor/row alignment <=2px) both run
    with real assertions. Exit 0 only if everything passes.
  - E2E_BUG1_MEASURE_ONLY=1: runs only the BUG 1 WebKit measurement, prints
    the delta, and does NOT assert the <=2px threshold. Used to capture a
    pre-fix baseline number by rebuilding web/dist off a stashed (pre-fix)
    XtermHost.tsx, then diffing against a post-fix run of the same mode.

Run (from repo root, after `npm run build` in web/ so web/dist is fresh):
  python3 web/scratch/agent-term-drag-select-e2e.py
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from uuid import uuid4

from playwright.sync_api import sync_playwright

REPO_ROOT = Path(__file__).resolve().parents[2]
SPARE_PORT = 4427
LIVE_PORT = 4317
SCREENSHOT_DIR = Path.home() / '.claude-control' / 'media' / 'agent-term-select'

TMUX_COLS = 220
TMUX_ROWS = 40
FIXTURE_LINES = 70
MARKER_LINE_INDEX = 60  # 0-based; last(ROWS-1) lines stay visible post-scroll, see module doc below
MARKER_TEXT = 'SELECTME_ABCDEFGHIJKLMNOP_ENDLINE'
SELECT_SUBSTRING = 'ABCDEFGHIJKLMNOP'
PROMPT = 'CCPROMPT$'
PARTIAL_CMD = 'echo CURSOR_PROBE_LEAVE_ME'

BUG1_MEASURE_ONLY = os.environ.get('E2E_BUG1_MEASURE_ONLY') == '1'

# --- JS snippets run inside the page, evaluated against the XtermHost
# container that stashes `xtermInstance` on itself (XtermHost.tsx) purely so
# a Playwright test can reach the real terminal instance. -----------------

GET_TERM_STATE_JS = """
() => {
  const el = document.querySelector('.agent-term-canvas .term-canvas');
  if (!el) return null;
  const term = el.xtermInstance;
  if (!term) return null;
  return { cols: term.cols, rows: term.rows, fontSize: term.options.fontSize };
}
"""

FIND_MARKER_JS = """
() => {
  const el = document.querySelector('.agent-term-canvas .term-canvas');
  const term = el.xtermInstance;
  const buf = term.buffer.active;
  const marker = 'SELECTME_ABCDEFGHIJKLMNOP_ENDLINE';
  const needle = 'ABCDEFGHIJKLMNOP';
  for (let row = 0; row < term.rows; row++) {
    const line = buf.getLine(buf.viewportY + row);
    if (!line) continue;
    const text = line.translateToString(true);
    if (text.includes(marker)) {
      const startCol = text.indexOf(needle);
      return { row, startCol, endCol: startCol + needle.length, text };
    }
  }
  return null;
}
"""

ROW_GEOMETRY_JS = """
(row) => {
  const el = document.querySelector('.agent-term-canvas .term-canvas');
  const term = el.xtermInstance;
  const screenEl = el.querySelector('.xterm-screen');
  const screenRect = screenEl.getBoundingClientRect();
  const core = term._core;
  const rs = core && core._renderService;
  const cell = rs && rs.dimensions && rs.dimensions.css && rs.dimensions.css.cell;
  // Computed from screen geometry + cell metrics rather than querying
  // `.xterm-rows > div` -- BUG 2's drag-select fix is CSS-only (the
  // `.term-canvas` scroll-container override) and has nothing to do with
  // which xterm renderer is active, but WebGL is active by default in this
  // Chromium build (no `.xterm-rows` DOM nodes exist then), so the row
  // coordinates this drives the mouse with must work under either renderer.
  const cellWidth = (cell && cell.width) ? cell.width : screenRect.width / term.cols;
  const cellHeight = (cell && cell.height) ? cell.height : screenRect.height / term.rows;
  return {
    screenLeft: screenRect.left,
    rowTop: screenRect.top + row * cellHeight,
    rowHeight: cellHeight,
    cellWidth,
  };
}
"""

GET_SELECTION_JS = """
() => document.querySelector('.agent-term-canvas .term-canvas').xtermInstance.getSelection()
"""

CLEAR_SELECTION_JS = """
() => document.querySelector('.agent-term-canvas .term-canvas').xtermInstance.clearSelection()
"""

CURSOR_ALIGNMENT_JS = """
() => {
  const el = document.querySelector('.agent-term-canvas .term-canvas');
  const term = el.xtermInstance;
  const cursorY = term.buffer.active.cursorY;
  const rowEls = el.querySelectorAll('.xterm-rows > div');
  const rowEl = rowEls[cursorY];
  const cursorEl = el.querySelector('.xterm-cursor');
  const core = term._core;
  const rs = core && core._renderService;
  const cell = rs && rs.dimensions && rs.dimensions.css && rs.dimensions.css.cell;
  const diag = {
    cursorY,
    hasRowEl: !!rowEl,
    hasCursorEl: !!cursorEl,
    fontSize: term.options.fontSize,
    cellHeightCss: cell ? cell.height : null,
    hasDomRows: !!el.querySelector('.xterm-rows'),
    hasScreenCanvas: !!el.querySelector('.xterm-screen canvas'),
  };
  if (!rowEl || !cursorEl) return diag;
  const rowRect = rowEl.getBoundingClientRect();
  const cursorRect = cursorEl.getBoundingClientRect();
  return { ...diag, rowTop: rowRect.top, cursorTop: cursorRect.top };
}
"""


def log(msg: str) -> None:
    print(f'[e2e] {msg}', flush=True)


def http_ok(url: str, timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def wait_for(predicate, timeout_s: float, interval_s: float = 0.3, what: str = 'condition'):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval_s)
    raise TimeoutError(f'timed out waiting for: {what}')


def tmux_capture(pane_target: str) -> str:
    r = subprocess.run(
        ['tmux', 'capture-pane', '-p', '-t', pane_target],
        check=True, capture_output=True, text=True,
    )
    return r.stdout


def tmux_last_nonblank_line(pane_target: str) -> str:
    for line in reversed(tmux_capture(pane_target).splitlines()):
        if line.strip():
            return line.rstrip()
    return ''


def select_session(page, tmux_session: str):
    row = page.locator('.session-item[data-kind="claude"]').filter(has_text=tmux_session).first
    row.wait_for(state='visible', timeout=10_000)
    row.click()


def open_overlay(page):
    page.get_by_label('Open agent terminal').click()
    page.locator('.agent-term-panel[role="dialog"]').wait_for(state='visible', timeout=10_000)


def wait_for_convergence(page, cols: int, requested_rows: int, timeout_s: float = 15):
    """Poll until XtermHost's applyPaneScale settles: grid pinned to the
    tmux pane's real (cols, rows) AND fontSize hasn't changed for 3
    consecutive 250ms polls (~750ms stable).

    `cols` must match exactly (no client-side row/column reservation applies
    horizontally). `requested_rows` is what we asked tmux for with `-y`, but
    the pty-bridge's own client attachment reserves 1 row for tmux's status
    line, so the real reported `rows` is `requested_rows - 1` -- tolerate a
    small band rather than hardcoding that exact offset."""
    deadline = time.time() + timeout_s
    last_fs = None
    stable = 0
    last_state = None
    while time.time() < deadline:
        st = page.evaluate(GET_TERM_STATE_JS)
        last_state = st
        if st and st['cols'] == cols and requested_rows - 2 <= st['rows'] <= requested_rows:
            if last_fs is not None and st['fontSize'] == last_fs:
                stable += 1
                if stable >= 3:
                    return st
            else:
                stable = 0
            last_fs = st['fontSize']
        else:
            stable = 0
            last_fs = None
        time.sleep(0.25)
    raise TimeoutError(f'pane-scale convergence did not settle within {timeout_s}s (last={last_state})')


def spawn_hermetic_server(tmp_root: Path):
    fake_home = tmp_root / 'fake-home'
    media_dir = tmp_root / 'media'
    projects_dir = tmp_root / 'projects'
    for d in (fake_home, media_dir / 'apps', projects_dir, tmp_root / 'uploads', tmp_root / 'present'):
        d.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env.update({
        'HOME': str(fake_home),
        'CLAUDE_CONTROL_PORT': str(SPARE_PORT),
        'CLAUDE_CONTROL_HOST': '127.0.0.1',
        'CLAUDE_CONTROL_PROJECTS': str(projects_dir),
        'CLAUDE_CONTROL_SINGLE_ROOT': '1',
        'CLAUDE_CONTROL_MEDIA': str(media_dir),
        'CLAUDE_CONTROL_UPLOADS': str(tmp_root / 'uploads'),
        'CLAUDE_CONTROL_PRESENT': str(tmp_root / 'present'),
        'CLAUDE_CONTROL_PINS': str(tmp_root / 'pins.json'),
        'CLAUDE_CONTROL_NO_REAP': '1',
    })
    env.pop('CLAUDE_CONTROL_TOKEN', None)
    log(f'spawning hermetic server.js on :{SPARE_PORT}')
    proc = subprocess.Popen(
        ['node', 'server.js'], cwd=str(REPO_ROOT), env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    wait_for(lambda: http_ok(f'http://127.0.0.1:{SPARE_PORT}/api/health'), 15,
             what='hermetic server /api/health 200')
    log('hermetic server is up')
    return proc


def create_tmux_fixture(tmp_root: Path):
    proj_cwd = (tmp_root / 'proj').resolve()
    proj_cwd.mkdir(parents=True, exist_ok=True)
    tmux_session = f'cc-e2e-{uuid4().hex[:8]}'

    # `zsh -f` (skip rc files): the operator's real ~/.zshrc pulls in
    # starship/mise/direnv/olam/fzf eval hooks that are slow and non-
    # hermetic (and interact badly with oh-my-zsh's ZSH_TMUX_AUTOSTART,
    # which otherwise tries to nest another tmux session) -- confirmed by
    # capturing a totally blank pane with the plain shell. `-f` gives a
    # bare, fast, deterministic zsh prompt with none of that.
    subprocess.run(
        ['tmux', 'new-session', '-d', '-s', tmux_session, '-c', str(proj_cwd),
         '-x', str(TMUX_COLS), '-y', str(TMUX_ROWS), 'zsh -f'],
        check=True,
    )
    pane_target = subprocess.run(
        ['tmux', 'list-panes', '-t', tmux_session, '-F', '#{session_name}:#{window_index}.#{pane_index}'],
        check=True, capture_output=True, text=True,
    ).stdout.strip().splitlines()[0]
    subprocess.run(['tmux', 'set-option', '-p', '-t', pane_target, '@cc_agent', 'claude'], check=True)
    subprocess.run(['tmux', 'rename-window', '-t', tmux_session, tmux_session], check=True)
    log(f'created tmux session {tmux_session} (pane {pane_target}) at cwd={proj_cwd}')

    # Deterministic prompt so we can poll tmux (not the browser) for "cat
    # finished" / "partial command rendered" without racing pty timing.
    subprocess.run(['tmux', 'send-keys', '-t', pane_target, f"export PS1='{PROMPT} '", 'Enter'], check=True)
    wait_for(lambda: tmux_last_nonblank_line(pane_target) == PROMPT, 8, what='PS1 applied')

    # Fixture: FIXTURE_LINES rows, one embedding the SELECTME marker. Screen
    # is TMUX_ROWS tall; once total printed rows since the `cat` command
    # exceed TMUX_ROWS, the pty scrolls so the newest rows land at the
    # bottom -- placing the marker near the end (not right at the start)
    # keeps it comfortably inside the visible window with margin either way.
    lines = []
    for i in range(FIXTURE_LINES):
        lines.append(MARKER_TEXT if i == MARKER_LINE_INDEX else f'filler-row-{i:03d}-' + ('x' * 20))
    fixture_path = tmp_root / 'fixture.txt'
    fixture_path.write_text('\n'.join(lines) + '\n')

    subprocess.run(['tmux', 'send-keys', '-t', pane_target, f'cat {fixture_path}', 'Enter'], check=True)
    wait_for(lambda: tmux_last_nonblank_line(pane_target) == PROMPT, 8, what='cat finished, fresh prompt returned')

    # Leave a partial, un-submitted command at the cursor (no Enter) -- this
    # is the row BUG 1 measures (the freshly-typed, lowest visible row).
    subprocess.run(['tmux', 'send-keys', '-t', pane_target, '-l', PARTIAL_CMD], check=True)
    wait_for(lambda: tmux_last_nonblank_line(pane_target) == f'{PROMPT} {PARTIAL_CMD}', 8,
             what='partial command rendered at prompt')

    log('tmux fixture ready: cat output visible + partial command at cursor row')
    return tmux_session, pane_target


def run_bug2_chromium(base_url: str) -> dict:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={'width': 1400, 'height': 960}, reduced_motion='reduce')
        context.grant_permissions(['clipboard-read', 'clipboard-write'], origin=base_url)
        page = context.new_page()
        page.goto(base_url)

        select_session(page, TMUX_SESSION)
        open_overlay(page)
        state = wait_for_convergence(page, TMUX_COLS, TMUX_ROWS)
        log(f'[chromium] pane-scale converged: {state}')

        # --- enter copy/select mode ---
        page.locator('.modal-copytoggle').click()
        page.wait_for_selector('.modal-copytoggle[aria-pressed="true"]', timeout=5_000)

        found = page.evaluate(FIND_MARKER_JS)
        assert found, 'SELECTME marker row not found on screen (fixture/scroll assumption broke)'
        geo = page.evaluate(ROW_GEOMETRY_JS, found['row'])
        cell_w = geo['cellWidth']
        start_x = geo['screenLeft'] + found['startCol'] * cell_w + 1
        end_x = geo['screenLeft'] + found['endCol'] * cell_w - 1
        mid_x = (start_x + end_x) / 2
        row_y = geo['rowTop'] + geo['rowHeight'] / 2

        page.evaluate(CLEAR_SELECTION_JS)
        page.mouse.move(start_x, row_y)
        page.mouse.down()
        page.mouse.move(mid_x, row_y, steps=8)
        page.mouse.move(end_x, row_y, steps=8)
        SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SCREENSHOT_DIR / 'mid-drag-selection.png'))  # still holding the button
        page.mouse.up()

        selection = page.evaluate(GET_SELECTION_JS)
        assert selection == SELECT_SUBSTRING, (
            f'BUG 2: expected exact partial drag-select {SELECT_SUBSTRING!r}, got {selection!r} '
            '(a full/empty selection means the drag was claimed as a pan, not reaching xterm)'
        )
        log(f'[chromium] drag-select produced exact partial substring: {selection!r}')

        copy_btn = page.get_by_role('button', name='Copy', exact=True)
        copy_btn.wait_for(state='visible', timeout=5_000)
        copy_btn.click()
        page.wait_for_timeout(150)
        clipboard = page.evaluate('async () => await navigator.clipboard.readText()')
        assert clipboard == SELECT_SUBSTRING, f'BUG 2: clipboard mismatch, expected {SELECT_SUBSTRING!r} got {clipboard!r}'
        log(f'[chromium] Copy button copied exact substring: {clipboard!r}')
        page.screenshot(path=str(SCREENSHOT_DIR / 'after-copy.png'))

        # --- exit copy mode -> typing mode must still pan ---
        # `.agent-term-canvas .term-canvas` has no JS drag-to-pan handler at
        # all (confirmed: no pointerdown/mousedown listener anywhere in
        # XtermHost.tsx/AgentTerminalOverlay.tsx) -- its "pan" is the
        # container's own native `overflow-x:auto` +
        # `-webkit-overflow-scrolling:touch` scrolling, driven by wheel/
        # trackpad/touch gestures, not a synthesized mouse press-drag (which
        # is exactly the gesture BUG 2's fix repoints at xterm's selection
        # service in copy mode instead). A horizontal wheel scroll is the
        # deterministic, cross-browser-reliable desktop equivalent of that
        # native pan and is what a real trackpad two-finger swipe dispatches;
        # it's the correct way to prove the CSS fix didn't leak `overflow-x:
        # hidden`/`touch-action:none` into typing mode.
        page.locator('.modal-copytoggle').click()
        page.wait_for_selector('.modal-copytoggle[aria-pressed="false"]', timeout=5_000)

        canvas = page.locator('.agent-term-canvas .term-canvas')
        overflow_x = canvas.evaluate("(el) => getComputedStyle(el).overflowX")
        touch_action = canvas.evaluate("(el) => getComputedStyle(el).touchAction")
        assert overflow_x == 'auto', f'BUG 2 regression check: typing-mode overflow-x should be auto, got {overflow_x!r}'
        assert touch_action != 'none', f'BUG 2 regression check: typing-mode touch-action should allow panning, got {touch_action!r}'

        scroll_before = canvas.evaluate('(el) => el.scrollLeft')
        box = canvas.bounding_box()
        page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
        page.mouse.wheel(200, 0)
        page.wait_for_timeout(150)
        scroll_after = canvas.evaluate('(el) => el.scrollLeft')
        assert scroll_after != scroll_before, (
            f'BUG 2 regression check: typing-mode wheel-scroll should still pan, scrollLeft stayed at {scroll_before}'
        )
        log(f'[chromium] typing-mode wheel-scroll still pans: scrollLeft {scroll_before} -> {scroll_after}')

        browser.close()
        return {
            'selection': selection,
            'clipboard': clipboard,
            'scroll_before': scroll_before,
            'scroll_after': scroll_after,
        }


def run_bug1_webkit() -> dict:
    with sync_playwright() as p:
        browser = p.webkit.launch()
        context = browser.new_context(viewport={'width': 1400, 'height': 960}, reduced_motion='reduce')
        # BUG 1 is specifically a DOM-renderer bug (fractional cell-height
        # rounding, one <div> per row) -- but Playwright's WebKit build DOES
        # support WebGL2 headlessly, so XtermHost's unconditional `new
        # WebglAddon()` (XtermHost.tsx:150) succeeds and the canvas renderer
        # takes over, leaving no `.xterm-rows`/`.xterm-cursor` DOM nodes to
        # measure (confirmed empirically: hasScreenCanvas=true, hasDomRows=
        # false). Real Safari/iOS users regularly fall back to the DOM
        # renderer (WebGL2 disabled by Low Power Mode, Private Browsing,
        # exhausted context budget, etc.) -- XtermHost already codes that
        # fallback via the try/catch at line 150-157. Force that exact path
        # here by making `getContext('webgl'|'webgl2')` return null (2d
        # contexts, used for glyph-width measurement, are untouched), so the
        # test exercises the real fallback branch instead of a renderer path
        # BUG 1 never manifests in.
        context.add_init_script(
            """
            const origGetContext = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (type, ...args) {
              if (type === 'webgl' || type === 'webgl2') return null;
              return origGetContext.call(this, type, ...args);
            };
            """
        )
        page = context.new_page()
        page.goto(BASE_URL)

        select_session(page, TMUX_SESSION)
        open_overlay(page)
        state = wait_for_convergence(page, TMUX_COLS, TMUX_ROWS)
        log(f'[webkit] pane-scale converged: {state}')

        measurement = page.evaluate(CURSOR_ALIGNMENT_JS)
        assert measurement and measurement.get('hasRowEl') and measurement.get('hasCursorEl'), (
            f'BUG 1: cursor/row measurement failed, diag={measurement}'
        )
        delta = abs(measurement['cursorTop'] - measurement['rowTop'])
        log(
            f"[webkit] BUG 1 measured delta: {delta:.2f}px "
            f"(fontSize={measurement['fontSize']}, cellHeightCss={measurement['cellHeightCss']}, "
            f"domRenderer={measurement['hasDomRows']})"
        )
        SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SCREENSHOT_DIR / 'cursor-alignment.png'))

        browser.close()
        return {'delta': delta, 'measurement': measurement}


def main() -> int:
    global TMUX_SESSION, BASE_URL

    assert http_ok(f'http://127.0.0.1:{LIVE_PORT}/'), 'live :4317 must be up (200) before the test starts'
    log(f'baseline: live :{LIVE_PORT} is 200')

    tmp_root = Path(tempfile.mkdtemp(prefix='agent-term-drag-select-e2e-')).resolve()
    server_proc = None
    tmux_session = None

    try:
        server_proc = spawn_hermetic_server(tmp_root)
        tmux_session, pane_target = create_tmux_fixture(tmp_root)
        TMUX_SESSION = tmux_session
        BASE_URL = f'http://127.0.0.1:{SPARE_PORT}'  # no trailing slash: must be an exact origin for grant_permissions

        def session_visible():
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{SPARE_PORT}/api/sessions', timeout=2) as r:
                    data = json.loads(r.read())
                    sessions = data.get('sessions', data) if isinstance(data, dict) else data
                    return any(s.get('target') == pane_target for s in sessions)
            except Exception:
                return False

        # The hermetic server shares the operator's real tmux socket (same
        # pattern as artifact-gallery-e2e.py), so /api/sessions enumerates
        # every real session too -- with dozens of real sessions the
        # SessionRegistry refresh cycle can take a bit over the usual 12s.
        wait_for(session_visible, 20, what='synthetic session bound + visible via /api/sessions')
        log('synthetic session is bound and visible')

        if BUG1_MEASURE_ONLY:
            result = run_bug1_webkit()
            log(f"MEASURE-ONLY: BUG 1 delta = {result['delta']:.2f}px")
            return 0

        bug2_result = run_bug2_chromium(BASE_URL)
        bug1_result = run_bug1_webkit()

        screenshots = [
            SCREENSHOT_DIR / 'mid-drag-selection.png',
            SCREENSHOT_DIR / 'after-copy.png',
            SCREENSHOT_DIR / 'cursor-alignment.png',
        ]
        for shot in screenshots:
            assert shot.exists() and shot.stat().st_size > 0, f'screenshot not written: {shot}'
        log('screenshots confirmed on disk: ' + ', '.join(str(s) for s in screenshots))

        assert bug1_result['delta'] <= 2, (
            f"BUG 1: cursor/row misalignment {bug1_result['delta']:.2f}px exceeds the 2px threshold"
        )
        log(f"BUG 1 PASS: delta {bug1_result['delta']:.2f}px <= 2px")
        log(
            f"BUG 2 PASS: dragged/copied substring={bug2_result['selection']!r}, "
            f"typing-mode scrollLeft {bug2_result['scroll_before']} -> {bug2_result['scroll_after']}"
        )

        assert http_ok(f'http://127.0.0.1:{LIVE_PORT}/'), 'live :4317 must still be 200 after the test'
        log(f'live :{LIVE_PORT} still 200 after the test')

        log('PASS')
        return 0

    finally:
        log('tearing down')
        if tmux_session:
            subprocess.run(['tmux', 'kill-session', '-t', tmux_session], check=False, stderr=subprocess.DEVNULL)
        if server_proc is not None:
            server_proc.terminate()
            try:
                server_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server_proc.kill()
                server_proc.wait(timeout=5)
        shutil.rmtree(tmp_root, ignore_errors=True)
        log('teardown complete (spawned server killed, tmux session killed, tmp dirs removed)')


if __name__ == '__main__':
    sys.exit(main())

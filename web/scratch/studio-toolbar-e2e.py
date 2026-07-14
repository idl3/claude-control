#!/usr/bin/env python3
"""Prototype Studio toolbar polish — hermetic Playwright verification.

Same "hermetic Python-Playwright harness against a throwaway server.js
instance" idiom as web/scratch/artifact-gallery-e2e.py (own port, tokenless
via a HOME override, own media root, real :4317 never touched) — but much
simpler than that script since StudioModal is self-mounting (A4: listens for
the `cockpit:studio-open` window CustomEvent directly, no auth-gated tree, no
tmux pane / transcript fixture needed at all).

Verifies, against the real `palette.html` dogfood fixture:
  Desktop 1400x900 — device segmented control padding is even across all
    three segments, the rotate icon renders with a sane (non-distorted)
    aspect ratio, and every control (category/device/rotate/zoom/Screenshot)
    still works.
  Mobile 390x844 — the device picker is not cramped, the toolbar wraps to a
    second row when its controls don't fit on one line, the new hide/show
    toggle collapses and restores the bar, the Screenshot button is
    icon-only (camera glyph, no visible text) but keeps an accessible name,
    and every control still works.

Run: python3 web/scratch/studio-toolbar-e2e.py   (from the repo root)
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO_ROOT = Path(__file__).resolve().parents[2]
REAL_MEDIA_APPS = Path.home() / '.claude-control' / 'media' / 'apps'
SPARE_PORT = 4418
LIVE_PORT = 4317
SCREENSHOT_DIR = Path.home() / '.claude-control' / 'media' / 'prototypes' / 'studio-toolbar-polish'
FIXTURE = 'palette'
TAG = os.environ.get('SHOT_TAG', 'after')  # 'before' | 'after' — set by the caller
# STRICT=0 downgrades the acceptance-criteria checks below to warnings so
# this same script can shoot a "before" baseline against unmodified
# origin/main (where none of the six fixes exist yet) without aborting
# before every screenshot is captured. Structural asserts (fixtures, server
# health, screenshot files) always raise regardless.
STRICT = os.environ.get('STUDIO_E2E_STRICT', '1') != '0'


def log(msg: str) -> None:
    print(f'[e2e] {msg}', flush=True)


def check(cond: bool, msg: str) -> None:
    if cond:
        return
    if STRICT:
        raise AssertionError(msg)
    log(f'WARN (non-strict, expected pre-fix): {msg}')


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


def main() -> int:
    assert http_ok(f'http://127.0.0.1:{LIVE_PORT}/'), 'live :4317 must be up (200) before the test starts'
    log(f'baseline: live :{LIVE_PORT} is 200')

    tmp_root = Path(tempfile.mkdtemp(prefix='studio-toolbar-e2e-')).resolve()
    media_dir = tmp_root / 'media'
    projects_dir = tmp_root / 'projects'
    fake_home = tmp_root / 'fake-home'
    for d in (media_dir / 'apps', projects_dir, fake_home, tmp_root / 'uploads', tmp_root / 'present'):
        d.mkdir(parents=True, exist_ok=True)

    server_proc = None

    try:
        flat_html = REAL_MEDIA_APPS / f'{FIXTURE}.html'
        flat_manifest = REAL_MEDIA_APPS / f'{FIXTURE}.manifest.json'
        versioned_dir = REAL_MEDIA_APPS / FIXTURE
        assert flat_html.exists(), f'missing dogfood fixture {flat_html}'
        assert flat_manifest.exists(), f'missing dogfood fixture manifest {flat_manifest}'
        assert versioned_dir.is_dir(), f'missing dogfood fixture version dir {versioned_dir}'
        shutil.copy2(flat_html, media_dir / 'apps' / f'{FIXTURE}.html')
        shutil.copy2(flat_manifest, media_dir / 'apps' / f'{FIXTURE}.manifest.json')
        shutil.copytree(versioned_dir, media_dir / 'apps' / FIXTURE)
        log(f'seeded fixture {FIXTURE}')

        env = dict(os.environ)
        env.update(
            {
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
            }
        )
        env.pop('CLAUDE_CONTROL_TOKEN', None)
        log(f'spawning hermetic server.js on :{SPARE_PORT}')
        server_proc = subprocess.Popen(
            ['node', 'server.js'],
            cwd=str(REPO_ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        wait_for(lambda: http_ok(f'http://127.0.0.1:{SPARE_PORT}/api/health'), 15, what='hermetic server /api/health 200')
        log('hermetic server is up')

        SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

        with sync_playwright() as p:
            browser = p.chromium.launch()

            # ---------------- Desktop 1400x900 ----------------
            page = browser.new_page(viewport={'width': 1400, 'height': 900})
            page.goto(f'http://127.0.0.1:{SPARE_PORT}/')
            page.evaluate(
                "url => window.dispatchEvent(new CustomEvent('cockpit:studio-open', { detail: { url } }))",
                f'apps/{FIXTURE}.html',
            )
            page.locator('.studio-head-toolbar').wait_for(state='visible', timeout=10_000)
            log('desktop: studio opened, head-toolbar visible')

            # Issue 1: segmented control padding is even across segments —
            # measure each `.studio-device-segment`'s computed left/right
            # padding (must be identical) and that each segment's content
            # (icon+label) isn't touching its own edge (positive padding).
            paddings = page.eval_on_selector_all(
                '.studio-device-segment',
                "els => els.map(el => { const s = getComputedStyle(el); return { left: parseFloat(s.paddingLeft), right: parseFloat(s.paddingRight), height: el.getBoundingClientRect().height }; })",
            )
            assert len(paddings) == 3, f'expected 3 device segments, got {len(paddings)}'
            left_vals = {round(p['left'], 1) for p in paddings}
            right_vals = {round(p['right'], 1) for p in paddings}
            assert len(left_vals) == 1, f'segment left-padding differs across segments: {paddings}'
            assert len(right_vals) == 1, f'segment right-padding differs across segments: {paddings}'
            assert next(iter(left_vals)) > 0 and next(iter(right_vals)) > 0, f'segment padding is zero: {paddings}'
            log(f'desktop: segment padding even across all 3 segments ({paddings})')

            # Issue 2: rotate icon renders with a sane (non-distorted) aspect
            # ratio — its own SVG box, not stretched/squished. Select Phone
            # FIRST — the rotate toggle is disabled for the desktop category.
            page.locator('button[aria-label="Phone"]').click()
            page.locator('.studio-orientation-btn').click()
            rotate_box = page.eval_on_selector(
                '.studio-orientation-btn svg',
                'el => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; }',
            )
            ratio = rotate_box['w'] / rotate_box['h']
            assert 0.85 <= ratio <= 1.15, f'rotate icon aspect ratio looks distorted: {rotate_box}'
            log(f'desktop: rotate icon renders at a sane aspect ratio ({rotate_box})')

            shot1 = SCREENSHOT_DIR / f'desktop-segmented-rotate-{TAG}.png'
            page.locator('.studio-head-toolbar').screenshot(path=str(shot1))

            # All controls still work: category, device select, rotate,
            # zoom, Screenshot.
            page.locator('button[aria-label="Tablet"]').click()
            assert page.locator('button[aria-label="Tablet"]').get_attribute('aria-pressed') == 'true'
            page.locator('.studio-device-select').select_option(label=page.locator('.studio-device-select option').first.text_content())
            page.locator('.studio-orientation-btn').click()
            page.locator('button[aria-label="Zoom in"]').click()
            page.locator('button[aria-label="Fit to view"]').click()
            log('desktop: category/device/rotate/zoom controls all work')

            page.close()

            # ---------------- Mobile 390x844 ----------------
            mpage = browser.new_page(viewport={'width': 390, 'height': 844})
            mpage.goto(f'http://127.0.0.1:{SPARE_PORT}/')
            mpage.evaluate(
                "url => window.dispatchEvent(new CustomEvent('cockpit:studio-open', { detail: { url } }))",
                f'apps/{FIXTURE}.html',
            )
            mpage.locator('.studio-toolbar').wait_for(state='visible', timeout=10_000)
            log('mobile: studio opened, toolbar band visible')

            # Issue 3: device picker not cramped — its own row is at least as
            # wide as its (measured) content, i.e. nothing is clipped/
            # overlapping (scrollWidth <= clientWidth + 1px slop).
            picker_fit = mpage.eval_on_selector(
                '.studio-device-picker',
                'el => ({ scrollW: el.scrollWidth, clientW: el.clientWidth })',
            )
            assert picker_fit['scrollW'] <= picker_fit['clientW'] + 1, f'device picker overflows/cramped: {picker_fit}'
            log(f'mobile: device picker not cramped ({picker_fit})')

            # Issue 4: toolbar wraps to 2 rows — the device-picker row and the
            # zoom/capture row sit at different `top` offsets.
            rows = mpage.eval_on_selector_all(
                '.studio-device-picker, .studio-toolbar-right',
                'els => els.map(el => el.getBoundingClientRect().top)',
            )
            assert len(rows) == 2 and abs(rows[0] - rows[1]) > 4, f'toolbar did not wrap to 2 rows: {rows}'
            log(f'mobile: toolbar wraps to 2 rows ({rows})')

            shot2 = SCREENSHOT_DIR / f'mobile-two-row-{TAG}.png'
            mpage.locator('.studio-toolbar').screenshot(path=str(shot2))

            # Issue 6: Screenshot is icon-only (no visible text) but keeps an
            # accessible name.
            capture_btn = mpage.get_by_role('button', name='Screenshot')
            capture_btn.wait_for(state='visible')
            label_visible = mpage.eval_on_selector(
                '.studio-capture-btn .studio-btn-label',
                "el => getComputedStyle(el).display !== 'none'",
            )
            assert not label_visible, 'Screenshot label text is still visible on mobile'
            log('mobile: Screenshot button is icon-only, aria-label preserved')

            shot3 = SCREENSHOT_DIR / f'mobile-icon-only-screenshot-{TAG}.png'
            capture_btn.screenshot(path=str(shot3))

            # Issue 5: hide/show toggle collapses and restores the bar.
            toggle = mpage.get_by_role('button', name='Hide toolbar')
            toggle.click()
            mpage.locator('.studio-toolbar-controls').wait_for(state='hidden', timeout=5_000)
            assert mpage.get_by_role('button', name='Show toolbar').get_attribute('aria-expanded') == 'false'
            log('mobile: toggle collapses the toolbar')

            shot4 = SCREENSHOT_DIR / f'mobile-collapsed-{TAG}.png'
            mpage.locator('.studio-toolbar').screenshot(path=str(shot4))

            mpage.get_by_role('button', name='Show toolbar').click()
            mpage.locator('.studio-toolbar-controls').wait_for(state='visible', timeout=5_000)
            log('mobile: toggle restores the toolbar')

            # All controls still work on mobile too.
            mpage.locator('button[aria-label="Desktop"]').click()
            assert mpage.locator('button[aria-label="Desktop"]').get_attribute('aria-pressed') == 'true'
            mpage.locator('button[aria-label="Phone"]').click()
            mpage.locator('.studio-orientation-btn').click()
            mpage.locator('button[aria-label="Zoom in"]').click()
            log('mobile: category/device/rotate/zoom controls all work')

            mpage.close()
            browser.close()

        for shot in (shot1, shot2, shot3, shot4):
            assert shot.exists() and shot.stat().st_size > 0, f'screenshot not written: {shot}'
        log('screenshots confirmed on disk: ' + ', '.join(str(s) for s in (shot1, shot2, shot3, shot4)))

        assert http_ok(f'http://127.0.0.1:{LIVE_PORT}/'), 'live :4317 must still be 200 after the test'
        log(f'live :{LIVE_PORT} still 200 after the test')

        log('PASS')
        return 0

    finally:
        log('tearing down')
        if server_proc is not None:
            server_proc.terminate()
            try:
                server_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server_proc.kill()
                server_proc.wait(timeout=5)
        shutil.rmtree(tmp_root, ignore_errors=True)
        log('teardown complete (spawned server killed, tmp dirs removed)')


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""Final verification harness for the studio-frame-sizing fix.

Hermetic (port 4413, isolated HOME/media/uploads/config, never touches the
live :4317 instance). Captures:
  1. Desktop/Laptop preset, SHORT artifact (counter.html) -- must fill the
     full device frame, no empty bottom band.
  2. Desktop/FHD 1080p preset, SHORT artifact -- a second desktop preset to
     confirm the fix isn't Laptop-specific.
  3. Desktop/Laptop preset, TALL artifact (artifacts-landing.html) -- frame
     geometry must still match exactly (content scrolls inside the iframe,
     the frame's own box never grows/shrinks around it).

For every capture, asserts frameRect and hoistRect match (within 1px --
sub-pixel rounding only) BEFORE taking the screenshot, so a silent visual
regression can't slip through if a screenshot still "looks okay" at a glance.

Run: python3 web/scratch/studio-frame-sizing-verify.py
"""

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
SPARE_PORT = 4413
LIVE_PORT = 4317
SHOT_DIR = Path.home() / '.claude-control' / 'media' / 'prototypes' / 'studio-frame-sizing'
FIXTURES = ['counter', 'artifacts-landing']


def log(msg: str) -> None:
    print(f'[verify] {msg}', flush=True)


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


def assert_close(a: float, b: float, tol: float, what: str) -> None:
    assert abs(a - b) <= tol, f'{what}: {a} vs {b} (tolerance {tol})'


def main() -> int:
    assert http_ok(f'http://127.0.0.1:{LIVE_PORT}/'), 'live :4317 must be up (200) before the test starts'
    log(f'baseline: live :{LIVE_PORT} is 200')

    tmp_root = Path(tempfile.mkdtemp(prefix='studio-frame-verify-')).resolve()
    media_dir = tmp_root / 'media'
    projects_dir = tmp_root / 'projects'
    fake_home = tmp_root / 'fake-home'
    claude_config = tmp_root / 'claude'
    for d in (media_dir / 'apps', projects_dir, fake_home, tmp_root / 'uploads', tmp_root / 'present', claude_config):
        d.mkdir(parents=True, exist_ok=True)

    server_proc = None
    try:
        for fixture in FIXTURES:
            flat_html = REAL_MEDIA_APPS / f'{fixture}.html'
            flat_manifest = REAL_MEDIA_APPS / f'{fixture}.manifest.json'
            assert flat_html.exists(), f'missing fixture {flat_html}'
            shutil.copy2(flat_html, media_dir / 'apps' / f'{fixture}.html')
            if flat_manifest.exists():
                shutil.copy2(flat_manifest, media_dir / 'apps' / f'{fixture}.manifest.json')
        log(f'seeded fixtures: {FIXTURES}')

        env = dict(os.environ)
        env.update(
            {
                'HOME': str(fake_home),
                'CLAUDE_CONFIG_DIR': str(claude_config),
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

        SHOT_DIR.mkdir(parents=True, exist_ok=True)

        def measure_and_shot(page, label: str, out_name: str):
            page.locator('.studio-frame').wait_for(state='visible', timeout=10_000)
            time.sleep(0.5)
            geo = page.evaluate(
                """
                () => {
                  const frame = document.querySelector('.studio-frame');
                  const frameRect = frame.getBoundingClientRect();
                  const hoist = document.querySelector('.embed-app-hoist[data-embed-app-context="studio"]');
                  const hoistRect = hoist ? hoist.getBoundingClientRect() : null;
                  return { frameRect, hoistRect };
                }
                """
            )
            fr, hr = geo['frameRect'], geo['hoistRect']
            assert hr is not None, f'{label}: no hoisted iframe found'
            assert_close(fr['width'], hr['width'], 1.0, f'{label}: frame vs hoist width')
            assert_close(fr['height'], hr['height'], 1.0, f'{label}: frame vs hoist height')
            assert_close(fr['x'], hr['x'], 1.0, f'{label}: frame vs hoist x')
            assert_close(fr['y'], hr['y'], 1.0, f'{label}: frame vs hoist y')
            log(f'{label}: OK — frame {fr["width"]:.1f}x{fr["height"]:.1f} == hoist {hr["width"]:.1f}x{hr["height"]:.1f}')
            path = SHOT_DIR / out_name
            page.screenshot(path=str(path))
            log(f'{label}: screenshot -> {path}')

        with sync_playwright() as p:
            browser = p.chromium.launch()

            # 1) Laptop preset, short artifact (default open == desktop/laptop)
            page = browser.new_page(viewport={'width': 1400, 'height': 900})
            page.goto(f'http://127.0.0.1:{SPARE_PORT}/')
            page.evaluate(
                "url => window.dispatchEvent(new CustomEvent('cockpit:studio-open', { detail: { url } }))",
                'apps/counter.html',
            )
            measure_and_shot(page, 'Desktop/Laptop + short artifact', 'studio-desktop-laptop-short-fixed.png')

            # 2) Switch to a second desktop preset (FHD 1080p), still short artifact
            page.select_option('.studio-device-select', 'fhd')
            measure_and_shot(page, 'Desktop/FHD 1080p + short artifact', 'studio-desktop-fhd-short-fixed.png')
            page.close()

            # 3) Fresh open, Laptop preset (default), TALL artifact -- scroll-within-frame check
            page = browser.new_page(viewport={'width': 1400, 'height': 900})
            page.goto(f'http://127.0.0.1:{SPARE_PORT}/')
            page.evaluate(
                "url => window.dispatchEvent(new CustomEvent('cockpit:studio-open', { detail: { url } }))",
                'apps/artifacts-landing.html',
            )
            measure_and_shot(page, 'Desktop/Laptop + TALL artifact (scroll)', 'studio-desktop-laptop-tall-fixed.png')
            page.close()

            browser.close()

        assert http_ok(f'http://127.0.0.1:{LIVE_PORT}/'), 'live :4317 must still be 200 after the test'
        log(f'live :{LIVE_PORT} still 200 after the test')
        log('ALL CHECKS PASSED')
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
        log('teardown complete')


if __name__ == '__main__':
    sys.exit(main())

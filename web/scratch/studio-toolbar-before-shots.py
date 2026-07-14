#!/usr/bin/env python3
"""Baseline ("before") screenshots for the toolbar-polish PR. Same hermetic
server.js idiom as studio-toolbar-e2e.py, no assertions — just opens the
studio against the real `palette.html` fixture at desktop and mobile
viewports and screenshots the toolbar as-is. Run this against unmodified
origin/main (e.g. via `git stash`) before applying the six fixes.

Run: python3 web/scratch/studio-toolbar-before-shots.py   (from the repo root)
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
SPARE_PORT = 4418
LIVE_PORT = 4317
SCREENSHOT_DIR = Path.home() / '.claude-control' / 'media' / 'prototypes' / 'studio-toolbar-polish'
FIXTURE = 'palette'


def log(msg: str) -> None:
    print(f'[before] {msg}', flush=True)


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
    tmp_root = Path(tempfile.mkdtemp(prefix='studio-toolbar-before-')).resolve()
    media_dir = tmp_root / 'media'
    fake_home = tmp_root / 'fake-home'
    for d in (media_dir / 'apps', fake_home, tmp_root / 'projects', tmp_root / 'uploads', tmp_root / 'present'):
        d.mkdir(parents=True, exist_ok=True)
    server_proc = None
    try:
        shutil.copy2(REAL_MEDIA_APPS / f'{FIXTURE}.html', media_dir / 'apps' / f'{FIXTURE}.html')
        shutil.copy2(REAL_MEDIA_APPS / f'{FIXTURE}.manifest.json', media_dir / 'apps' / f'{FIXTURE}.manifest.json')
        shutil.copytree(REAL_MEDIA_APPS / FIXTURE, media_dir / 'apps' / FIXTURE)

        env = dict(os.environ)
        env.update(
            {
                'HOME': str(fake_home),
                'CLAUDE_CONTROL_PORT': str(SPARE_PORT),
                'CLAUDE_CONTROL_HOST': '127.0.0.1',
                'CLAUDE_CONTROL_PROJECTS': str(tmp_root / 'projects'),
                'CLAUDE_CONTROL_SINGLE_ROOT': '1',
                'CLAUDE_CONTROL_MEDIA': str(media_dir),
                'CLAUDE_CONTROL_UPLOADS': str(tmp_root / 'uploads'),
                'CLAUDE_CONTROL_PRESENT': str(tmp_root / 'present'),
                'CLAUDE_CONTROL_PINS': str(tmp_root / 'pins.json'),
                'CLAUDE_CONTROL_NO_REAP': '1',
            }
        )
        env.pop('CLAUDE_CONTROL_TOKEN', None)
        server_proc = subprocess.Popen(['node', 'server.js'], cwd=str(REPO_ROOT), env=env,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        wait_for(lambda: http_ok(f'http://127.0.0.1:{SPARE_PORT}/api/health'), 15, what='hermetic server up')
        log('hermetic server up')

        SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
        with sync_playwright() as p:
            browser = p.chromium.launch()

            page = browser.new_page(viewport={'width': 1400, 'height': 900}, device_scale_factor=3)
            page.goto(f'http://127.0.0.1:{SPARE_PORT}/')
            page.evaluate(
                "url => window.dispatchEvent(new CustomEvent('cockpit:studio-open', { detail: { url } }))",
                f'apps/{FIXTURE}.html',
            )
            page.locator('.studio-head-toolbar').wait_for(state='visible', timeout=10_000)
            page.locator('button[aria-label="Phone"]').click()  # enable rotate icon for the before-shot
            page.locator('.studio-head-toolbar').screenshot(path=str(SCREENSHOT_DIR / 'desktop-segmented-rotate-before.png'))
            page.locator('.studio-orientation-btn').screenshot(path=str(SCREENSHOT_DIR / 'desktop-rotate-icon-only-before.png'))
            log('desktop before-shot captured')
            page.close()

            mpage = browser.new_page(viewport={'width': 390, 'height': 844})
            mpage.goto(f'http://127.0.0.1:{SPARE_PORT}/')
            mpage.evaluate(
                "url => window.dispatchEvent(new CustomEvent('cockpit:studio-open', { detail: { url } }))",
                f'apps/{FIXTURE}.html',
            )
            mpage.locator('.studio-toolbar').wait_for(state='visible', timeout=10_000)
            mpage.locator('.studio-toolbar').screenshot(path=str(SCREENSHOT_DIR / 'mobile-two-row-before.png'))
            log('mobile before-shot captured')
            mpage.close()

            browser.close()

        assert http_ok(f'http://127.0.0.1:{LIVE_PORT}/'), 'live :4317 must still be 200 after the test'
        log('PASS')
        return 0
    finally:
        if server_proc is not None:
            server_proc.terminate()
            try:
                server_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server_proc.kill()
                server_proc.wait(timeout=5)
        shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())

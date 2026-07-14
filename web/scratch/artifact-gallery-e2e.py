#!/usr/bin/env python3
"""Phase C, C3: hermetic E2E for the per-session ArtifactGallery.

Spawns a throwaway `server.js` instance (own port/token/media root/projects
root — the operator's real :4317 instance is never touched), seeds a
synthetic tmux pane + transcript fixture embedding the two live dogfood
artifacts (markdown + react kinds), then drives Playwright to confirm the
gallery lists both with correct kind badges and that clicking each opens it
inline via the sandboxed iframe (srcDoc, title=<resolved url>).

Reused pattern: same "hermetic Python-Playwright harness against a throwaway
server.js instance" idiom described in commit 6901031 (Studio Phase E3) — own
port, own token state (tokenless via a HOME override), own media root, real
:4317 never touched. No prior harness script for a *server-spawning* E2E was
found committed anywhere in this codebase (only Vite-component-only harnesses
under web/scratch/*-harness/ exist) — this file establishes it from the
CONFIG/session-matching contracts read directly out of server.js,
lib/projects-roots.js, lib/sessions.js, and lib/media-apps.js.

Run: python3 web/scratch/artifact-gallery-e2e.py   (from the repo root)
"""

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from playwright.sync_api import sync_playwright

REPO_ROOT = Path(__file__).resolve().parents[2]
REAL_MEDIA_APPS = Path.home() / '.claude-control' / 'media' / 'apps'
SPARE_PORT = 4417
LIVE_PORT = 4317
SCREENSHOT_DIR = Path.home() / '.claude-control' / 'media' / 'prototypes' / 'artifacts-gallery'
FIXTURES = ['artifact-design-notes', 'pipeline-dashboard']  # markdown, react


def log(msg: str) -> None:
    print(f'[e2e] {msg}', flush=True)


def encode_cwd(cwd: str) -> str:
    # Mirrors lib/sessions.js's exported encodeCwd: cwd.replace(/[/.]/g, '-')
    return re.sub(r'[/.]', '-', cwd)


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

    tmp_root = Path(tempfile.mkdtemp(prefix='artifact-gallery-e2e-')).resolve()
    media_dir = tmp_root / 'media'
    projects_dir = tmp_root / 'projects'
    fake_home = tmp_root / 'fake-home'
    proj_cwd = (tmp_root / 'proj').resolve()
    for d in (media_dir / 'apps', projects_dir, fake_home, tmp_root / 'uploads', tmp_root / 'present', proj_cwd):
        d.mkdir(parents=True, exist_ok=True)

    tmux_session = f'cc-e2e-{uuid4().hex[:8]}'
    server_proc = None
    resolved_urls = {}

    try:
        # --- seed fixtures: copy both dogfood apps (flat pair + versioned
        # subdir + latest pointer) into the hermetic media root, byte-for-byte.
        for name in FIXTURES:
            flat_html = REAL_MEDIA_APPS / f'{name}.html'
            flat_manifest = REAL_MEDIA_APPS / f'{name}.manifest.json'
            versioned_dir = REAL_MEDIA_APPS / name
            assert flat_html.exists(), f'missing dogfood fixture {flat_html}'
            assert flat_manifest.exists(), f'missing dogfood fixture manifest {flat_manifest}'
            assert versioned_dir.is_dir(), f'missing dogfood fixture version dir {versioned_dir}'
            shutil.copy2(flat_html, media_dir / 'apps' / f'{name}.html')
            shutil.copy2(flat_manifest, media_dir / 'apps' / f'{name}.manifest.json')
            shutil.copytree(versioned_dir, media_dir / 'apps' / name)
            latest_stamped = (versioned_dir / 'latest').read_text().strip()
            resolved_urls[name] = f'apps/{name}/{latest_stamped}'
            kind = json.loads(flat_manifest.read_text()).get('artifactKind')
            log(f'seeded fixture {name}: kind={kind} latest={latest_stamped}')

        # --- seed the transcript: one project dir (slug from the fixture
        # pane's real resolved cwd) with one JSONL carrying both embed tags.
        slug = encode_cwd(str(proj_cwd))
        session_dir = projects_dir / slug
        session_dir.mkdir(parents=True, exist_ok=True)
        session_id = str(uuid4())
        now = datetime.now(timezone.utc)
        t0 = now.isoformat().replace('+00:00', 'Z')
        t1 = now.isoformat().replace('+00:00', 'Z')
        transcript_lines = [
            {
                'type': 'user',
                'uuid': str(uuid4()),
                'sessionId': session_id,
                'timestamp': t0,
                'cwd': str(proj_cwd),
                'message': {'role': 'user', 'content': 'seed two artifacts for the gallery test'},
            },
            {
                'type': 'assistant',
                'uuid': str(uuid4()),
                'sessionId': session_id,
                'timestamp': t1,
                'cwd': str(proj_cwd),
                'message': {
                    'role': 'assistant',
                    'model': 'claude-fixture',
                    'content': [
                        {
                            'type': 'text',
                            'text': (
                                'Here are two artifacts: '
                                '<embedded-app url="apps/artifact-design-notes.html" height="420" /> '
                                'and '
                                '<embedded-app url="apps/pipeline-dashboard.html" height="420" />'
                            ),
                        }
                    ],
                },
            },
        ]
        transcript_path = session_dir / f'{session_id}.jsonl'
        transcript_path.write_text('\n'.join(json.dumps(r) for r in transcript_lines) + '\n')
        log(f'seeded transcript {transcript_path}')

        # --- spawn the hermetic server. HOME is overridden to a fresh empty
        # dir so readPersistedToken()/os.homedir()-derived defaults (token,
        # codexSessionsRoot, iconFile, olam.json) never see the real operator
        # home — this is what makes CONFIG.token resolve to null (tokenless).
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

        # --- create the synthetic Claude pane. New, uniquely-named tmux
        # session (own socket-default, one-shot teardown via kill-session);
        # @cc_agent=claude fakes isClaudePane's classification without a real
        # `claude` process (paneKind short-circuits on this pane option).
        subprocess.run(
            ['tmux', 'new-session', '-d', '-s', tmux_session, '-c', str(proj_cwd), '-x', '220', '-y', '50'],
            check=True,
        )
        # This tmux config sets base-index/pane-base-index to 1 (not tmux's
        # own default of 0), so the pane target is never reliably ":0.0" —
        # resolve it from the session we just created instead of hardcoding.
        pane_target = subprocess.run(
            ['tmux', 'list-panes', '-t', tmux_session, '-F', '#{session_name}:#{window_index}.#{pane_index}'],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip().splitlines()[0]
        subprocess.run(
            ['tmux', 'set-option', '-p', '-t', pane_target, '@cc_agent', 'claude'],
            check=True,
        )
        # SessionRail's row label falls back to the tmux WINDOW name (default
        # "zsh", tmux's auto-name for an idle shell — indistinguishable from
        # any other real idle pane sharing the default tmux socket). Rename
        # the window to our unique session name so the row is unambiguously
        # locatable by visible text.
        subprocess.run(['tmux', 'rename-window', '-t', tmux_session, tmux_session], check=True)
        log(f'created tmux session {tmux_session} (pane {pane_target}) at cwd={proj_cwd}')

        def session_visible():
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{SPARE_PORT}/api/sessions', timeout=2) as r:
                    data = json.loads(r.read())
                    sessions = data.get('sessions', data) if isinstance(data, dict) else data
                    return any(s.get('sessionId') == session_id for s in sessions)
            except Exception:
                return False

        # SessionRegistry.REFRESH_INTERVAL_MS = 4000 — allow a full cycle + margin.
        wait_for(session_visible, 12, what='synthetic session bound + visible via /api/sessions')
        log('synthetic session is bound and visible')

        SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
        screenshots = []

        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={'width': 1280, 'height': 900})
            page.goto(f'http://127.0.0.1:{SPARE_PORT}/')

            # The shared (non-namespaced) tmux socket means real operator
            # panes may also show up as extra "claude"-kind rows here (see
            # module doc comment) — filter to OUR session by its tmux target
            # (SessionRail's label falls back to `s.id`, the tmux target
            # string, when no title/name is set — see PaneRow's `label`).
            row = page.locator('.session-item[data-kind="claude"]').filter(has_text=tmux_session).first
            row.wait_for(state='visible', timeout=10_000)
            row.click()

            gallery = page.locator('[role="region"][aria-label="Session artifacts"]')
            gallery.wait_for(state='visible', timeout=10_000)

            assert gallery.get_by_text('artifact-design-notes').count() > 0, 'gallery missing markdown artifact name'
            assert gallery.get_by_text('pipeline-dashboard').count() > 0, 'gallery missing react artifact name'
            assert page.get_by_label('Markdown artifact').count() > 0, 'gallery missing Markdown kind badge'
            assert page.get_by_label('React artifact').count() > 0, 'gallery missing React kind badge'
            log('gallery lists both artifacts with correct kind badges')

            shot1 = SCREENSHOT_DIR / 'gallery.png'
            page.screenshot(path=str(shot1))
            screenshots.append(shot1)

            # Open the markdown artifact inline; assert the sandboxed iframe
            # (srcDoc-based, no `src`) renders with title == the exact
            # resolved, versioned url the gallery fetched.
            gallery.get_by_text('artifact-design-notes').click()
            md_iframe = page.locator(f'iframe.embed-app[title="{resolved_urls["artifact-design-notes"]}"]')
            md_iframe.wait_for(state='visible', timeout=10_000)
            log('markdown artifact opened inline (iframe title matches resolved url)')
            shot2 = SCREENSHOT_DIR / 'markdown-open.png'
            page.screenshot(path=str(shot2))
            screenshots.append(shot2)

            # Open the react artifact inline the same way.
            gallery.get_by_text('pipeline-dashboard').click()
            react_iframe = page.locator(f'iframe.embed-app[title="{resolved_urls["pipeline-dashboard"]}"]')
            react_iframe.wait_for(state='visible', timeout=10_000)
            log('react artifact opened inline (iframe title matches resolved url)')
            shot3 = SCREENSHOT_DIR / 'react-open.png'
            page.screenshot(path=str(shot3))
            screenshots.append(shot3)

            browser.close()

        for shot in screenshots:
            assert shot.exists() and shot.stat().st_size > 0, f'screenshot not written: {shot}'
        log('screenshots confirmed on disk: ' + ', '.join(str(s) for s in screenshots))

        assert http_ok(f'http://127.0.0.1:{LIVE_PORT}/'), 'live :4317 must still be 200 after the test'
        log(f'live :{LIVE_PORT} still 200 after the test')

        log('PASS')
        return 0

    finally:
        log('tearing down')
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

#!/usr/bin/env python3
"""Olam Cloud/Local tab fixes — hermetic Playwright verification.

Same "hermetic Python-Playwright harness against a throwaway server.js
instance" idiom as web/scratch/studio-toolbar-e2e.py (own port, own media
root, real :4317 never touched) — but this one also fakes the two external
binaries `RemoteSessionSource`/`OlamOrgClient`/`OlamHealthProbe` shell out to
(`cloudflared`, `gcloud`) via a PATH-prepended scratch bin dir, and runs two
local self-signed-HTTPS mock servers standing in for two orgs' real SPA +
runner endpoints. Nothing here touches real Olam credentials or networks —
every "secret" is a throwaway string with zero real-world validity.

Seeds a scratch olam.json with 3 orgs:
  grain — RED. The fake `cloudflared` binary fails (exit 1) for any --app
    URL that isn't our own 127.0.0.1 mock, so grain's health probe hits a
    real NoAccessSession failure every tick — no live grain credentials
    involved anywhere.
  atlas — GREEN, 3 mock session rows (1 archived, 1 very-old/"earlier", 1
    current) — proves the tab badge counts the TRUE total, not just the
    rail's "current" display subset (Fix 2a).
  pleri — GREEN, genuinely empty — proves a healthy-but-empty org still
    shows the generic "No X cloud sessions" message, not a false reason
    banner (Fix 1's negative case).

Verifies:
  (a) grain's rail empty state shows the health reason + login command
      (Fix 1)
  (b) pleri's rail empty state shows the generic message, no reason banner
      (Fix 1 negative case)
  (c) atlas's tab badge reads "3", the true total including the archived +
      earlier rows (Fix 2a)
  (d) Settings -> "Olam cloud" section lists all 3 orgs with correct
      health dots + reasons + login commands (Fix 3)
  (e) the rail tab pills render with the compact/pill styling (screenshot
      only, visual)

Run: python3 web/scratch/olam-tab-fixes-e2e.py   (from the repo root)
"""

import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO_ROOT = Path(__file__).resolve().parents[2]
SPARE_PORT = 4419
LIVE_PORT = 4317
SCREENSHOT_DIR = Path.home() / '.claude-control' / 'media' / 'olam-tab-fixes'
TOKEN = f'e2e-{uuid.uuid4().hex}'


def log(msg: str) -> None:
    print(f'[e2e] {msg}', flush=True)


def http_ok(url: str, timeout: float = 2.0, token: str | None = None) -> bool:
    req = urllib.request.Request(url)
    if token:
        req.add_header('Authorization', f'Bearer {token}')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def wait_for(predicate, timeout_s: float, interval_s: float = 0.3, what: str = 'condition'):
    deadline = time.time() + timeout_s
    last_err = None
    while time.time() < deadline:
        try:
            if predicate():
                return True
        except Exception as e:  # noqa: BLE001 - surfaced in the timeout message
            last_err = e
        time.sleep(interval_s)
    raise TimeoutError(f'timed out waiting for: {what} (last error: {last_err})')


# ---------------------------------------------------------------------------
# Mock SPA+runner HTTPS server — stands in for one Olam org's real spaBase.
# Implements exactly the 3 endpoints OlamOrgClient / OlamHealthProbe call:
#   POST /api/bootstrap              -> {"token": "..."}
#   GET  /api/plan-chat/v1/sessions* -> {"sessions": [...]}
#   GET  /agent-run/status*          -> {} (health probe + runner status)
# ---------------------------------------------------------------------------
def make_mock_handler(sessions_payload: list):
    class Handler(BaseHTTPRequestHandler):
        def _json(self, obj, status=200):
            body = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802 - stdlib method name
            # OlamOrgClient._bootstrapBearer does a plain GET (not POST) —
            # see lib/olam-client.js: `this.fetch(\`${spaBase}/api/bootstrap\`, ...)`
            # with no method override.
            if self.path.startswith('/api/bootstrap'):
                self._json({'token': 'fake-bearer-e2e'})
            elif self.path.startswith('/api/plan-chat/v1/sessions'):
                self._json({'sessions': sessions_payload})
            elif self.path.startswith('/agent-run/status'):
                self._json({})
            else:
                self._json({'error': 'not found'}, 404)

        def log_message(self, fmt, *args):  # noqa: A003 - silence stdlib access log
            pass

    return Handler


def start_mock_https(sessions_payload: list, cert_path: Path, key_path: Path) -> tuple[HTTPServer, int]:
    httpd = HTTPServer(('127.0.0.1', 0), make_mock_handler(sessions_payload))
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(cert_path), str(key_path))
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, port


def make_self_signed_cert(tmp_root: Path) -> tuple[Path, Path]:
    cert = tmp_root / 'mock-cert.pem'
    key = tmp_root / 'mock-key.pem'
    subprocess.run(
        [
            'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', str(key), '-out', str(cert),
            '-days', '1', '-subj', '/CN=127.0.0.1',
        ],
        check=True, capture_output=True,
    )
    return cert, key


FAKE_CLOUDFLARED = """#!/bin/bash
app=""
for arg in "$@"; do
  case "$arg" in
    --app=*) app="${arg#--app=}" ;;
  esac
done
case "$app" in
  *127.0.0.1*) echo "fake-jwt-e2e-token"; exit 0 ;;
  *) exit 1 ;;
esac
"""

# Always fails fast — forces runnerToken() past the GSM candidate straight to
# the runnerTokenFiles file candidate for the two green orgs, and leaves
# grain with zero working runner-bearer candidates (irrelevant to grain's
# red verdict, which comes from the spa-check / cloudflared failure).
FAKE_GCLOUD = """#!/bin/bash
exit 1
"""


def main() -> int:
    assert http_ok(f'http://127.0.0.1:{LIVE_PORT}/'), 'live :4317 must be up (200) before the test starts'
    log(f'baseline: live :{LIVE_PORT} is 200')

    tmp_root = Path(tempfile.mkdtemp(prefix='olam-tab-fixes-e2e-')).resolve()
    fake_home = tmp_root / 'fake-home'
    cc_dir = fake_home / '.claude-control'
    fakebin = tmp_root / 'fakebin'
    projects_dir = tmp_root / 'projects'
    media_dir = tmp_root / 'media'
    for d in (cc_dir, fakebin, projects_dir, media_dir / 'apps', tmp_root / 'uploads', tmp_root / 'present'):
        d.mkdir(parents=True, exist_ok=True)

    server_proc = None
    mock_servers: list[HTTPServer] = []

    try:
        # ---- fake cloudflared / gcloud on PATH ----
        cloudflared = fakebin / 'cloudflared'
        cloudflared.write_text(FAKE_CLOUDFLARED)
        cloudflared.chmod(0o755)
        gcloud = fakebin / 'gcloud'
        gcloud.write_text(FAKE_GCLOUD)
        gcloud.chmod(0o755)
        log('fake cloudflared/gcloud written to scratch bin dir')

        # ---- mock HTTPS servers for the two green orgs ----
        cert, key = make_self_signed_cert(tmp_root)
        now_iso = datetime.now(timezone.utc).isoformat()
        atlas_rows = [
            {'session_id': 'atlas-current', 'title': 'Current work', 'last_turn_at': now_iso},
            {'session_id': 'atlas-old', 'title': 'Ancient session', 'last_turn_at': '2020-01-01T00:00:00Z'},
            {'session_id': 'atlas-archived', 'title': 'Archived session', 'last_turn_at': now_iso, 'status': 'closed'},
        ]
        atlas_httpd, atlas_port = start_mock_https(atlas_rows, cert, key)
        pleri_httpd, pleri_port = start_mock_https([], cert, key)
        mock_servers = [atlas_httpd, pleri_httpd]
        log(f'mock HTTPS servers up: atlas=:{atlas_port} (3 rows), pleri=:{pleri_port} (empty)')

        atlas_token_file = tmp_root / 'atlas-runner-token'
        atlas_token_file.write_text('fake-runner-bearer-atlas')
        pleri_token_file = tmp_root / 'pleri-runner-token'
        pleri_token_file.write_text('fake-runner-bearer-pleri')

        olam_config = {
            'enabled': True,
            'orgs': [
                {
                    'org': 'grain',
                    'runnerUrl': 'https://grain.olam.example',
                    'spaBase': 'https://grain.olam.example',
                },
                {
                    'org': 'atlas',
                    'runnerUrl': f'https://127.0.0.1:{atlas_port}',
                    'spaBase': f'https://127.0.0.1:{atlas_port}',
                    'runnerTokenFiles': [str(atlas_token_file)],
                },
                {
                    'org': 'pleri',
                    'runnerUrl': f'https://127.0.0.1:{pleri_port}',
                    'spaBase': f'https://127.0.0.1:{pleri_port}',
                    'runnerTokenFiles': [str(pleri_token_file)],
                },
            ],
        }
        (cc_dir / 'olam.json').write_text(json.dumps(olam_config, indent=2))
        log('scratch olam.json seeded: grain=red, atlas=green(3 rows), pleri=green(empty)')

        env = dict(os.environ)
        env.update(
            {
                'HOME': str(fake_home),
                'PATH': f'{fakebin}:{os.environ.get("PATH", "")}',
                'CLAUDE_CONTROL_PORT': str(SPARE_PORT),
                'CLAUDE_CONTROL_HOST': '127.0.0.1',
                'CLAUDE_CONTROL_PROJECTS': str(projects_dir),
                'CLAUDE_CONTROL_SINGLE_ROOT': '1',
                'CLAUDE_CONTROL_MEDIA': str(media_dir),
                'CLAUDE_CONTROL_UPLOADS': str(tmp_root / 'uploads'),
                'CLAUDE_CONTROL_PRESENT': str(tmp_root / 'present'),
                'CLAUDE_CONTROL_PINS': str(tmp_root / 'pins.json'),
                'CLAUDE_CONTROL_NO_REAP': '1',
                'CLAUDE_CONTROL_TOKEN': TOKEN,
                # Accept the mock servers' self-signed certs. Scoped to this
                # spawned child only — never touches the operator's real env.
                'NODE_TLS_REJECT_UNAUTHORIZED': '0',
            }
        )
        log(f'spawning hermetic server.js on :{SPARE_PORT}')
        server_proc = subprocess.Popen(
            ['node', 'server.js'],
            cwd=str(REPO_ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        wait_for(lambda: http_ok(f'http://127.0.0.1:{SPARE_PORT}/api/health', token=TOKEN), 15,
                 what='hermetic server /api/health 200')
        log('hermetic server is up')

        SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={'width': 1400, 'height': 900})
            page.goto(f'http://127.0.0.1:{SPARE_PORT}/?token={TOKEN}')
            page.locator('.rail-tabs').wait_for(state='visible', timeout=15_000)
            log('app loaded, authenticated via legacy ?token= migration, rail tabs visible')

            # ---- (e) compact pill styling — screenshot before interacting ----
            shot_pills = SCREENSHOT_DIR / 'compact-pills.png'
            page.locator('.rail-tabs-wrap').screenshot(path=str(shot_pills))
            log(f'captured pill styling screenshot: {shot_pills}')

            def org_tab(label: str):
                return page.locator(f'.rail-tab[data-kind="org"]', has_text=label)

            def org_count_text(label: str) -> str:
                return org_tab(label).locator('.rail-tab-count').text_content().strip()

            # ---- (c) atlas tab count == true total (3), including archived
            # + earlier rows, not just the "current" display subset ----
            wait_for(lambda: org_count_text('Atlas') == '3', 25, what='atlas tab count reaches 3 (true total)')
            log('Fix 2a verified: Atlas tab badge = 3 (archived + earlier + current, true total)')

            shot_counts = SCREENSHOT_DIR / 'corrected-counts.png'
            page.locator('.rail-tabs-wrap').screenshot(path=str(shot_counts))
            log(f'captured corrected-counts screenshot: {shot_counts}')

            # ---- (a) grain (red) empty state shows reason + login command ----
            org_tab('Grain').click()
            note = page.get_by_role('note')
            wait_for(lambda: 'cloudflared access login' in (note.text_content() or ''), 25,
                     what='grain rail shows the health reason + login command')
            reason_text = note.text_content()
            assert 'https://grain.olam.example' in reason_text, f'reason missing spaBase: {reason_text}'
            assert page.get_by_text('No Grain cloud sessions').count() == 0, \
                'red org must not show the generic empty message'
            log(f'Fix 1 verified (red): grain shows reason banner: {reason_text!r}')

            shot_grain = SCREENSHOT_DIR / 'grain-expired-empty-state.png'
            page.locator('.session-rail, .rail-panel, main').first.screenshot(path=str(shot_grain))
            log(f'captured grain-expired-empty-state screenshot: {shot_grain}')

            # ---- (b) pleri (green, genuinely empty) shows the generic
            # message, never a false reason banner ----
            org_tab('Pleri').click()
            wait_for(lambda: page.get_by_text('No Pleri cloud sessions').count() > 0, 25,
                     what='pleri rail shows the generic empty message')
            assert page.get_by_role('note').count() == 0, 'healthy-empty org must not show a reason banner'
            log('Fix 1 verified (negative case): pleri (healthy, empty) shows the generic message, no reason banner')

            # ---- (d) Settings -> Olam cloud setup guide ----
            page.get_by_role('button', name='Settings').click()
            page.get_by_role('button', name='Olam cloud').click()
            page.wait_for_selector('.config-olam-orgs', timeout=10_000)

            for org in ('grain', 'atlas', 'pleri'):
                assert page.get_by_text(org, exact=True).count() > 0, f'settings guide missing org {org}'
            settings_note = page.get_by_role('note')
            wait_for(lambda: settings_note.count() > 0 and 'cloudflared access login' in (settings_note.first.text_content() or ''),
                     10, what='settings guide shows grain login command')
            log('Fix 3 verified: Settings -> Olam cloud lists all 3 orgs with live health + login command')

            shot_settings = SCREENSHOT_DIR / 'settings-olam-cloud.png'
            page.locator('.config-modal, [role="dialog"]').first.screenshot(path=str(shot_settings))
            log(f'captured settings-olam-cloud screenshot: {shot_settings}')

            browser.close()

        for shot in (shot_pills, shot_grain, shot_counts, shot_settings):
            assert shot.exists() and shot.stat().st_size > 0, f'screenshot not written: {shot}'
        log('all 4 screenshots confirmed on disk')

        assert http_ok(f'http://127.0.0.1:{LIVE_PORT}/'), 'live :4317 must still be 200 after the test'
        log(f'live :{LIVE_PORT} still 200 after the test — untouched')

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
        for httpd in mock_servers:
            try:
                httpd.shutdown()
            except Exception:  # noqa: BLE001 - best-effort teardown
                pass
        shutil.rmtree(tmp_root, ignore_errors=True)
        log('teardown complete (spawned server + mock HTTPS servers killed, tmp dirs removed)')


if __name__ == '__main__':
    sys.exit(main())

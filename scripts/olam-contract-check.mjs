#!/usr/bin/env node
// olam-contract-check — live-verifies the per-org olam surface contract that
// the remote-sessions feature (docs/plans/cockpit-olam-remote-sessions/) builds on.
//
//   node scripts/olam-contract-check.mjs --org atlas [--org grain ...]
//
// Checks per org:
//   1. runner-status          GET  <runner>/agent-run/status         (bearer)
//   2. runner-terminal-token  POST <runner>/agent-run/terminal-token (bearer)
//   3. spa-sessions           GET  <spa>/api/plan-chat/v1/sessions   (CF Access JWT via cloudflared)
//   4. spa-shape-auth         GET  <spa>/api/plan-chat/v1/shape      (CF Access JWT — auth posture only)
//
// Exit 0 when every non-skipped check passes; 1 on any hard failure.
// SPA checks detect-and-skip with `[e2e:skipped] reason: ...` when no
// cloudflared Access session exists (operator SSO is out-of-band).
//
// Secrets: resolved GSM-first (gcloud), org rotation-file fallback. The live
// probe is the arbiter when copies drift (both stale copies observed 2026-07-02).
// Values never leave process memory; logs show sha256 digests only.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
const GSM_ACCOUNT = "ernest.codes@gmail.com";
const GSM_PROJECT = "pleri-500205";

// ponytail: inline org registry; A2's ~/.claude-control/olam.json loader supersedes
// this for cockpit runtime — the script keeps its own copy so it runs standalone.
const ORGS = {
  atlas: {
    runnerUrl: "https://olam-worker-runner-sandbox.atlas-kitchen.workers.dev",
    spaBase: "https://olam.dev-atlas.kitchen",
    runnerTokenCandidates: [
      { kind: "gsm", secret: "olam-atlas-sandbox-runner-token" },
      { kind: "file", path: join(homedir(), ".olam/secrets/sandbox-runner-token") },
      { kind: "file", path: join(homedir(), ".olam/secrets/atlas-olam-task-token") },
    ],
  },
  grain: {
    // Verified 2026-07-02: worker name from wrangler.grain.jsonc `name`
    // (account 1069793468ee…); live-probed 401 on /agent-run/status (auth-gated,
    // correct host). Previously-guessed olam-worker-runner-sandbox.grain.workers.dev
    // returns 404.
    runnerUrl: "https://grain-worker-runner-sandbox.grain.workers.dev",
    // Verified 2026-07-02: packages/plan-chat-spa/wrangler.grain.toml `pattern`;
    // curl 302 -> grain.cloudflareaccess.com login, kid matches toml CF_ACCESS_AUD.
    spaBase: "https://olam.grain.com.sg",
    runnerTokenCandidates: [
      { kind: "gsm", secret: "olam-grain-sandbox-runner-token" },
      { kind: "file", path: join(homedir(), ".olam/secrets/grain-olam-task-token") },
    ],
  },
  pleri: {
    // Verified live 2026-07-02: workers.dev account subdomain is "ernestcodes"
    // (CF API accounts/9f52732a13cb…/workers/subdomain); bearer-authed status
    // probe to the URL below returned HTTP 200.
    runnerUrl: "https://pleri-worker-runner-sandbox.ernestcodes.workers.dev",
    // Verified 2026-07-02: packages/plan-chat-spa/wrangler.pleri.toml `pattern`;
    // curl 302 -> idl3.cloudflareaccess.com login, kid matches toml CF_ACCESS_AUD.
    // olam.kaluga.co is also live but redirects to the ATLAS Access team
    // (atlaskitchen.cloudflareaccess.com) — it is not pleri's SPA, do not use.
    spaBase: "https://olam.pleri.com",
    runnerTokenCandidates: [
      { kind: "gsm", secret: "olam-pleri-sandbox-runner-token" },
      { kind: "file", path: join(homedir(), ".olam/secrets/pleri-olam-task-token") },
    ],
  },
};

const digest = (v) => createHash("sha256").update(v).digest("hex").slice(0, 8);

async function candidateValue(c) {
  if (c.kind === "gsm") {
    const { stdout } = await exec("gcloud", [
      "secrets", "versions", "access", "latest",
      `--secret=${c.secret}`, `--project=${GSM_PROJECT}`, `--account=${GSM_ACCOUNT}`,
    ]);
    return stdout.trim();
  }
  return (await readFile(c.path, "utf8")).trim();
}

/** Try candidates in order; the live status probe arbitrates which copy is current. */
async function resolveRunnerToken(org, cfg) {
  for (const c of cfg.runnerTokenCandidates) {
    let value;
    try {
      value = await candidateValue(c);
    } catch {
      continue; // unreadable candidate (no gcloud / missing file) — try next
    }
    if (!value) continue;
    const res = await fetch(
      `${cfg.runnerUrl}/agent-run/status?sessionId=contract-check&pool=agentrun`,
      { headers: { Authorization: `Bearer ${value}` } },
    ).catch(() => null);
    const src = c.kind === "gsm" ? `gsm:${c.secret}` : `file:${c.path}`;
    if (res?.ok) return { value, src, digest: digest(value) };
    console.error(`  [token] ${org} candidate ${src} (sha256:${digest(value)}) -> ${res ? res.status : "network-error"}; trying next`);
  }
  return null;
}

async function accessJwt(spaBase) {
  try {
    const { stdout } = await exec("cloudflared", ["access", "token", `--app=${spaBase}`]);
    const token = stdout.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

async function checkOrg(org) {
  const cfg = ORGS[org];
  if (!cfg) {
    console.error(`[${org}] unknown org (expected one of: ${Object.keys(ORGS).join(", ")})`);
    return { org, failed: 1, results: [] };
  }
  const results = [];
  const record = (name, status, detail) => {
    results.push({ name, status, detail });
    const tag = status === "PASS" ? "PASS" : status === "SKIP" ? "SKIP" : "FAIL";
    console.log(`[${org}] ${name}: ${tag}${detail ? ` — ${detail}` : ""}`);
  };

  // 1+2 — runner surface (bearer)
  const token = await resolveRunnerToken(org, cfg);
  if (!token) {
    record("runner-status", "FAIL", "no working bearer among candidates (GSM + files)");
    record("runner-terminal-token", "FAIL", "skipped: no bearer");
  } else {
    const status = await fetch(
      `${cfg.runnerUrl}/agent-run/status?sessionId=contract-check&pool=agentrun`,
      { headers: { Authorization: `Bearer ${token.value}` } },
    );
    const body = await status.json().catch(() => ({}));
    record(
      "runner-status",
      status.ok ? "PASS" : "FAIL",
      `HTTP ${status.status}; bearer=${token.src} (sha256:${token.digest}); keys=[${Object.keys(body).join(",")}]`,
    );

    const tt = await fetch(
      `${cfg.runnerUrl}/agent-run/terminal-token?sessionId=contract-check&pool=agentrun&ttl=300`,
      { method: "POST", headers: { Authorization: `Bearer ${token.value}` } },
    );
    const ttBody = await tt.json().catch(() => ({}));
    // uiUrl/wsUrl embed the short-TTL HMAC token — log key names only.
    record("runner-terminal-token", tt.ok ? "PASS" : "FAIL", `HTTP ${tt.status}; keys=[${Object.keys(ttBody).join(",")}]`);
  }

  // 3+4 — SPA surface. Two-layer auth (live-verified 2026-07-02):
  //   layer 1: CF Access JWT (operator identity, `cloudflared access token`)
  //   layer 2: app bearer from GET /api/bootstrap {token} — by design, Access-
  //            authenticated clients are handed PLAN_CHAT_BEARER for API calls.
  const jwt = await accessJwt(cfg.spaBase);
  if (!jwt) {
    console.error(`[e2e:skipped] reason: no Access session for ${cfg.spaBase} — run: cloudflared access login ${cfg.spaBase}`);
    record("spa-sessions", "SKIP", "no cloudflared Access session");
    record("spa-shape-auth", "SKIP", "no cloudflared Access session");
  } else {
    const boot = await fetch(`${cfg.spaBase}/api/bootstrap`, { headers: { "cf-access-token": jwt } });
    const bootBody = boot.ok ? await boot.json().catch(() => ({})) : {};
    const appBearer = typeof bootBody.token === "string" ? bootBody.token : "";
    if (!appBearer) {
      record("spa-sessions", "FAIL", `bootstrap HTTP ${boot.status}: no app bearer handed off`);
      record("spa-shape-auth", "FAIL", "no app bearer");
    } else {
      const hdrs = { "cf-access-token": jwt, Authorization: `Bearer ${appBearer}` };
      const sessions = await fetch(`${cfg.spaBase}/api/plan-chat/v1/sessions?type=chat&scope=all`, { headers: hdrs });
      let detail = `HTTP ${sessions.status}`;
      if (sessions.ok) {
        const body = await sessions.json().catch(() => null);
        const rows = Array.isArray(body) ? body : (body?.sessions ?? []);
        const fields = rows[0] ? Object.keys(rows[0]).join(",") : "(no rows)";
        detail += `; rows=${Array.isArray(rows) ? rows.length : "?"}; fields=[${fields}]`;
      }
      record("spa-sessions", sessions.ok ? "PASS" : "FAIL", detail);

      // Param-level 400 proves both auth layers cleared; 401/403 = rejected.
      const shape = await fetch(`${cfg.spaBase}/api/plan-chat/v1/shape`, { headers: hdrs });
      const cleared = shape.status !== 401 && shape.status !== 403;
      record("spa-shape-auth", cleared ? "PASS" : "FAIL", `HTTP ${shape.status} (${cleared ? "auth cleared" : "machine client rejected"})`);
    }
  }

  const failed = results.filter((r) => r.status === "FAIL").length;
  return { org, failed, results };
}

const orgs = process.argv.flatMap((a, i, all) => (a === "--org" && all[i + 1] ? [all[i + 1]] : []));
if (orgs.length === 0) {
  console.error("usage: node scripts/olam-contract-check.mjs --org atlas [--org grain] [--org pleri]");
  process.exit(1);
}
let failures = 0;
for (const org of orgs) failures += (await checkOrg(org)).failed;
process.exit(failures > 0 ? 1 : 0);

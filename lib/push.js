// lib/push.js — Web Push (VAPID) fan-out for claude-control.
//
// Persists a VAPID keypair and the set of browser PushSubscriptions under
// ~/.claude-control so notifications survive restarts. sendToAll() delivers a
// JSON payload to every subscription and prunes stale (404/410) endpoints.
// Best-effort throughout: a single failing send never throws out of here.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import webpush from 'web-push';

const STORE_DIR = path.join(os.homedir(), '.claude-control');
const VAPID_PATH = path.join(STORE_DIR, 'vapid.json');
const SUBS_PATH = path.join(STORE_DIR, 'push-subscriptions.json');
// 'mailto:' contact is required by the spec; localhost is fine for a personal tool.
const VAPID_CONTACT = 'mailto:claude-control@localhost';

/** @type {{publicKey:string, privateKey:string}} */
let keys;
/** @type {Array<object>} */
let subscriptions = [];

function ensureStoreDir() {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}

/** Load existing VAPID keys or generate + persist a new pair (mode 0600). */
function loadOrCreateKeys() {
  ensureStoreDir();
  try {
    const raw = fs.readFileSync(VAPID_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.publicKey && parsed?.privateKey) return parsed;
  } catch {
    // missing/corrupt → regenerate below
  }
  const generated = webpush.generateVAPIDKeys();
  try {
    fs.writeFileSync(VAPID_PATH, JSON.stringify(generated, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('push: failed to persist VAPID keys:', err?.message || err);
  }
  return generated;
}

/** Load persisted subscriptions; tolerate a missing/corrupt file. */
function loadSubscriptions() {
  try {
    const raw = fs.readFileSync(SUBS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => s?.endpoint) : [];
  } catch {
    return [];
  }
}

function persistSubscriptions() {
  try {
    ensureStoreDir();
    fs.writeFileSync(SUBS_PATH, JSON.stringify(subscriptions, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('push: failed to persist subscriptions:', err?.message || err);
  }
}

// Initialize on import.
keys = loadOrCreateKeys();
subscriptions = loadSubscriptions();
webpush.setVapidDetails(VAPID_CONTACT, keys.publicKey, keys.privateKey);

/** @returns {string} the VAPID public key (handed to the browser to subscribe). */
export function getPublicKey() {
  return keys.publicKey;
}

/**
 * Add (or refresh) a PushSubscription, deduped by endpoint. Returns true if the
 * store changed.
 *
 * @param {object} sub  a browser PushSubscription JSON object
 * @returns {boolean}
 */
export function addSubscription(sub) {
  if (!sub || typeof sub.endpoint !== 'string') return false;
  const existing = subscriptions.findIndex((s) => s.endpoint === sub.endpoint);
  if (existing >= 0) {
    subscriptions = subscriptions.map((s, i) => (i === existing ? sub : s));
  } else {
    subscriptions = [...subscriptions, sub];
  }
  persistSubscriptions();
  return true;
}

/**
 * Remove a subscription by endpoint. Returns true if one was removed.
 *
 * @param {string} endpoint
 * @returns {boolean}
 */
export function removeSubscription(endpoint) {
  if (!endpoint) return false;
  const before = subscriptions.length;
  subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint);
  if (subscriptions.length !== before) {
    persistSubscriptions();
    return true;
  }
  return false;
}

/** @returns {number} current subscription count (for diagnostics/tests). */
export function subscriptionCount() {
  return subscriptions.length;
}

/**
 * Send a notification payload to every subscription. Stale endpoints (404/410)
 * are pruned. Individual send errors are swallowed/logged so one bad sub never
 * blocks the rest.
 *
 * @param {{title:string, body:string, data?:object}} payload
 * @returns {Promise<{sent:number, removed:number}>}
 */
export async function sendToAll({ title, body, data }) {
  if (subscriptions.length === 0) return { sent: 0, removed: 0 };
  const json = JSON.stringify({ title, body, data: data ?? {} });
  const stale = [];
  let sent = 0;

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, json);
        sent += 1;
      } catch (err) {
        const code = err?.statusCode;
        if (code === 404 || code === 410) {
          // Subscription expired or endpoint gone — prune silently.
          stale.push(sub.endpoint);
        } else if (code === 401 || code === 403) {
          // VAPID key mismatch: the subscription was created with a different key.
          // Prune it; the browser must re-subscribe with the current VAPID key.
          const snippet = String(err?.body || '').slice(0, 120);
          console.error(
            `push: VAPID key mismatch (HTTP ${code}) — pruning subscription ${sub.endpoint.slice(-40)}: ${snippet}`,
          );
          stale.push(sub.endpoint);
        } else {
          // Log the real HTTP status code so future failures are diagnosable.
          const snippet = String(err?.body || '').slice(0, 120);
          console.error(
            `push: send failed (HTTP ${code ?? 'unknown'}): ${err?.message || err}${snippet ? ` — ${snippet}` : ''}`,
          );
        }
      }
    }),
  );

  let removed = 0;
  for (const endpoint of stale) {
    if (removeSubscription(endpoint)) removed += 1;
  }
  return { sent, removed };
}

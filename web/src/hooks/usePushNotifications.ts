import { useCallback, useEffect, useState } from 'react';
import {
  getVapidPublicKey,
  postPushSubscribe,
  postPushUnsubscribe,
} from '../lib/api';

export type PushStatus =
  | 'unsupported' // no PushManager / insecure context
  | 'off'
  | 'on'
  | 'denied' // Notification permission was denied
  | 'working';

const INTENT_KEY = 'cc:push:intent'; // '1' = user wants push on

// Push requires a secure context (https or localhost) AND the PushManager API.
function isSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (!('serviceWorker' in navigator)) return false;
  if (!('PushManager' in window)) return false;
  if (!('Notification' in window)) return false;
  // window.isSecureContext is true for https and http://localhost.
  return window.isSecureContext === true;
}

// Detect iOS Safari, where push only works once the site is Added to Home Screen.
function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const iOSDevice = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ reports as Mac; detect via touch points.
  const iPadOS =
    navigator.platform === 'MacIntel' &&
    typeof navigator.maxTouchPoints === 'number' &&
    navigator.maxTouchPoints > 1;
  return iOSDevice || iPadOS;
}

// VAPID public keys are base64url; subscribe() wants the raw bytes as a
// BufferSource. Return the backing ArrayBuffer (a valid BufferSource) so the
// type is the plain, non-shared variant applicationServerKey expects.
function urlBase64ToBuffer(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; i += 1) view[i] = rawData.charCodeAt(i);
  return buffer;
}

export interface PushController {
  status: PushStatus;
  supported: boolean;
  iosHint: boolean; // show "Add to Home Screen" hint
  enable: () => Promise<void>;
  disable: () => Promise<void>;
}

/**
 * Owns Web Push enable/disable: registers the SW, requests permission, creates
 * the PushManager subscription, and syncs it with the server. Intent persists in
 * localStorage; on load we reconcile the actual subscription against that intent.
 */
export function usePushNotifications(): PushController {
  const supported = isSupported();
  const iosHint = isIos();
  const [status, setStatus] = useState<PushStatus>(
    supported ? 'off' : 'unsupported',
  );

  const subscribeFlow = useCallback(async (): Promise<boolean> => {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      setStatus('denied');
      return false;
    }

    const key = await getVapidPublicKey();
    if (!key) {
      setStatus('off');
      return false;
    }

    let sub = await reg.pushManager.getSubscription();

    // If an existing subscription was created with a different VAPID key,
    // the server will reject sends with 403. Detect this by comparing the
    // stored applicationServerKey bytes against the current VAPID public key.
    if (sub) {
      try {
        const currentKeyBuf = urlBase64ToBuffer(key);
        const existingKeyBuf = sub.options?.applicationServerKey;
        let keyMismatch = false;
        if (existingKeyBuf instanceof ArrayBuffer) {
          const existing = new Uint8Array(existingKeyBuf);
          const current = new Uint8Array(currentKeyBuf);
          if (existing.length !== current.length) {
            keyMismatch = true;
          } else {
            for (let i = 0; i < existing.length; i++) {
              if (existing[i] !== current[i]) { keyMismatch = true; break; }
            }
          }
        }
        if (keyMismatch) {
          // Old sub uses a different VAPID key — unsubscribe so we re-subscribe
          // below with the current key. The server will prune the old endpoint
          // on its next send attempt (403 → prune), but unsubscribing now avoids
          // one failed push cycle.
          await sub.unsubscribe();
          sub = null;
        }
      } catch {
        // Key comparison failed (browser quirk) — proceed with existing sub;
        // worst case the server prunes it on the next 403 send failure.
      }
    }

    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBuffer(key),
      });
    }
    const ok = await postPushSubscribe(sub.toJSON());
    return ok;
  }, []);

  const enable = useCallback(async () => {
    if (!supported) return;
    setStatus('working');
    try {
      const ok = await subscribeFlow();
      if (ok) {
        localStorage.setItem(INTENT_KEY, '1');
        setStatus('on');
      } else {
        setStatus((s) => (s === 'denied' ? 'denied' : 'off'));
      }
    } catch {
      setStatus('off');
    }
  }, [supported, subscribeFlow]);

  const disable = useCallback(async () => {
    setStatus('working');
    localStorage.removeItem(INTENT_KEY);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await postPushUnsubscribe(sub.endpoint);
        await sub.unsubscribe();
      }
    } catch {
      /* best-effort */
    }
    setStatus('off');
  }, []);

  // On load: if the user previously enabled push and permission is still
  // granted, re-sync the (possibly rotated) subscription with the server.
  useEffect(() => {
    if (!supported) return;
    if (localStorage.getItem(INTENT_KEY) !== '1') return;
    if (Notification.permission !== 'granted') {
      setStatus(Notification.permission === 'denied' ? 'denied' : 'off');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const ok = await subscribeFlow();
        if (!cancelled) setStatus(ok ? 'on' : 'off');
      } catch {
        if (!cancelled) setStatus('off');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supported, subscribeFlow]);

  return { status, supported, iosHint, enable, disable };
}

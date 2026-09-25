/**
 * ACP session/request_permission host. Holds the JSON-RPC request open until
 * the operator answers (or skipPermissions auto-allows).
 */

function rpcError(code, message) {
  const err = new Error(message);
  err.rpc = { code, message };
  return err;
}

function defaultAllow(params) {
  const options = Array.isArray(params?.options) ? params.options : [];
  const always = options.find((o) => o?.optionId === 'allow_always' || o?.kind === 'allow_always');
  const once = options.find((o) => o?.optionId === 'allow_once' || o?.kind === 'allow_once') || options[0];
  const chosen = always || once;
  if (!chosen?.optionId) {
    return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
  }
  return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
}

/**
 * @param {{ skipPermissions?: boolean }} [opts]
 */
export function createPermissionHost({ skipPermissions = false } = {}) {
  /** @type {Map<string, { params: unknown, resolve: (v: unknown) => void, reject: (e: unknown) => void }>} */
  const pending = new Map();
  let seq = 0;
  /** @type {((p: { requestId: string, params: unknown }) => void)|null} */
  let onPending = null;

  return {
    setOnPending(fn) { onPending = fn; },

    requestPermission(params) {
      if (skipPermissions) return Promise.resolve(defaultAllow(params));
      const requestId = `perm-${++seq}`;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { params, resolve, reject });
        onPending?.({ requestId, params });
      });
    },

    /** @param {string} requestId @param {{ optionId?: string, cancelled?: boolean }} answer */
    answer(requestId, answer) {
      const p = pending.get(requestId);
      if (!p) throw rpcError(-32004, `unknown permission request: ${requestId}`);
      pending.delete(requestId);
      if (answer?.cancelled) {
        p.resolve({ outcome: { outcome: 'cancelled' } });
        return;
      }
      const optionId = answer?.optionId || 'allow_once';
      p.resolve({ outcome: { outcome: 'selected', optionId } });
    },

    getPending() {
      const first = pending.entries().next().value;
      if (!first) return null;
      const [requestId, rec] = first;
      return { requestId, params: rec.params };
    },

    cancelAll() {
      for (const rec of pending.values()) {
        rec.resolve({ outcome: { outcome: 'cancelled' } });
      }
      pending.clear();
    },
  };
}

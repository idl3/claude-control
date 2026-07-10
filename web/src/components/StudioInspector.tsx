// cockpit-prototype-studio, E1: the Studio "Inspector" tab — a read-only,
// collapsible view of the live artifact's DOM, driven entirely by the
// cc-dom-outline-request/cc-dom-outline-result bridge messages (see
// lib/ccBridgeRuntime.tsx's E1 doc comment for the producer side, and
// lib/appBridge.ts's isValidCcDomOutlineResult for the validated inbound
// check this component uses). Zero mutation affordances by design (S1: "a
// read-only DOM outline" — see docs/design/cockpit-prototype-studio.md): the
// only interactive elements are the Refresh button (re-requests) and the
// native <details>/<summary> disclosure triangles (view-only expand/collapse,
// never touches the artifact).
import { useEffect, useState } from 'react';
import { findAppIframeWindow } from './StudioModal';
import { isValidCcBridgeReady, isValidCcDomOutlineResult, sendCcDomOutlineRequest, type CcDomOutlineNode } from '../lib/appBridge';

type OutlineResult = { tree: CcDomOutlineNode | null; truncated: boolean };

function StudioInspectorNodeLabel({ node }: { node: CcDomOutlineNode }) {
  const idPart = node.id ? `#${node.id}` : '';
  const classPart = node.className ? `.${node.className.trim().split(/\s+/).join('.')}` : '';
  return (
    <span className="studio-inspector-node-label">
      <span className="studio-inspector-node-tag">
        {node.tag}
        {idPart}
        {classPart}
      </span>
      {node.textPreview && <span className="studio-inspector-node-text">“{node.textPreview}”</span>}
      <span className="studio-inspector-node-count">{node.childCount}</span>
    </span>
  );
}

function StudioInspectorNode({ node }: { node: CcDomOutlineNode }) {
  if (node.children.length === 0) {
    return (
      <div className="studio-inspector-node studio-inspector-leaf">
        <StudioInspectorNodeLabel node={node} />
      </div>
    );
  }
  return (
    <details className="studio-inspector-node">
      <summary>
        <StudioInspectorNodeLabel node={node} />
      </summary>
      <div className="studio-inspector-children">
        {node.children.map((child, i) => (
          <StudioInspectorNode key={i} node={child} />
        ))}
      </div>
    </details>
  );
}

export function StudioInspector({ url, active }: { url: string; active: boolean }) {
  const [result, setResult] = useState<OutlineResult | undefined>(undefined);

  // A new app open drops any previously-fetched outline — it belongs to a
  // different iframe.
  useEffect(() => setResult(undefined), [url]);

  // Same two-race handshake StudioPropsPanel's `bridgeReady` closes (fresh-
  // open vs. already-hosted — see that component's doc comment), but without
  // the send-queue machinery: a dropped/early outline request is not a
  // mutation-loss risk (unlike props-set), so this just re-sends once when
  // whichever of "a validated cc-bridge-ready arrives" or "250ms elapses"
  // (same fallback window StudioPropsPanel uses) happens first, and leaves
  // the visible Refresh button as the general-purpose recovery path.
  //
  // Gated on `active`: the side panel keeps Props AND Inspector mounted at
  // all times (never-unmount discipline — see StudioModal.tsx), so without
  // this gate a hidden Inspector tab would still auto-fire an outline
  // request the instant the bridge announces ready, sharing the same
  // postMessage channel StudioPropsPanel's props-set traffic uses. Only
  // request once the tab is actually visible; switching tabs later re-arms
  // the effect via the `active` dependency.
  useEffect(() => {
    if (!active) return;
    let sent = false;
    const send = () => {
      if (sent) return;
      const win = findAppIframeWindow(url);
      if (!win) return;
      sendCcDomOutlineRequest(win);
      sent = true;
    };
    function onMessage(event: MessageEvent) {
      const win = findAppIframeWindow(url);
      if (win && isValidCcBridgeReady(event.source, win, event.data)) send();
    }
    window.addEventListener('message', onMessage);
    const fallback = setTimeout(send, 250);
    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(fallback);
    };
  }, [url, active]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const win = findAppIframeWindow(url);
      if (!isValidCcDomOutlineResult(event.source, win, event.data)) return;
      const data = event.data as OutlineResult;
      setResult({ tree: data.tree, truncated: data.truncated });
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [url]);

  const refresh = () => {
    const win = findAppIframeWindow(url);
    if (win) sendCcDomOutlineRequest(win);
  };

  return (
    <div className="studio-inspector-panel" aria-label="Inspector">
      <div className="studio-inspector-head">
        <span className="studio-inspector-title">Inspector</span>
        <button type="button" className="studio-inspector-refresh" onClick={refresh}>
          Refresh
        </button>
      </div>
      {result?.truncated && (
        <p className="studio-inspector-truncated-notice" role="status">
          Outline truncated — depth/node limit reached, showing a partial tree.
        </p>
      )}
      {result === undefined && <p className="studio-inspector-empty">Loading outline…</p>}
      {result !== undefined && result.tree === null && (
        <p className="studio-inspector-empty">No outline available.</p>
      )}
      {result?.tree && <StudioInspectorNode node={result.tree} />}
    </div>
  );
}

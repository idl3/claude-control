import { Fragment, useMemo, useRef, useState } from 'react';
import { SlotText } from 'slot-text/react';
import {
  insertToken,
  orderMetaFields,
  poolTokens,
  removeToken,
  type RailToken,
} from '../lib/railTokenPrefs';
import { META_CYCLE_PERIOD_MS, effortClass, formatModel, useMetaCyclePhase } from './SessionRail';
import { ClaudeRobotIcon } from './ClaudeRobotIcon';
import { CodexIcon } from './CodexIcon';

const TOKEN_LABEL: Record<RailToken, string> = {
  model: 'model',
  effort: 'effort',
  ctx: 'ctx',
  usage: 'usage',
};

// Illustrative chip per token — reuses the real rail's meta classes so the
// pool/bar pills look like a preview of the actual chip, not a generic tag.
// 'effort' has 5 possible colors on the real rail; amber is just a
// representative sample for the static pill (the live preview below cycles
// through the real palette).
const TOKEN_SAMPLE_CLASS: Record<RailToken, string> = {
  model: 'meta-model',
  effort: 'meta-effort meta-effort-amber',
  ctx: 'meta-ctx',
  usage: 'meta-usage',
};

const PLACEHOLDER = '__placeholder__' as const;
type BarItem = RailToken | typeof PLACEHOLDER;

interface DragState {
  token: RailToken;
  origin: 'pool' | 'bar';
  pointerId: number;
  x: number;
  y: number;
}

function isPointInRect(r: DOMRect, x: number, y: number): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

// --- Live preview -----------------------------------------------------------
// Fabricated per-cycle data for 2 fake rows (Claude, Codex), rendered with the
// exact meta-slot markup SessionRail uses for real rows (see PaneRow's
// `rightSlot` — session-row-meta + SlotText + the same slotOpts).

const CLAUDE_MODELS = ['opus-4.8', 'sonnet-5', 'fable-5'];
const CODEX_MODELS = ['gpt-5.5', 'gpt-5.6'];
const CLAUDE_EFFORTS = ['max', 'xhigh', 'high', 'medium', 'low'];
const CODEX_EFFORTS = ['xhigh', 'high', 'medium', 'low'];
const USAGE_WINDOWS = ['5h', '1w'];

function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}
function pick<T>(arr: readonly T[]): T {
  return arr[randInt(0, arr.length - 1)];
}

interface PreviewField {
  key: RailToken;
  text: string;
  className: string;
}

/** One fresh random value per applicable token (usage only for Codex),
 *  regenerated every tick so the operator sees varied dummy data. */
function randomPreviewFields(isCodex: boolean): PreviewField[] {
  const model = pick(isCodex ? CODEX_MODELS : CLAUDE_MODELS);
  const effort = pick(isCodex ? CODEX_EFFORTS : CLAUDE_EFFORTS);
  const fields: PreviewField[] = [
    { key: 'model', text: formatModel(model), className: 'meta-model' },
    { key: 'effort', text: effort, className: effortClass(effort, isCodex) },
    { key: 'ctx', text: `ctx:${randInt(0, 100)}%`, className: 'meta-ctx' },
  ];
  if (isCodex) {
    fields.push({ key: 'usage', text: `${pick(USAGE_WINDOWS)}:${randInt(0, 100)}%`, className: 'meta-usage' });
  }
  return fields;
}

const PREVIEW_SLOT_OPTS = { direction: 'up' as const, skipUnchanged: true, duration: 300 };

function PreviewRow({
  label,
  Icon,
  isCodex,
  tick,
  railTokens,
}: {
  label: string;
  Icon: (props: { size?: number }) => React.ReactElement;
  isCodex: boolean;
  tick: number;
  railTokens: RailToken[];
}) {
  // Re-randomized every tick on purpose — deps include `tick` so a fresh set
  // of dummy values is generated each cycle, not just recomputed on token-
  // order changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fields = useMemo(
    () => orderMetaFields(randomPreviewFields(isCodex), railTokens),
    [tick, railTokens, isCodex],
  );
  const active = fields.length > 0 ? fields[tick % fields.length] : null;
  return (
    <div className="railcfg-preview-row">
      <span className="railcfg-preview-icon" aria-hidden="true">
        <Icon size={15} />
      </span>
      <span className="railcfg-preview-label">{label}</span>
      {active ? (
        <span className="session-row-meta" title={active.text}>
          <SlotText text={active.text} className={active.className} options={PREVIEW_SLOT_OPTS} />
        </span>
      ) : (
        <span className="session-row-meta railcfg-preview-empty" aria-hidden="true">
          —
        </span>
      )}
    </div>
  );
}

// --- Pool / bar drag-and-drop ------------------------------------------------
// Pointer Events (not HTML5 drag-and-drop, which has no touch support) —
// claude-control is mobile-first. Pointer capture is taken on a stable root
// element (not the dragged pill itself), so the drag survives the dragged
// pill unmounting mid-gesture when it's spliced out of the bar's flow (see
// `displayBarTokens` below). All array mutation goes through the pure,
// independently-tested helpers in lib/railTokenPrefs.ts — this component only
// computes *where* to apply them from pointer position.

export function RailTokenConfig({
  railTokens,
  setRailTokens,
}: {
  railTokens: RailToken[];
  setRailTokens: (tokens: RailToken[]) => void;
}) {
  const tick = useMetaCyclePhase();
  const pool = poolTokens(railTokens);

  const [drag, setDrag] = useState<DragState | null>(null);
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  const dndRootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const pillRefs = useRef<Map<RailToken, HTMLDivElement>>(new Map());

  function updateInsertIndex(clientX: number, clientY: number, token: RailToken) {
    const barEl = barRef.current;
    if (!barEl || !isPointInRect(barEl.getBoundingClientRect(), clientX, clientY)) {
      setInsertIndex(null);
      return;
    }
    // "others" = the bar with the dragged token removed — matches
    // insertToken's own `without` computation, so the index we compute here
    // lines up exactly with what insertToken will do on drop.
    const others = railTokens.filter((t) => t !== token);
    let idx = others.length;
    for (let i = 0; i < others.length; i++) {
      const el = pillRefs.current.get(others[i]);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientX < r.left + r.width / 2) {
        idx = i;
        break;
      }
    }
    setInsertIndex(idx);
  }

  function startDrag(e: React.PointerEvent, token: RailToken, origin: 'pool' | 'bar') {
    dndRootRef.current?.setPointerCapture(e.pointerId);
    setDrag({ token, origin, pointerId: e.pointerId, x: e.clientX, y: e.clientY });
    updateInsertIndex(e.clientX, e.clientY, token);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    setDrag((d) => (d ? { ...d, x: e.clientX, y: e.clientY } : d));
    updateInsertIndex(e.clientX, e.clientY, drag.token);
  }

  function commitDrag(token: RailToken, origin: 'pool' | 'bar', idx: number | null) {
    if (idx != null) {
      setRailTokens(insertToken(railTokens, token, idx));
    } else if (origin === 'bar') {
      setRailTokens(removeToken(railTokens, token));
    }
    // origin === 'pool' && idx === null: dropped back outside the bar → no-op
  }

  function endDrag(e: React.PointerEvent, commit: boolean) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (commit) commitDrag(drag.token, drag.origin, insertIndex);
    dndRootRef.current?.releasePointerCapture(e.pointerId);
    setDrag(null);
    setInsertIndex(null);
  }

  // While dragging a bar token, exclude it from the rendered bar (its
  // "ghost" stands in for it) — this is the `without` array insertToken
  // itself would compute, so splicing the placeholder into it below shows
  // exactly where the drop will land.
  const displayBarTokens = drag && drag.origin === 'bar' ? railTokens.filter((t) => t !== drag.token) : railTokens;
  const barItems: BarItem[] = [...displayBarTokens];
  if (drag && insertIndex != null) {
    barItems.splice(Math.max(0, Math.min(insertIndex, barItems.length)), 0, PLACEHOLDER);
  }

  return (
    <>
      <h2 className="config-section-heading">Rail tokens</h2>
      <p className="config-hint">
        Drag tokens between the pool and the rail to choose which meta fields rotate through each
        session row, and in what order.
      </p>
      <div
        className="railcfg-dnd-root"
        ref={dndRootRef}
        onPointerMove={handlePointerMove}
        onPointerUp={(e) => endDrag(e, true)}
        onPointerCancel={(e) => endDrag(e, false)}
      >
        <div className="railcfg-pool">
          {pool.length === 0 ? (
            <span className="railcfg-pool-empty">All tokens are on the rail.</span>
          ) : (
            pool.map((t) => (
              <div
                key={t}
                className="railcfg-pill"
                onPointerDown={(e) => startDrag(e, t, 'pool')}
              >
                <span className={TOKEN_SAMPLE_CLASS[t]}>{TOKEN_LABEL[t]}</span>
              </div>
            ))
          )}
        </div>

        <div className="railcfg-bar" ref={barRef}>
          <span className="railcfg-bracket" aria-hidden="true">
            [
          </span>
          {barItems.length === 0 ? (
            <span className="railcfg-bar-empty">Drag a token here</span>
          ) : (
            barItems.map((item, i) => (
              <Fragment key={item === PLACEHOLDER ? `placeholder-${i}` : item}>
                {i > 0 && (
                  <span className="railcfg-sep" aria-hidden="true">
                    --[{META_CYCLE_PERIOD_MS / 1000}s]--&gt;
                  </span>
                )}
                {item === PLACEHOLDER ? (
                  <div className="railcfg-pill railcfg-pill--placeholder" aria-hidden="true" />
                ) : (
                  <div
                    ref={(el) => {
                      if (el) pillRefs.current.set(item, el);
                      else pillRefs.current.delete(item);
                    }}
                    className="railcfg-pill railcfg-pill--bar"
                    onPointerDown={(e) => startDrag(e, item, 'bar')}
                  >
                    <span className={TOKEN_SAMPLE_CLASS[item]}>{TOKEN_LABEL[item]}</span>
                    <button
                      type="button"
                      className="railcfg-pill-remove"
                      aria-label={`Remove ${TOKEN_LABEL[item]} from the rail`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => setRailTokens(removeToken(railTokens, item))}
                    >
                      ×
                    </button>
                  </div>
                )}
              </Fragment>
            ))
          )}
          <span className="railcfg-bracket" aria-hidden="true">
            ]
          </span>
        </div>

        {drag && (
          <div
            className="railcfg-ghost"
            aria-hidden="true"
            style={{ transform: `translate(${drag.x}px, ${drag.y}px) translate(-50%, -50%)` }}
          >
            <span className={TOKEN_SAMPLE_CLASS[drag.token]}>{TOKEN_LABEL[drag.token]}</span>
          </div>
        )}
      </div>

      <div className="railcfg-preview">
        <span className="config-label">Preview</span>
        <PreviewRow label="Claude session" Icon={ClaudeRobotIcon} isCodex={false} tick={tick} railTokens={railTokens} />
        <PreviewRow label="Codex session" Icon={CodexIcon} isCodex tick={tick} railTokens={railTokens} />
      </div>
    </>
  );
}

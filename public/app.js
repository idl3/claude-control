/**
 * claude-cockpit — frontend
 * Vanilla ESM, no framework, no CDN. All text via textContent (XSS-safe).
 */

// ── Constants ─────────────────────────────────────────────────────────────
const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS  = 30_000;

// Dedicated WS subprotocol label the server expects alongside the token (see
// lib/auth.js WS_PROTOCOL / checkWsToken — inlined here since public/app.js is
// a plain script with no imports).
const WS_PROTOCOL = 'claude-control';

// ── Auth token storage ───────────────────────────────────────────────────
// Tokens never ride the URL past first load (URLs leak via history/logs/
// referrer). The token lives in localStorage and is sent as an
// `Authorization: Bearer <token>` header on HTTP requests and as a WebSocket
// subprotocol on the WS connection — matching web/src/lib/auth.ts.
const TOKEN_STORAGE_KEY = 'claude-control.token';

let cachedToken = null;
let tokenLoaded = false;

function readStoredToken() {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    // localStorage can throw in private-mode / sandboxed iframes.
    return null;
  }
}

function getToken() {
  if (!tokenLoaded) {
    cachedToken = readStoredToken();
    tokenLoaded = true;
  }
  return cachedToken;
}

function setToken(token) {
  cachedToken = token;
  tokenLoaded = true;
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    /* ignore storage failures — in-memory cache still works for this session */
  }
}

// Migrate a legacy `?token=<t>` from the URL into localStorage and strip it
// from the visible URL. Runs once on module load. Mirrors
// web/src/lib/auth.ts's migrateLegacyUrlToken.
function migrateLegacyUrlToken() {
  if (typeof window === 'undefined' || !window.location) return;
  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return;
  }
  const legacy = params.get('token');
  if (!legacy) return;
  setToken(legacy);
  params.delete('token');
  const query = params.toString();
  const cleaned =
    window.location.pathname + (query ? `?${query}` : '') + window.location.hash;
  try {
    window.history.replaceState(null, '', cleaned);
  } catch {
    /* replaceState can fail in some sandboxes; the token is already stored */
  }
}

migrateLegacyUrlToken();

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ── Client state ─────────────────────────────────────────────────────────
const state = {
  sessions:   [],          // Session[]
  selectedId: null,        // string|null
  messages:   new Map(),   // id -> NormalizedMessage[]
  pending:    new Map(),   // id -> Pending|null
  modalOpen:  false,
  // per-modal: selections[qIdx] = Set<label>
  modalSelections: [],
  modalPendingRef: null,   // the Pending object currently shown
};

// ── WS connection ─────────────────────────────────────────────────────────
let ws = null;
let reconnectTimeout = null;
let reconnectDelay = WS_RECONNECT_BASE_MS;
let wsConnected = false;

function wsUrl() {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}`;
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  setConnState('connecting');
  const token = getToken();
  // Offer the token as a subprotocol — browsers can't set arbitrary headers on
  // `new WebSocket(...)`, but CAN offer subprotocols (see lib/auth.js checkWsToken).
  ws = new WebSocket(wsUrl(), token ? [WS_PROTOCOL, token] : [WS_PROTOCOL]);

  ws.addEventListener('open', () => {
    wsConnected = true;
    reconnectDelay = WS_RECONNECT_BASE_MS;
    setConnState('connected');
    // Server pushes sessions+resources on open. After a drop+reconnect the server
    // has lost our subscription, so re-subscribe to the selected session to resume
    // the transcript stream.
    if (state.selectedId) {
      sendWs({ type: 'subscribe', id: state.selectedId });
    }
  });

  ws.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => {
    wsConnected = false;
    ws = null;
    setConnState('disconnected');
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // 'close' will also fire; let that handle reconnect
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimeout);
  reconnectTimeout = setTimeout(() => { connect(); }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, WS_RECONNECT_MAX_MS);
}

function sendWs(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ── Server message handler ────────────────────────────────────────────────
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'sessions':
      state.sessions = msg.sessions || [];
      renderSessionList();
      break;

    case 'messages':
      state.messages.set(msg.id, msg.messages || []);
      if (msg.pending !== undefined) {
        state.pending.set(msg.id, msg.pending);
        updateSessionBadge(msg.id, !!msg.pending);
      }
      if (msg.id === state.selectedId) {
        renderTranscript();
        syncModal();
      }
      break;

    case 'append': {
      const existing = state.messages.get(msg.id) || [];
      state.messages.set(msg.id, [...existing, ...(msg.messages || [])]);
      if (msg.id === state.selectedId) appendMessages(msg.messages || []);
      break;
    }

    case 'pending':
      state.pending.set(msg.id, msg.pending);
      // update badge on session item
      updateSessionBadge(msg.id, !!msg.pending);
      if (msg.id === state.selectedId) syncModal();
      break;

    case 'resources':
      updateHud(msg.snapshot, msg.warning);
      break;

    case 'capture':
      handleCapture(msg.id, msg.text);
      break;

    case 'ack':
      if (!msg.ok) {
        console.warn('[cockpit] ack error', msg.op, msg.error);
        toast(`${msg.op} failed: ${msg.error || 'error'}`, 'error');
      } else if (msg.op === 'answer') {
        toast('answer sent →', 'ok');
      }
      break;

    default:
      break;
  }
}

// ── Session rail ──────────────────────────────────────────────────────────
function renderSessionList() {
  const ul = document.getElementById('session-list');
  const selectedId = state.selectedId;

  // Diff: preserve existing items if possible (avoid full re-render)
  const existingIds = new Set([...ul.querySelectorAll('[data-id]')].map(el => el.dataset.id));
  const newIds = new Set(state.sessions.map(s => s.id));

  // Remove stale
  for (const el of [...ul.querySelectorAll('[data-id]')]) {
    if (!newIds.has(el.dataset.id)) el.remove();
  }

  for (const session of state.sessions) {
    let item = ul.querySelector(`[data-id="${CSS.escape(session.id)}"]`);
    if (!item) {
      item = makeSessionItem(session);
      ul.appendChild(item);
    }
    updateSessionItem(item, session, session.id === selectedId);
  }
}

function makeSessionItem(session) {
  const li = document.createElement('li');
  li.role = 'option';
  li.tabIndex = 0;
  li.dataset.id = session.id;
  li.className = 'session-item';

  // Top row
  const top = document.createElement('div');
  top.className = 'session-item-top';

  const dot = document.createElement('span');
  dot.className = 'active-dot';
  dot.setAttribute('aria-hidden', 'true');

  const name = document.createElement('span');
  name.className = 'session-name';

  const badge = document.createElement('span');
  badge.className = 'ask-badge';
  badge.textContent = 'ASK';
  badge.setAttribute('aria-label', 'pending question');

  top.append(dot, name, badge);

  const cwd = document.createElement('div');
  cwd.className = 'session-cwd';

  const cmd = document.createElement('div');
  cmd.className = 'session-cmd';

  li.append(top, cwd, cmd);

  li.addEventListener('click', () => selectSession(session.id));
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSession(session.id); }
  });

  return li;
}

function updateSessionItem(item, session, selected) {
  item.setAttribute('aria-selected', selected ? 'true' : 'false');
  item.dataset.active  = session.active  ? 'true' : 'false';
  item.dataset.pending = session.pending ? 'true' : 'false';

  item.querySelector('.session-name').textContent = session.name || session.id;
  item.querySelector('.session-cwd').textContent  = shortenPath(session.cwd || '');
  item.querySelector('.session-cmd').textContent  = session.cmd || '';
}

function updateSessionBadge(id, pending) {
  const item = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (item) item.dataset.pending = pending ? 'true' : 'false';
  // also update state.sessions
  const s = state.sessions.find(s => s.id === id);
  if (s) s.pending = pending;
}

function shortenPath(p) {
  if (!p) return '';
  // Collapse a home-style prefix (/Users/<u>/… on macOS, /home/<u>/… on Linux)
  // to ~/ without hardcoding the OS.
  const m = p.match(/^\/(Users|home)\/[^/]+\/(.*)$/);
  if (m) return '~/' + m[2];
  const homeRoot = p.match(/^\/(Users|home)\/[^/]+\/?$/);
  if (homeRoot) return '~';
  if (p.length <= 35) return p;
  return '…' + p.slice(-32);
}

// ── Session selection ─────────────────────────────────────────────────────
function selectSession(id) {
  if (state.selectedId === id) return;

  // Unsubscribe old
  if (state.selectedId) {
    sendWs({ type: 'unsubscribe', id: state.selectedId });
  }

  state.selectedId = id;

  // Update rail highlight
  for (const el of document.querySelectorAll('.session-item')) {
    el.setAttribute('aria-selected', el.dataset.id === id ? 'true' : 'false');
  }

  // Mobile master-detail: reveal the chat pane (CSS hides the rail when set).
  document.body.classList.add('session-open');

  // Subscribe
  sendWs({ type: 'subscribe', id });

  // Update header
  const session = state.sessions.find(s => s.id === id);
  const header = document.getElementById('transcript-header');
  const composer = document.getElementById('composer');
  header.hidden = false;
  composer.hidden = false;
  document.getElementById('header-session-name').textContent = session?.name || id;
  document.getElementById('header-cwd').textContent = session?.cwd || '';

  // Show existing messages if cached, else show loading placeholder
  const msgs = state.messages.get(id);
  if (msgs) {
    renderTranscript();
  } else {
    clearTranscript();
    showTranscriptPlaceholder('loading…');
  }

  syncModal();
}

// ── Transcript rendering ──────────────────────────────────────────────────
function clearTranscript() {
  const pane = document.getElementById('transcript');
  pane.textContent = '';
}

function showTranscriptPlaceholder(text) {
  const pane = document.getElementById('transcript');
  const div = document.createElement('div');
  div.className = 'transcript-empty';
  const p = document.createElement('p');
  p.textContent = text;
  div.appendChild(p);
  pane.appendChild(div);
}

function renderTranscript() {
  clearTranscript();
  const msgs = state.messages.get(state.selectedId) || [];
  const pane = document.getElementById('transcript');
  if (msgs.length === 0) {
    showTranscriptPlaceholder('no messages yet');
    return;
  }
  for (const msg of msgs) {
    pane.appendChild(buildMsgRow(msg));
  }
  scrollTranscriptToBottom();
}

function appendMessages(msgs) {
  if (!msgs || msgs.length === 0) return;
  const pane = document.getElementById('transcript');
  // Remove empty-state placeholder if present
  const empty = pane.querySelector('.transcript-empty');
  if (empty) empty.remove();
  for (const msg of msgs) {
    pane.appendChild(buildMsgRow(msg));
  }
  scrollTranscriptToBottom();
}

function scrollTranscriptToBottom() {
  const pane = document.getElementById('transcript');
  pane.scrollTop = pane.scrollHeight;
}

function buildMsgRow(msg) {
  const row = document.createElement('div');
  row.className = 'msg-row';
  row.dataset.role = msg.role;
  row.dataset.uuid = msg.uuid || '';

  // Role label
  const roleLabel = document.createElement('div');
  roleLabel.className = 'msg-role';
  roleLabel.textContent = msg.role;
  row.appendChild(roleLabel);

  // Message body
  const body = document.createElement('div');
  body.className = 'msg-body';

  for (const block of (msg.blocks || [])) {
    const el = buildBlock(block);
    if (el) body.appendChild(el);
  }

  row.appendChild(body);
  return row;
}

function buildBlock(block) {
  switch (block.kind) {
    case 'text': {
      const div = document.createElement('div');
      div.className = 'block-text';
      div.textContent = block.text;
      return div;
    }

    case 'thinking': {
      const details = document.createElement('details');
      details.className = 'block-thinking';
      const summary = document.createElement('summary');
      summary.textContent = '▸ thinking…';
      const pre = document.createElement('div');
      pre.className = 'thinking-text';
      pre.textContent = block.text;
      details.append(summary, pre);
      return details;
    }

    case 'tool_use': {
      const div = document.createElement('div');
      div.className = 'block-tool-use';
      const arrow = document.createElement('span');
      arrow.className = 'tool-arrow';
      arrow.textContent = '▸';
      const name = document.createElement('span');
      name.className = 'tool-name';
      name.textContent = block.name || '';
      const sep = document.createElement('span');
      sep.className = 'tool-sep';
      sep.textContent = '—';
      const input = document.createElement('span');
      input.className = 'tool-input';
      input.textContent = block.inputSummary || '';
      div.append(arrow, name, sep, input);
      return div;
    }

    case 'tool_result': {
      const div = document.createElement('div');
      div.className = 'block-tool-result';
      div.dataset.error = block.isError ? 'true' : 'false';
      div.textContent = block.text || '';
      return div;
    }

    default:
      return null;
  }
}

// ── Resource HUD ──────────────────────────────────────────────────────────
function updateHud(snapshot, warning) {
  if (!snapshot) return;

  const hud = document.getElementById('resource-hud');
  const overLimit = snapshot.overLimit || !!warning;

  hud.classList.toggle('warning', overLimit);

  const s = snapshot.self || {};
  const sys = snapshot.system || {};

  setHudVal('hud-cpu',  s.cpuPct  != null ? `${s.cpuPct.toFixed(1)}%` : '—');
  setHudVal('hud-rss',  s.rssMB   != null ? `${s.rssMB.toFixed(0)} MB` : '—');
  setHudVal('hud-heap', s.heapMB  != null ? `${s.heapMB.toFixed(0)} MB` : '—');

  const load = sys.loadavg;
  setHudVal('hud-load', load ? `${load[0].toFixed(2)}` : '—');
  setHudVal('hud-mem',  sys.memUsedPct != null ? `${sys.memUsedPct.toFixed(0)}%` : '—');

  const warnEl = document.getElementById('hud-warn');
  warnEl.hidden = !overLimit;
  if (overLimit) {
    const txt = document.getElementById('hud-warn-text');
    txt.textContent = warning || 'over limit';
  }
}

function setHudVal(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ── Reply composer ────────────────────────────────────────────────────────
function initComposer() {
  const input = document.getElementById('reply-input');
  const sendBtn = document.getElementById('send-btn');

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendReply();
    }
  });
  sendBtn.addEventListener('click', () => sendReply());

  // Attachments: upload raw bytes, inject the saved path into the composer so
  // the Claude session can read it (Claude Code loads image/file paths).
  const attachBtn = document.getElementById('attach-btn');
  const attachInput = document.getElementById('attach-input');
  attachBtn.addEventListener('click', () => attachInput.click());
  attachInput.addEventListener('change', async () => {
    const files = [...attachInput.files];
    attachInput.value = ''; // allow re-selecting the same file later
    for (const f of files) await uploadOne(f);
  });
}

async function uploadOne(file) {
  if (!state.selectedId) { toast('select a session first', 'error'); return; }
  toast(`uploading ${file.name}…`);
  try {
    const url = `/api/upload?name=${encodeURIComponent(file.name)}`;
    const res = await fetch(url, { method: 'POST', body: file, headers: authHeaders() });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
    insertIntoComposer(json.path);
    toast(`attached ${json.name}`, 'ok');
  } catch (err) {
    toast(`attach failed: ${err.message}`, 'error');
  }
}

function insertIntoComposer(text) {
  const input = document.getElementById('reply-input');
  const sep = input.value && !input.value.endsWith(' ') ? ' ' : '';
  input.value = `${input.value}${sep}${text} `;
  input.focus();
}

function sendReply() {
  const input = document.getElementById('reply-input');
  const text = input.value;
  if (!text.trim()) return;
  if (!state.selectedId) { toast('select a session first', 'error'); return; }
  if (!wsConnected) { toast('not connected — reconnecting…', 'error'); return; }
  sendWs({ type: 'reply', id: state.selectedId, text });
  input.value = '';
  input.style.height = '';
  toast('sent →', 'ok');
}

// ── Toast (transient feedback) ──────────────────────────────────────────────
let toastTimer = null;
function toast(message, kind = '') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = 'toast show' + (kind ? ` toast-${kind}` : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast' + (kind ? ` toast-${kind}` : ''); }, 2200);
}

// ── Modal (AskUserQuestion) ───────────────────────────────────────────────
function syncModal() {
  const id = state.selectedId;
  if (!id) { closeModal(); return; }
  const pending = state.pending.get(id);
  if (pending && pending.questions && pending.questions.length > 0) {
    openModal(pending);
  } else {
    closeModal();
  }
}

function openModal(pending) {
  if (state.modalOpen && state.modalPendingRef === pending) return;
  state.modalPendingRef = pending;
  state.modalOpen = true;
  state.modalSelections = pending.questions.map(() => new Set());

  renderModalQuestions(pending.questions);

  const modal = document.getElementById('ask-modal');
  modal.removeAttribute('hidden');

  // Focus trap: focus the first focusable element
  requestAnimationFrame(() => {
    const first = modal.querySelector('button, [tabindex="0"]');
    if (first) first.focus();
  });

  hideCaptureOutput();
}

function closeModal() {
  if (!state.modalOpen) return;
  state.modalOpen = false;
  state.modalPendingRef = null;
  state.modalSelections = [];
  const modal = document.getElementById('ask-modal');
  modal.setAttribute('hidden', '');
  hideCaptureOutput();
}

function renderModalQuestions(questions) {
  const container = document.getElementById('ask-questions');
  container.textContent = '';

  questions.forEach((q, qIdx) => {
    const block = document.createElement('div');
    block.className = 'question-block';

    if (q.header) {
      const header = document.createElement('div');
      header.className = 'question-header';
      header.textContent = q.header;
      block.appendChild(header);
    }

    const qText = document.createElement('div');
    qText.className = 'question-text';
    qText.textContent = q.question;
    block.appendChild(qText);

    if (q.multiSelect) {
      const hint = document.createElement('div');
      hint.className = 'question-hint';
      hint.textContent = 'select one or more';
      block.appendChild(hint);
    }

    if (q.options && q.options.length > 0) {
      const grid = document.createElement('div');
      grid.className = 'options-grid';

      q.options.forEach((opt) => {
        const btn = document.createElement('button');
        btn.className = 'option-btn';
        btn.setAttribute('aria-pressed', 'false');
        btn.dataset.qIdx   = qIdx;
        btn.dataset.label  = opt.label;

        const labelEl = document.createElement('span');
        labelEl.className = 'option-label';
        labelEl.textContent = opt.label;
        btn.appendChild(labelEl);

        if (opt.description) {
          const desc = document.createElement('span');
          desc.className = 'option-desc';
          desc.textContent = opt.description;
          btn.appendChild(desc);
        }

        btn.addEventListener('click', () => toggleOption(qIdx, opt.label, q.multiSelect, btn));
        grid.appendChild(btn);
      });

      block.appendChild(grid);
    }

    container.appendChild(block);
  });

  updateAnswerButtonState();
}

// Enable "send answer" only when every question has at least one selection.
function updateAnswerButtonState() {
  const btn = document.getElementById('ask-send-btn');
  if (!btn) return;
  const ready =
    state.modalSelections.length > 0 &&
    state.modalSelections.every((s) => s.size > 0);
  btn.disabled = !ready;
}

function toggleOption(qIdx, label, multiSelect, clickedBtn) {
  const sel = state.modalSelections[qIdx];
  if (!sel) return;

  if (multiSelect) {
    if (sel.has(label)) {
      sel.delete(label);
      clickedBtn.setAttribute('aria-pressed', 'false');
      clickedBtn.classList.remove('selected');
    } else {
      sel.add(label);
      clickedBtn.setAttribute('aria-pressed', 'true');
      clickedBtn.classList.add('selected');
    }
  } else {
    // radio behavior: deselect all in same question, select this
    const container = document.getElementById('ask-questions');
    const siblings = container.querySelectorAll(`[data-q-idx="${qIdx}"]`);
    for (const sib of siblings) {
      sib.setAttribute('aria-pressed', 'false');
      sib.classList.remove('selected');
    }
    sel.clear();
    sel.add(label);
    clickedBtn.setAttribute('aria-pressed', 'true');
    clickedBtn.classList.add('selected');
  }
  updateAnswerButtonState();
}

function sendAnswer() {
  const id = state.selectedId;
  const pending = state.modalPendingRef;
  if (!id || !pending) return;

  // Guard: every question must have at least one selection, else the server's
  // buildAnswerKeys throws and the modal would already be closed (silent fail).
  if (!state.modalSelections.every((s) => s.size > 0)) return;

  // selections[i] = array of chosen labels for question i
  const selections = state.modalSelections.map(s => [...s]);

  sendWs({
    type: 'answer',
    id,
    toolUseId: pending.toolUseId,
    selections,
  });

  closeModal();
}

function handleCapture(id, text) {
  if (id !== state.selectedId) return;
  const output = document.getElementById('ask-capture-output');
  const pre = document.getElementById('ask-capture-pre');
  output.hidden = false;
  pre.textContent = text || '';
}

function hideCaptureOutput() {
  const output = document.getElementById('ask-capture-output');
  const pre = document.getElementById('ask-capture-pre');
  if (output) output.hidden = true;
  if (pre) pre.textContent = '';
}

// ── Focus trap for modal ──────────────────────────────────────────────────
function initModalFocusTrap() {
  const modal = document.getElementById('ask-modal');

  modal.addEventListener('keydown', (e) => {
    if (!state.modalOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
    if (e.key !== 'Tab') return;

    const focusable = [...modal.querySelectorAll(
      'button:not([disabled]), [tabindex="0"], textarea, input, select'
    )].filter(el => !el.closest('[hidden]'));

    if (focusable.length === 0) return;
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // Click backdrop to close
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
}

// ── Connection state visual ───────────────────────────────────────────────
function setConnState(state) {
  const dot = document.getElementById('connection-dot');
  if (!dot) return;
  dot.className = 'conn-dot conn-' + state;
  dot.title = state;
}

// ── Init ──────────────────────────────────────────────────────────────────
function init() {
  // Show initial empty state
  showTranscriptPlaceholder('select a session →');

  // Wire modal buttons
  document.getElementById('ask-modal-close').addEventListener('click', closeModal);
  document.getElementById('ask-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('ask-send-btn').addEventListener('click', sendAnswer);
  document.getElementById('ask-capture-btn').addEventListener('click', () => {
    if (state.selectedId) sendWs({ type: 'capture', id: state.selectedId });
  });

  // Mobile: back to the session list (detail -> master).
  document.getElementById('mobile-back').addEventListener('click', () => {
    document.body.classList.remove('session-open');
  });

  initComposer();
  initModalFocusTrap();

  // Start WS
  connect();
}

document.addEventListener('DOMContentLoaded', init);

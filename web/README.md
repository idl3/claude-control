# claude-cockpit web (assistant-ui frontend)

React + Vite + TypeScript frontend for claude-cockpit, built on
[`@assistant-ui/react`](https://www.assistant-ui.com/docs/ui/thread) for the
chat thread, composer, and attachments. It replaces the vanilla
`public/{index.html,app.js,styles.css}` UI, which is left in place as a
fallback.

## Build & serve

```bash
cd web
npm install
npm run build        # → web/dist/index.html + web/dist/assets/*
```

- `vite.config.ts` sets `build.outDir = dist` and `base: './'`, so the bundle
  loads under any path (e.g. behind `tailscale serve`) and makes no runtime
  CDN/network calls — everything is bundled.
- Point the cockpit server's static root at `web/dist` to serve this UI. The
  parent server is wired separately (this project does not modify anything
  outside `web/`).

Scripts: `dev` (Vite dev server), `build` (`tsc -b && vite build`),
`preview` (serve the built `dist`).

## How it talks to the backend

Same-origin. The page is opened as `?token=<t>`; the token is read from
`window.location.search` and appended to every API call (`&token=…`) and the
WebSocket URL (`?token=…`, `wss:` when the page is `https:`). See
`src/lib/api.ts` and `src/lib/ws.ts`. The WS reconnects with capped backoff and
re-subscribes to the selected session on every (re)open.

## assistant-ui integration approach

Uses the **external-store runtime** (`useExternalStoreRuntime`):

- Our WebSocket is the single source of truth (`src/hooks/useClaudeControl.ts`). The
  transcript `Msg[]` is converted to assistant-ui `ThreadMessageLike[]` in
  `src/lib/convert.ts` and passed to the runtime as already-converted messages.
- `onNew` (composer send) dispatches `{type:'reply',…}` over the WS. We do **not**
  optimistically append — Claude's echo arrives via the WS `append` stream, so
  the transcript stays authoritative.
- Block → part mapping: `text`→text, `thinking`→a collapsible dim reasoning
  block, `tool_use`→a compact `▸ name — inputSummary` chip, `tool_result`→a dim
  quoted block (red tint on error). `tool_result` blocks are folded into their
  originating `tool-call` part by `toolUseId` during whole-array conversion.
- All transcript text renders through React/assistant-ui (escaped). No
  `dangerouslySetInnerHTML` is used anywhere — tool output is arbitrary.

Why external-store over the local/chat runtime: this is a read-only transcript
mirror with tmux-send semantics, not a request/response chat loop. The external
store lets the WS own state while we still get the full assistant-ui
Thread/Composer/attachment UI and primitives.

## Files

- `src/lib/types.ts` — backend contract types.
- `src/lib/api.ts` — token + upload helpers.
- `src/lib/ws.ts` — reconnecting WebSocket client.
- `src/lib/convert.ts` — `Msg[]` → assistant-ui messages.
- `src/hooks/useClaudeControl.ts` — WS-backed store.
- `src/components/` — `Thread`, `Messages`, `MessageParts`, `Composer`,
  `SessionRail`, `ResourceHud`, `AskModal`, `Toast`.
- `src/App.tsx` — wires the runtime, rail, HUD, modal, and toasts.

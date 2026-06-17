# Voice → Text in claude-control

Marp source of truth for the deck. Render with `marp voice-stt.md` or open the
self-contained `voice-stt.html` (no deps, works offline).

---

## Slide 1 — Title

**Voice → Text, done right**
Local speech-to-text for the claude-control composer.

Speak your prompt. It transcribes on-device. No API key, no cloud.

---

## Slide 2 — The ask

> "I want to speak my prompt into the composer."

There was already a mic button and a recording dialog. But on the iPad it
**did nothing**, and even on desktop the transcription was unreliable.

Goal: tap mic → speak → text lands in the composer. Everywhere.

---

## Slide 3 — Two bugs, not one

Debugging found **two independent failures**:

1. **"Nothing happens" on tap** → the live page was a **stale cached SPA bundle**.
   The deployed JS was newer than what the browser had loaded. (This is why
   pull-to-refresh exists.)
2. **Transcription silently produced nothing** → the dialog used the **Web Speech
   API** (`webkitSpeechRecognition`), which is **unsupported on iOS Safari** and
   flaky on desktop Safari.

Plus a lurking trap: `getUserMedia` needs a **secure context** (HTTPS/localhost).
Over plain `http://` Tailscale the mic is blocked entirely. (We're on HTTPS — fine.)

---

## Slide 4 — The decision

| Approach | iOS Safari | No API key | Verdict |
|---|---|---|---|
| Web Speech API (old) | ❌ | ✅ | Fragile — silent failures |
| **Local whisper.cpp** | ✅ | ✅ | **Chosen** — one path, private |
| Hosted Whisper | ✅ | ❌ needs key | Against no-key design |

Pick the one that works **everywhere with a mic** and keeps the project's
no-key design: **record in the browser, transcribe on the server.**

---

## Slide 5 — Architecture

```
Browser                         Server (Node)
┌───────────────────────┐       ┌──────────────────────────────┐
│ MediaRecorder (audio)  │       │ POST /api/transcribe          │
│ + Web Audio waveform   │──blob─▶│  (token-gated)               │
│ Cancel / Pause / Stop  │       │   ↓ ffmpeg → 16kHz mono WAV   │
└───────────────────────┘       │   ↓ whisper-cli (ggml-base.en)│
        ▲                        │   ↓ cleanTranscript()         │
        │   { ok, text }         └──────────────┬───────────────┘
        └────────────────────────────────────────┘
                    insert into composer (review-then-send)
```

The waveform comes from a Web Audio `AnalyserNode` — independent of transcription,
so it animates regardless of which browser you're on.

---

## Slide 6 — Server side (`lib/transcribe.js`)

```js
export async function transcribe(inputPath, { lang = 'en' } = {}) {
  const ffmpeg  = resolveFfmpeg();
  const whisper = resolveWhisperBin();
  const model   = resolveWhisperModel();   // ~/.claude-control/models/ggml-base.en.bin
  // ... guard each ...
  await run(ffmpeg,  ['-i', inputPath, '-ar','16000','-ac','1',
                      '-c:a','pcm_s16le','-f','wav', wav]);
  const { stdout } = await run(whisper, ['-m',model,'-f',wav,'-np','-nt','-l',lang]);
  return cleanTranscript(stdout);   // strip [BLANK_AUDIO], timestamps, blanks
}
```

Route `POST /api/transcribe` mirrors the existing upload handler: byte-cap,
temp file, token-gated. Binaries/model overridable via env.

---

## Slide 7 — Client side (`VoiceDialog.tsx`)

Web Speech ripped out; **MediaRecorder** in. Kept the waveform + Cancel/Pause/Stop.

```tsx
rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
rec.start();                              // one blob, flushed on stop()
// on Stop:
rec.onstop = async () => {
  const blob = new Blob(chunks, { type: mime });
  const text = await transcribeAudio(blob, ext);  // POST → server STT
  onCommit(text);                          // → composer (review-then-send)
};
```

`pickMime()` chooses `webm/opus` (Chrome) or `mp4` (Safari) so iOS works too.

---

## Slide 8 — Why it works everywhere

- **Secure context:** HTTPS over Tailscale → `getUserMedia` allowed.
- **Capture:** MediaRecorder is supported on Chrome, desktop Safari, **and iOS Safari**.
- **Transcription:** runs on the Mac, not the browser — uniform across devices.
- **Privacy + cost:** fully local (whisper.cpp), no API key, no audio leaves the host.
- **Always exitable:** Cancel / Pause / Stop + full teardown (no stuck mic).

---

## Slide 9 — Verification

- `tsc` + `vite build`: **clean**.
- Test suite: **178/178 pass** (+5 new `cleanTranscript` unit tests).
- Real end-to-end through the HTTP route:

```
say "the quick brown fox…" → webm → POST /api/transcribe
→ { "ok": true, "text": "The quick brown fox jumps over the lazy dog." }
```

---

## Slide 10 — What changed

- **New:** `lib/transcribe.js`, `test/transcribe.test.js`
- **Edited:** `server.js` (+route/handler), `web/src/lib/api.ts` (`transcribeAudio`),
  `web/src/components/VoiceDialog.tsx` (MediaRecorder rewrite)
- **Host setup:** `brew install whisper-cpp` + `ggml-base.en.bin` (~141 MB)
- **Deploy:** commit → `launchctl kickstart` → `/api/health` ✅

---

## Slide 11 — Takeaways

1. "Nothing happens" is often a **caching** problem, not a code problem.
2. **Web Speech API ≠ cross-browser.** For real coverage, record + server-STT.
3. The **secure-context** rule silently kills mic/camera over plain HTTP.
4. Keeping the waveform on **Web Audio** decoupled the UI from the STT engine.

**Result:** speak anywhere, transcribe locally, no key. 🎙️→📝

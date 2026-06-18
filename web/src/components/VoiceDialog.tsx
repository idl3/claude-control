import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribeAudio } from '../lib/api';
import { useModalTransition } from '../lib/anim';

function getAudioCtx(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

// Pick a MediaRecorder mime the browser actually supports. Chrome → webm/opus,
// Safari/iOS → mp4. The returned `ext` is sent to the server so ffmpeg names
// the temp file correctly. '' lets the browser choose its default.
function pickMime(): { mime: string; ext: string } {
  const MR = typeof window !== 'undefined' ? window.MediaRecorder : undefined;
  const candidates: { mime: string; ext: string }[] = [
    { mime: 'audio/webm;codecs=opus', ext: 'webm' },
    { mime: 'audio/webm', ext: 'webm' },
    { mime: 'audio/mp4', ext: 'mp4' },
    { mime: 'audio/aac', ext: 'aac' },
    { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
  ];
  if (MR && typeof MR.isTypeSupported === 'function') {
    for (const c of candidates) if (MR.isTypeSupported(c.mime)) return c;
  }
  return { mime: '', ext: 'webm' };
}

type Status = 'starting' | 'recording' | 'paused' | 'transcribing' | 'error';

interface VoiceDialogProps {
  /** Called with the transcribed text (empty if nothing was said). */
  onCommit: (text: string) => void;
  /** Called on Cancel / Esc / backdrop — discard, nothing committed. */
  onClose: () => void;
}

/**
 * Recording dialog: live mic waveform (Web Audio AnalyserNode) + MediaRecorder
 * capture, with explicit Cancel / Pause-Resume / Stop controls and full
 * teardown — so recording can ALWAYS be stopped/exited. On Stop the recorded
 * audio is uploaded to the server for local speech-to-text (ffmpeg →
 * whisper.cpp), and the transcript is inserted into the composer. This works in
 * any browser that can record audio, including iOS Safari (the Web Speech API
 * does not).
 */
export function VoiceDialog({ onCommit, onClose: rawClose }: VoiceDialogProps) {
  const { rootRef, requestClose: onClose } = useModalTransition(rawClose);
  const [status, setStatus] = useState<Status>('starting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const recSupported = typeof window !== 'undefined' && 'MediaRecorder' in window;

  const streamRef = useRef<MediaStream | null>(null);
  const acRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<{ mime: string; ext: string }>({ mime: '', ext: 'webm' });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const drawingRef = useRef(false);
  const committedRef = useRef(false);

  const stopDraw = useCallback(() => {
    drawingRef.current = false;
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const buf = new Uint8Array(analyser.fftSize);
    const stroke =
      getComputedStyle(canvas).getPropertyValue('--accent').trim() || '#7aa2f7';
    drawingRef.current = true;
    const render = () => {
      if (!drawingRef.current) return;
      if (canvas.width !== canvas.clientWidth) canvas.width = canvas.clientWidth;
      analyser.getByteTimeDomainData(buf);
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = 2;
      ctx.strokeStyle = stroke;
      ctx.beginPath();
      const slice = w / buf.length;
      for (let i = 0; i < buf.length; i += 1) {
        const v = buf[i] / 128; // 0..2, 1 = silence
        const y = (v * h) / 2;
        const x = i * slice;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      rafRef.current = requestAnimationFrame(render);
    };
    rafRef.current = requestAnimationFrame(render);
  }, []);

  // Stop the mic stream + audio graph + waveform. Leaves the recorder alone
  // (callers decide whether its data is used or discarded).
  const teardownAudio = useCallback(() => {
    stopDraw();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    acRef.current?.close().catch(() => {});
    acRef.current = null;
    analyserRef.current = null;
  }, [stopDraw]);

  // Mount → request mic, wire analyser + recorder.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('no-getusermedia');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const AC = getAudioCtx();
        if (AC) {
          const ac = new AC();
          acRef.current = ac;
          if (ac.state === 'suspended') await ac.resume();
          const src = ac.createMediaStreamSource(stream);
          const analyser = ac.createAnalyser();
          analyser.fftSize = 512;
          src.connect(analyser);
          analyserRef.current = analyser;
        }
        if (!('MediaRecorder' in window)) throw new Error('no-mediarecorder');
        const picked = pickMime();
        mimeRef.current = picked;
        const rec = picked.mime
          ? new MediaRecorder(stream, { mimeType: picked.mime })
          : new MediaRecorder(stream);
        rec.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorderRef.current = rec;
        rec.start(); // one blob flushed on stop()
        setStatus('recording');
        draw();
      } catch (err) {
        const kind = err instanceof Error ? err.message : '';
        setErrorMsg(
          kind === 'no-mediarecorder'
            ? 'Audio recording isn’t supported in this browser.'
            : 'Microphone permission denied or unavailable.',
        );
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
      stopDraw();
      try {
        recorderRef.current?.stop();
      } catch {
        /* ignore */
      }
      recorderRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      acRef.current?.close().catch(() => {});
      acRef.current = null;
      analyserRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pause = useCallback(() => {
    try {
      recorderRef.current?.pause();
    } catch {
      /* ignore */
    }
    stopDraw();
    setStatus('paused');
  }, [stopDraw]);

  const resume = useCallback(() => {
    try {
      recorderRef.current?.resume();
    } catch {
      /* ignore */
    }
    setStatus('recording');
    draw();
  }, [draw]);

  const stop = useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    const rec = recorderRef.current;
    if (!rec) {
      teardownAudio();
      onCommit('');
      return;
    }
    setStatus('transcribing');
    rec.onstop = async () => {
      const { mime, ext } = mimeRef.current;
      const blob = new Blob(chunksRef.current, { type: mime || 'audio/webm' });
      teardownAudio();
      if (blob.size === 0) {
        onCommit('');
        return;
      }
      try {
        const text = await transcribeAudio(blob, ext);
        onCommit(text);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Transcription failed.');
        setStatus('error');
      }
    };
    try {
      rec.stop(); // flushes a final dataavailable, then fires onstop
    } catch {
      teardownAudio();
      onCommit('');
    }
  }, [teardownAudio, onCommit]);

  const cancel = useCallback(() => {
    committedRef.current = true; // suppress any in-flight onstop commit
    try {
      recorderRef.current?.stop();
    } catch {
      /* ignore */
    }
    recorderRef.current = null;
    teardownAudio();
    onClose();
  }, [teardownAudio, onClose]);

  // Esc cancels (but not mid-transcribe — that's a network call in flight).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && status !== 'transcribing') {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel, status]);

  const statusLabel =
    status === 'error'
      ? 'Microphone unavailable'
      : status === 'transcribing'
        ? 'Transcribing…'
        : status === 'paused'
          ? 'Paused'
          : status === 'starting'
            ? 'Starting…'
            : 'Listening…';

  return (
    <div
      className="modal-backdrop"
      ref={rootRef}
      onClick={(e) => {
        if (e.target === e.currentTarget && status !== 'transcribing') cancel();
      }}
    >
      <div className="modal voice-dialog" role="dialog" aria-modal="true" aria-label="Voice input">
        <div className="voice-status">
          <span className="voice-dot" data-on={status === 'recording' ? 'true' : undefined} />
          {statusLabel}
        </div>

        <canvas
          ref={canvasRef}
          className="voice-wave"
          height={72}
          data-paused={status !== 'recording' ? 'true' : undefined}
        />

        <div className="voice-transcript">
          {status === 'transcribing' ? (
            <span className="voice-placeholder">Converting speech to text…</span>
          ) : (
            <span className="voice-placeholder">
              Speak, then tap “Stop &amp; insert” to transcribe.
            </span>
          )}
        </div>

        {status === 'error' ? (
          <div className="voice-error">{errorMsg || 'Could not start recording.'}</div>
        ) : !recSupported ? (
          <div className="voice-note">Audio recording isn’t supported in this browser.</div>
        ) : null}

        <div className="voice-actions">
          <button type="button" className="btn-secondary" onClick={cancel} disabled={status === 'transcribing'}>
            Cancel
          </button>
          <span className="voice-actions-spacer" />
          {status === 'recording' ? (
            <button type="button" className="btn-secondary" onClick={pause}>
              Pause
            </button>
          ) : status === 'paused' ? (
            <button type="button" className="btn-secondary" onClick={resume}>
              Resume
            </button>
          ) : null}
          <button
            type="button"
            className="btn-primary"
            onClick={stop}
            disabled={status === 'error' || status === 'transcribing' || status === 'starting'}
          >
            {status === 'transcribing' ? 'Transcribing…' : 'Stop & Insert'}
          </button>
        </div>
      </div>
    </div>
  );
}

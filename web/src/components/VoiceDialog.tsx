import { useCallback, useEffect, useRef, useState } from 'react';

// Minimal Web Speech API typings (absent from TS DOM lib).
interface SpeechAlternative {
  transcript: string;
}
interface SpeechResultLike {
  readonly isFinal: boolean;
  readonly 0: SpeechAlternative;
}
interface SpeechResultEvent {
  resultIndex: number;
  results: ArrayLike<SpeechResultLike>;
}
interface SpeechErrorEvent {
  error?: string;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
function getAudioCtx(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

type Status = 'starting' | 'recording' | 'paused' | 'error';

interface VoiceDialogProps {
  /** Called on Stop with the (possibly empty) accumulated transcript. */
  onCommit: (text: string) => void;
  /** Called on Cancel / Esc / backdrop — discard, nothing committed. */
  onClose: () => void;
}

/**
 * Recording dialog: live mic waveform (Web Audio AnalyserNode) + Web Speech
 * transcription, with explicit Cancel / Pause-Resume / Stop controls and full
 * teardown — so recording can ALWAYS be stopped/exited (fixes the "stuck after
 * permission, no way out" bug). Stop commits the transcript into the composer;
 * Cancel discards. Transcription is best-effort (some browsers lack the Web
 * Speech API — the waveform + Stop/Cancel still work).
 */
export function VoiceDialog({ onCommit, onClose }: VoiceDialogProps) {
  const [status, setStatus] = useState<Status>('starting');
  const [errorKind, setErrorKind] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const srSupported = getSpeechCtor() !== null;

  const finalRef = useRef('');
  const streamRef = useRef<MediaStream | null>(null);
  const acRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const drawingRef = useRef(false);
  const committedRef = useRef(false);
  const interimRef = useRef('');
  interimRef.current = interim;

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

  const startRecognition = useCallback(() => {
    const Ctor = getSpeechCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
    rec.onresult = (e) => {
      let f = '';
      let it = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const r = e.results[i];
        if (r.isFinal) f += r[0].transcript;
        else it += r[0].transcript;
      }
      if (f.trim()) {
        finalRef.current = (finalRef.current + ' ' + f).trim();
        setTranscript(finalRef.current);
      }
      setInterim(it);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setErrorKind('not-allowed');
        setStatus('error');
      }
    };
    rec.onend = () => {
      /* ends on stop()/pause; resume creates a fresh instance */
    };
    recRef.current = rec;
    try {
      rec.start();
    } catch {
      /* already started / transient */
    }
  }, []);

  const teardown = useCallback(() => {
    stopDraw();
    try {
      recRef.current?.abort();
    } catch {
      /* ignore */
    }
    recRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    acRef.current?.close().catch(() => {});
    acRef.current = null;
    analyserRef.current = null;
  }, [stopDraw]);

  // Mount → request mic, wire analyser + recognition.
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
        setStatus('recording');
        draw();
        startRecognition();
      } catch {
        setErrorKind('not-allowed');
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pause = useCallback(() => {
    try {
      recRef.current?.stop();
    } catch {
      /* ignore */
    }
    recRef.current = null;
    stopDraw();
    setStatus('paused');
  }, [stopDraw]);

  const resume = useCallback(() => {
    setStatus('recording');
    draw();
    startRecognition();
  }, [draw, startRecognition]);

  const stop = useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    const text = (finalRef.current + ' ' + interimRef.current).trim();
    teardown();
    onCommit(text);
  }, [teardown, onCommit]);

  const cancel = useCallback(() => {
    teardown();
    onClose();
  }, [teardown, onClose]);

  // Esc cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel]);

  const live = transcript + (interim ? (transcript ? ' ' : '') + interim : '');

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div className="modal voice-dialog" role="dialog" aria-modal="true" aria-label="Voice input">
        <div className="voice-status">
          <span className="voice-dot" data-on={status === 'recording' ? 'true' : undefined} />
          {status === 'error'
            ? 'Microphone unavailable'
            : status === 'paused'
              ? 'Paused'
              : status === 'starting'
                ? 'Starting…'
                : 'Listening…'}
        </div>

        <canvas ref={canvasRef} className="voice-wave" height={72} data-paused={status !== 'recording' ? 'true' : undefined} />

        <div className="voice-transcript">
          {live ? live : <span className="voice-placeholder">Speak now — your words appear here.</span>}
        </div>

        {status === 'error' ? (
          <div className="voice-error">
            {errorKind === 'not-allowed'
              ? 'Microphone permission denied or unavailable on this browser.'
              : 'Could not start recording.'}
          </div>
        ) : !srSupported ? (
          <div className="voice-note">Live transcription isn’t supported in this browser — recording works, but no text will be captured.</div>
        ) : null}

        <div className="voice-actions">
          <button type="button" className="btn-secondary" onClick={cancel}>
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
          <button type="button" className="btn-primary" onClick={stop} disabled={status === 'error'}>
            Stop &amp; insert
          </button>
        </div>
      </div>
    </div>
  );
}

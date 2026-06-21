import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribeAudio } from '../lib/api';

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

export type VoiceStatus = 'starting' | 'recording' | 'paused' | 'transcribing' | 'error';

export interface UseVoiceRecorderOptions {
  /** Called with the transcribed text when stop+transcribe completes. */
  onCommit: (text: string) => void;
  /** Called when the session should be dismissed (cancel or error exit). */
  onClose: () => void;
  /**
   * When true the hook acquires the mic and starts recording.
   * When false (pre-rendered-idle shell) the mic is NOT acquired — no
   * getUserMedia call, no MediaRecorder, no analyser. The hook is mounted
   * and holds its refs, but stays completely inactive until active=true.
   *
   * This allows the VoiceInline shell to be always-mounted in the DOM for
   * pre-render animation while respecting privacy (no mic grab when idle).
   */
  active: boolean;
}

export interface UseVoiceRecorderResult {
  status: VoiceStatus;
  errorMsg: string | null;
  /** Ref forwarded to the <canvas> the hook drives with waveform data. */
  canvasRef: React.RefObject<HTMLCanvasElement>;
  pauseResume: () => void;
  /** Stop recording and kick off transcription → onCommit. */
  stop: () => void;
  /** Discard and call onClose. */
  cancel: () => void;
}

/**
 * Encapsulates mic acquisition, MediaRecorder capture, Web Audio waveform
 * drawing, and Whisper transcription upload.
 *
 * Mic lifecycle is GATED by `active`. When active=false the hook is mounted
 * but dormant — no getUserMedia is called. When active=true the mic is
 * acquired and recording starts. When active flips back to false the mic is
 * torn down (and any in-flight transcription is aborted per PLE-50).
 *
 * Callers should keep the hook mounted while the voice shell is in the DOM
 * (even when idle/hidden) and simply toggle `active` to start/stop recording.
 */
export function useVoiceRecorder({ onCommit, onClose, active }: UseVoiceRecorderOptions): UseVoiceRecorderResult {
  const [status, setStatus] = useState<VoiceStatus>('starting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const acRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<{ mime: string; ext: string }>({ mime: '', ext: 'webm' });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const drawingRef = useRef(false);
  const committedRef = useRef(false);
  const mountedRef = useRef(true);
  const transcribeAbortRef = useRef<AbortController | null>(null);

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

  // Track mount state so post-await setState never fires on an unmounted hook.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      transcribeAbortRef.current?.abort();
      transcribeAbortRef.current = null;
    };
  }, []);

  // Mic lifecycle: acquire when active=true, tear down when active=false.
  // This is the ONLY place getUserMedia is called — never when active=false.
  useEffect(() => {
    if (!active) {
      // Idle / pre-rendered shell: reset to starting state without touching the mic.
      committedRef.current = false;
      chunksRef.current = [];
      setStatus('starting');
      setErrorMsg(null);
      return;
    }

    let cancelled = false;
    committedRef.current = false;
    chunksRef.current = [];

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
        const name = err instanceof Error ? err.name : '';
        let msg: string;
        if (kind === 'no-mediarecorder') {
          msg = "Audio recording isn't supported in this browser.";
        } else if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          // Insecure origin (http on a LAN IP): the mic API is disabled outright.
          msg =
            "Microphone needs a secure (HTTPS) connection. You're on " +
            location.origin +
            " — serve over HTTPS (e.g. `tailscale serve --bg 4317`) so the browser allows the mic.";
        } else if (name === 'NotAllowedError' || name === 'SecurityError') {
          // Secure origin but permission blocked/denied. On iOS Safari the grant
          // also doesn't persist across reloads in a browser TAB — installing to
          // the Home Screen (standalone) makes it stick.
          msg =
            'Microphone blocked. On iPhone/iPad: reset it in Settings → Apps → Safari → Microphone (or the "aA" → Website Settings menu), then reload. Add this app to your Home Screen so the permission persists across reloads.';
        } else if (name === 'NotFoundError' || name === 'NotReadableError') {
          msg = "No microphone available (or it's in use by another app).";
        } else {
          msg = 'Microphone permission denied or unavailable.';
        }
        setErrorMsg(msg);
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      // Abort any in-flight transcription (PLE-50).
      transcribeAbortRef.current?.abort();
      transcribeAbortRef.current = null;
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
  }, [active]);

  const pauseResume = useCallback(() => {
    if (status === 'recording') {
      try {
        recorderRef.current?.pause();
      } catch {
        /* ignore */
      }
      stopDraw();
      setStatus('paused');
    } else if (status === 'paused') {
      try {
        recorderRef.current?.resume();
      } catch {
        /* ignore */
      }
      setStatus('recording');
      draw();
    }
  }, [status, stopDraw, draw]);

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
      const controller = new AbortController();
      transcribeAbortRef.current = controller;
      try {
        const text = await transcribeAudio(blob, ext, controller.signal);
        if (mountedRef.current && !controller.signal.aborted) {
          onCommit(text);
        }
      } catch (err) {
        // User cancel → swallow silently; do NOT set error state.
        if ((err as { name?: string })?.name === 'AbortError') return;
        if (mountedRef.current && !controller.signal.aborted) {
          setErrorMsg(err instanceof Error ? err.message : 'Transcription failed.');
          setStatus('error');
        }
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
    transcribeAbortRef.current?.abort();
    transcribeAbortRef.current = null;
    // Clear onstop BEFORE calling stop() so the recorder's stop event does not
    // re-enter the transcription path (onstop was set by stop(); cancel must
    // not retrigger it).
    const rec = recorderRef.current;
    if (rec) rec.onstop = null;
    try {
      rec?.stop();
    } catch {
      /* ignore */
    }
    recorderRef.current = null;
    teardownAudio();
    onClose();
  }, [teardownAudio, onClose]);

  return { status, errorMsg, canvasRef, pauseResume, stop, cancel };
}

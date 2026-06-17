import { useCallback, useEffect, useRef, useState } from 'react';

// Minimal typings for the Web Speech API (not in TS's DOM lib). We only use the
// handful of members below.
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

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface Dictation {
  supported: boolean;
  recording: boolean;
  error: string | null;
  toggle: () => void;
  stop: () => void;
}

/**
 * Web Speech API dictation. Calls `onFinal` with each FINALISED transcript
 * segment (interim results are ignored so the composer text doesn't churn).
 * Continuous + interim internally; the caller appends finals into the composer.
 * Graceful: `supported=false` where the API is absent (e.g. some iOS/Firefox);
 * permission denial surfaces as `error='not-allowed'`.
 */
export function useDictation(onFinal: (text: string) => void): Dictation {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supported] = useState(() => getCtor() !== null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    setError(null);
    const Ctor = getCtor();
    if (!Ctor) {
      setError('unsupported');
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
    rec.onresult = (e) => {
      let finalText = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
      }
      if (finalText.trim()) onFinalRef.current(finalText);
    };
    rec.onerror = (e) => {
      setError(e.error || 'error');
      setRecording(false);
    };
    rec.onend = () => {
      setRecording(false);
      recRef.current = null;
    };
    recRef.current = rec;
    try {
      rec.start();
      setRecording(true);
    } catch {
      setError('start-failed');
      recRef.current = null;
    }
  }, []);

  const toggle = useCallback(() => {
    if (recording) stop();
    else start();
  }, [recording, start, stop]);

  // Abort any live recognition on unmount.
  useEffect(() => () => recRef.current?.abort(), []);

  return { supported, recording, error, toggle, stop };
}

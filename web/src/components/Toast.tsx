import { useEffect, useState } from 'react';

export interface ToastMessage {
  id: number;
  text: string;
  kind: 'ok' | 'error' | '';
}

interface ToastViewProps {
  toast: ToastMessage | null;
}

// Transient top toast. Auto-hides via the key-driven remount in App.
export function ToastView({ toast }: ToastViewProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;
  return (
    <div
      className={`toast ${visible ? 'show' : ''} ${toast.kind ? `toast-${toast.kind}` : ''}`}
      role="status"
      aria-live="polite"
    >
      {toast.text}
    </div>
  );
}

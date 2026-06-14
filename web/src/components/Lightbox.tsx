import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

// A single app-wide image lightbox. Replaces opening images in a new tab:
// composer thumbnails and in-transcript image previews call `open(src)` to show
// the full image in an overlay (click backdrop / Esc to dismiss).

interface LightboxApi {
  open: (src: string, alt?: string) => void;
}

const LightboxContext = createContext<LightboxApi>({ open: () => {} });

export function useLightbox(): LightboxApi {
  return useContext(LightboxContext);
}

export function LightboxProvider({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<{ src: string; alt: string } | null>(null);
  const open = useCallback((src: string, alt = '') => setItem({ src, alt }), []);
  const close = useCallback(() => setItem(null), []);

  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, close]);

  return (
    <LightboxContext.Provider value={{ open }}>
      {children}
      {item ? (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          onClick={close}
        >
          <img
            className="lightbox-img"
            src={item.src}
            alt={item.alt}
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            className="lightbox-close"
            aria-label="Close preview"
            onClick={close}
          >
            ×
          </button>
        </div>
      ) : null}
    </LightboxContext.Provider>
  );
}

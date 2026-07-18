import { useUrlActions } from './UrlActionContext';

export interface UrlLinkProps {
  url: string;
  children?: React.ReactNode;
  /** 'code' keeps the surrounding monospace font (used inside inline code /
   * fenced code blocks); 'prose' (default) matches the existing `.aui-md a`
   * link look. */
  variant?: 'prose' | 'code';
}

/**
 * The ONE component every clickable URL in the assistant transcript renders
 * through — prose (via the `a` MD_COMPONENTS override), inline code, and
 * fenced code blocks (via `linkifyChildren`/`hljsHtmlToNodes` in
 * MarkdownText.tsx) all funnel here, so there is exactly one popover
 * mechanism (see UrlActionContext) regardless of where the URL appeared.
 *
 * Renders a real `<a href>` — not a button/span — so it stays focusable
 * (Enter activates it, matching every other link in the transcript),
 * exposes the URL via the browser's native hover/status-bar/long-press
 * affordances, and lets a modifier-click or middle-click bypass the popover
 * entirely and let the browser open a real new tab/window, same as any
 * other link on the page.
 */
export function UrlLink({ url, children, variant = 'prose' }: UrlLinkProps) {
  const { showMenu } = useUrlActions();

  return (
    <a
      href={url}
      className={variant === 'code' ? 'cc-urllink cc-urllink--code' : 'cc-urllink'}
      onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
        if (e.metaKey || e.ctrlKey || e.button === 1) return; // let the OS/browser open its own new tab
        e.preventDefault();
        showMenu(url, e.currentTarget);
      }}
    >
      {children ?? url}
    </a>
  );
}

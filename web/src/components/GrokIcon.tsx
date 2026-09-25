/**
 * Grok (xAI) glyph — a stylised "X" stroke mark. Uses `currentColor` so it
 * inherits the pane-icon color and dims with the active/inactive +
 * working/sleeping states exactly like ClaudeRobotIcon / CodexIcon.
 */
export function GrokIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d="M4 4l16 16" />
      <path d="M20 4l-6.5 6.5" />
      <path d="M4 20l6.5-6.5" />
    </svg>
  );
}

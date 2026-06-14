/** Pixel-art Claude robot icon, ~18px tall, terracotta fill with themed eye cutouts. */
export function ClaudeRobotIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={Math.round(size * 1.2)}
      viewBox="0 0 10 12"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {/* Body — terracotta fill */}
      <rect x="1" y="2" width="8" height="7" fill="#c97c5a" />
      {/* Ear nubs — left and right */}
      <rect x="0" y="3" width="1" height="2" fill="#c97c5a" />
      <rect x="9" y="3" width="1" height="2" fill="#c97c5a" />
      {/* Eye cutouts — use var(--bg) so they invert with the theme */}
      <rect x="2" y="4" width="2" height="2" fill="var(--bg)" />
      <rect x="6" y="4" width="2" height="2" fill="var(--bg)" />
      {/* Legs */}
      <rect x="2" y="9" width="2" height="2" fill="#c97c5a" />
      <rect x="6" y="9" width="2" height="2" fill="#c97c5a" />
    </svg>
  );
}

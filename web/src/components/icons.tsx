// Inline lucide-style icons (MIT). Kept inline so we add no icon dependency —
// the app needs only a handful. All inherit `currentColor` and a 24-grid stroke.
import type { SVGProps } from 'react';

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function Svg({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function PencilIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Svg>
  );
}

export function RefreshIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </Svg>
  );
}

export function TerminalSquareIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m7 11 2-2-2-2" />
      <path d="M11 13h4" />
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
    </Svg>
  );
}

// Bare (unboxed) `>_` glyph — distinct from TerminalSquareIcon's bordered
// variant. Shared by the composer's own scratch-shell toggle and the header
// action bar's "Open agent terminal" button (moved out of Composer.tsx so
// both call sites use one definition).
export function TerminalIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 8l4 4-4 4M12 16h7" />
    </Svg>
  );
}

export function BotIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </Svg>
  );
}

// lucide's "layers" glyph — stacked artifact versions/kinds, used for the
// header's session-artifacts toggle.
export function GalleryIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.66 0l8.58-3.9A1 1 0 0 0 22 12" />
      <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.66 0l8.58-3.9A1 1 0 0 0 22 17" />
    </Svg>
  );
}

// shadcn's sidebar toggle glyph — a panel with a divider.
export function PanelLeftIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </Svg>
  );
}

export function SettingsIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

export function ActivityIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </Svg>
  );
}

export function EllipsisIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </Svg>
  );
}

export function XIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Svg>
  );
}

export function FunnelIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
    </Svg>
  );
}

export function ArrowDownIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </Svg>
  );
}

export function SearchIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </Svg>
  );
}

// Steering-wheel glyph — the olam "hard steer" toggle in the detail action bar
// (Change 1: relocated out of the old .olam-steer-bar).
export function SteeringWheelIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 3v6.5" />
      <path d="m5.6 8.5 5.7 3.3" />
      <path d="m18.4 8.5-5.7 3.3" />
      <path d="M12 14.5V21" />
    </Svg>
  );
}

// External-link glyph — the olam "Open PR" action bar button.
export function ExternalLinkIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
    </Svg>
  );
}

// Cloud glyph — leading icon for remote (olam) session rail rows, the
// analogue of ClaudeRobotIcon/CodexIcon for local panes (Change 2).
export function CloudIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.4-1.5A4.5 4.5 0 0 0 6.5 19h11z" />
    </Svg>
  );
}

// Battery with a fill bar (width set inline by the caller) + optional charge bolt.
export function StopIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="5" y="5" width="14" height="14" rx="2" ry="2" fill="currentColor" stroke="none" />
    </Svg>
  );
}

// Lucide "sparkles" glyph — marks Skill invocations (transcript chip + modal
// header), replacing the 🧩 emoji so it sits in the app's icon language.
export function SkillIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
      <path d="M4 17v2" />
      <path d="M5 18H3" />
    </Svg>
  );
}

// Mobile-UX fix #1 (Prototype Studio icon-led toolbar): leading icons for the
// Screenshot button, the device-size bar (phone/tablet/monitor), and the
// annotate toolbar (text tool, undo, cancel/save). Reuses PencilIcon (pen
// tool) and XIcon (cancel) rather than adding near-duplicates.
export function CameraIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
      <circle cx="12" cy="13" r="3" />
    </Svg>
  );
}

export function SmartphoneIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect width="14" height="20" x="5" y="2" rx="2" />
      <path d="M12 18h.01" />
    </Svg>
  );
}

export function TabletIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect width="16" height="20" x="4" y="2" rx="2" />
      <path d="M12 18h.01" />
    </Svg>
  );
}

export function MonitorIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </Svg>
  );
}

export function TypeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" x2="15" y1="20" y2="20" />
      <line x1="12" x2="12" y1="4" y2="20" />
    </Svg>
  );
}

export function UndoIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Svg>
  );
}

export function CheckIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  );
}

export function ArrowUpRightIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </Svg>
  );
}

// Graphite Inspector (Prototype Studio) — sheet drag-handle grip. A single
// short rounded bar, sized by the caller; reads as a "pull me up" affordance
// at the top of the mobile Props bottom-sheet.
export function GripHandleIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <line x1="6" y1="12" x2="18" y2="12" />
    </Svg>
  );
}

// Graphite Inspector — `{}` glyph for the per-field "Edit as JSON" raw escape
// hatch (replaces the old dangling bordered "raw" text box). Lucide "braces".
export function BracesIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M7 4a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2" />
      <path d="M17 4a2 2 0 0 1 2 2v3a2 2 0 0 1 2 2 2 2 0 0 1-2 2v3a2 2 0 0 1-2 2" />
    </Svg>
  );
}

// Prototype Studio — device-orientation toggle. A single rotate-cw arc + arrowhead
// (lucide "rotate-cw"), reading as "rotate this" beside the category picker. The
// prior version overlaid a device-outline rect on the arc and rendered mangled at
// 16px — this is a clean glyph, distinct from RefreshIcon's double-arrow reload.
export function RotateIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </Svg>
  );
}

// Prototype Studio editable annotations — default "Select" tool glyph
// (lucide "mouse-pointer"): a cursor arrow, distinct from the draw tools.
export function MousePointerIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 3 10 20.5l2-7 7-2Z" />
    </Svg>
  );
}

// Prototype Studio editable annotations — Delete tool/floating-chip glyph
// (lucide "trash-2").
export function Trash2Icon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" x2="10" y1="11" y2="17" />
      <line x1="14" x2="14" y1="11" y2="17" />
    </Svg>
  );
}

// Prototype Studio mobile toolbar — collapse/expand affordance (lucide
// "chevron-down"). CSS rotates it 180deg for the expanded/"tap to collapse"
// state rather than shipping a mirrored second icon.
export function ChevronDownIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  );
}

// Composer action bar — shared by the live composer (Composer.tsx) and the
// new-session draft (NewSessionDraft.tsx) via ComposerActionBar.tsx's leaf
// buttons. Kept as raw inline <svg> (not the Svg helper above) since they
// predate it and this move must not change a single rendered pixel.
export function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function ArrowUpIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 19V5M6 11l6-6 6 6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path
        d="M6 11a6 6 0 0 0 12 0M12 17v3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SparkleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {/* 4-point sparkle: vertical diamond + horizontal diamond */}
      <path
        d="M12 2 L13.5 9.5 L21 11 L13.5 12.5 L12 20 L10.5 12.5 L3 11 L10.5 9.5 Z"
        fill="currentColor"
        opacity="0.9"
      />
      <path
        d="M19 2 L19.8 4.2 L22 5 L19.8 5.8 L19 8 L18.2 5.8 L16 5 L18.2 4.2 Z"
        fill="currentColor"
        opacity="0.6"
      />
    </svg>
  );
}

export function BatteryIcon({ level = 1, charging = false, ...p }: IconProps & { level?: number; charging?: boolean }) {
  const w = Math.max(0, Math.min(1, level)) * 12; // inner track is x=4..16 (12 wide)
  return (
    <Svg {...p}>
      <rect width="16" height="10" x="2" y="7" rx="2" />
      <line x1="22" x2="22" y1="11" y2="13" />
      {w > 0 ? <rect x="4" y="9" width={w} height="6" rx="1" fill="currentColor" stroke="none" /> : null}
      {charging ? <path d="M11 9.5 9 12h2l-2 2.5" stroke="var(--bg, #000)" strokeWidth={1.4} /> : null}
    </Svg>
  );
}

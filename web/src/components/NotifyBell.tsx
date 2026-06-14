import type { PushController } from '../hooks/usePushNotifications';

interface NotifyBellProps {
  push: PushController;
}

const LABEL: Record<string, string> = {
  on: 'Notifications on',
  off: 'Enable notifications',
  denied: 'Notifications blocked',
  unsupported: 'Notifications unsupported',
  working: 'Working…',
};

// Compact bell toggle for the resource HUD. Click toggles Web Push on/off; the
// fill reflects current state. Disabled when unsupported or denied.
export function NotifyBell({ push }: NotifyBellProps) {
  const { status, supported, enable, disable } = push;
  const on = status === 'on';
  const disabled =
    !supported || status === 'unsupported' || status === 'working' || status === 'denied';
  const label = LABEL[status] ?? 'Notifications';

  const onClick = () => {
    if (disabled) return;
    if (on) void disable();
    else void enable();
  };

  return (
    <button
      type="button"
      className="notify-bell"
      data-state={status}
      aria-pressed={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-5-1.6-1.6V10a5.4 5.4 0 0 0-4-5.2V4a1.4 1.4 0 0 0-2.8 0v.8A5.4 5.4 0 0 0 6.6 10v5.4L5 17v1h14Z"
          fill={on ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        {status === 'denied' || status === 'unsupported' ? (
          <line x1="4" y1="4" x2="20" y2="20" stroke="currentColor" strokeWidth="1.8" />
        ) : null}
      </svg>
    </button>
  );
}

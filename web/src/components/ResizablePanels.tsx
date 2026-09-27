// Thin adapters over motion-panels (https://motion-panels.letstri.dev) so the
// shell's seams — rail | detail, thread | artifact | raw events — resize by
// drag, keyboard (arrows on the grip) and double-click reset. Every helper
// takes `enabled`; when false it renders exactly today's plain markup, so the
// mobile layout and the `cc:panels=0` kill switch are byte-identical to the
// pre-panels shell. Sizes persist via lib/panelLayout.
import type { ReactNode } from 'react';
import { Group, Panel, Separator, type SizedPanelProps } from 'motion-panels/react';
import { ErrorBoundary } from './ErrorBoundary';
import { ArtifactPanel } from './ArtifactPanel';
import { useArtifactPanel } from './ArtifactContext';
import { usePanelSize } from '../lib/panelLayout';

type Orientation = 'horizontal' | 'vertical';

/** A resizable group when enabled, else a plain div with the same className. */
export function Split({
  enabled,
  className,
  orientation = 'horizontal',
  children,
}: {
  enabled: boolean;
  className: string;
  orientation?: Orientation;
  children: ReactNode;
}) {
  if (!enabled) return <div className={className}>{children}</div>;
  return (
    <Group className={className} orientation={orientation} reorder={false}>
      {children}
    </Group>
  );
}

/** The panel that takes whatever the sized siblings leave. */
export function Fill({
  enabled,
  className,
  children,
}: {
  enabled: boolean;
  className: string;
  children: ReactNode;
}) {
  if (!enabled) return <>{children}</>;
  return <Panel className={className}>{children}</Panel>;
}

type SizedProps = Omit<SizedPanelProps<number>, 'children'> & {
  enabled: boolean;
  /** Where the visible grip sits relative to the panel. */
  grip?: 'before' | 'after' | 'none';
  children: ReactNode;
};

/** A pixel-sized panel with an optional visible grip. */
export function Sized({ enabled, grip = 'before', children, ...panel }: SizedProps) {
  if (!enabled) return <>{children}</>;
  return (
    <>
      {grip === 'before' ? <Separator /> : null}
      <Panel {...panel}>{children}</Panel>
      {grip === 'after' ? <Separator /> : null}
    </>
  );
}

/** The artifact side panel, only mounted (and only resizable) while an artifact is open. */
export function ArtifactSidePanel({ enabled }: { enabled: boolean }) {
  const { activeId } = useArtifactPanel();
  const [width, setWidth] = usePanelSize('artifact', 560);
  const body = (
    <ErrorBoundary label="Artifact panel failed to render">
      <ArtifactPanel />
    </ErrorBoundary>
  );
  if (!enabled || activeId === null) return body;
  return (
    <Sized enabled className="mp-side" size={width} minSize={320} maxSize={1600} onSizeChange={setWidth}>
      {body}
    </Sized>
  );
}

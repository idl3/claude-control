// @vitest-environment jsdom
//
// ExitPlanMode's tool-call renders as a titled, collapsible "Plan" card with
// its `plan` argument run through the transcript's real markdown pipeline
// (MarkdownText.tsx's MD_COMPONENTS + BASE_PLUGINS, via
// TextMessagePartProvider + MarkdownTextPrimitive) — never the raw JSON args
// blob the generic ToolPart renders for every other tool. These tests mount
// ExitPlanPart directly (no full thread runtime needed: TextMessagePartProvider
// stands up its own minimal "part" context) and assert on the rendered DOM.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import { ExitPlanPart } from './MessageParts';
import { ArtifactPanelProvider } from './ArtifactContext';

afterEach(cleanup);

function baseProps(
  args: Record<string, unknown>,
): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolCallId: 'toolu_1',
    toolName: 'ExitPlanMode',
    args,
    argsText: JSON.stringify(args),
    status: { type: 'complete' },
  } as unknown as ToolCallMessagePartProps;
}

describe('ExitPlanPart — ExitPlanMode renders the plan as markdown, not raw JSON', () => {
  it('renders headings, bold text, and list items from the plan markdown', () => {
    const plan = [
      '# Migration Plan',
      '',
      'This touches **two** services.',
      '',
      '- Step one',
      '- Step two',
    ].join('\n');
    render(createElement(ExitPlanPart, baseProps({ plan, planFilePath: '/tmp/plan.md' })));

    expect(screen.getByRole('heading', { level: 1, name: 'Migration Plan' })).toBeTruthy();
    expect(screen.getByText('two').tagName).toBe('STRONG');
    expect(screen.getByText('Step one')).toBeTruthy();
    expect(screen.getByText('Step two')).toBeTruthy();
  });

  it('never dumps the raw JSON args blob into the DOM', () => {
    const plan = '# Plan\n\nSome plan body.';
    render(createElement(ExitPlanPart, baseProps({ plan, planFilePath: '/tmp/plan.md' })));

    expect(document.body.textContent).not.toContain('"plan":');
    expect(document.body.textContent).not.toContain('{"plan"');
  });

  it('shows planFilePath as a caption/footer', () => {
    const plan = '# Plan\n\nBody.';
    render(createElement(ExitPlanPart, baseProps({ plan, planFilePath: '/tmp/plan/foo.md' })));
    expect(screen.getByText('/tmp/plan/foo.md')).toBeTruthy();
  });

  it('omits the caption when planFilePath is absent', () => {
    const plan = '# Plan\n\nBody.';
    render(createElement(ExitPlanPart, baseProps({ plan })));
    expect(screen.queryByText(/\.md$/)).toBeNull();
  });

  it('renders the card open by default (not collapsed)', () => {
    const plan = '# Plan\n\nBody.';
    const { container } = render(
      createElement(ExitPlanPart, baseProps({ plan, planFilePath: '/tmp/plan.md' })),
    );
    const details = container.querySelector('details.block-plan');
    expect(details).toBeTruthy();
    expect(details?.hasAttribute('open')).toBe(true);
  });

  it('keeps the tool-call chrome: an expandable <details> with a summary row', () => {
    const plan = '# Plan\n\nBody.';
    const { container } = render(
      createElement(ExitPlanPart, baseProps({ plan, planFilePath: '/tmp/plan.md' })),
    );
    const summary = container.querySelector('details.block-plan > summary.block-tool-use');
    expect(summary).toBeTruthy();
    expect(within(summary as HTMLElement).getByText('Plan')).toBeTruthy();
  });

  it('falls back to the generic tool row when args carries no usable plan string', () => {
    render(
      createElement(
        ArtifactPanelProvider,
        { sessionId: 'sess-1' },
        createElement(ExitPlanPart, baseProps({})),
      ),
    );
    // The generic ToolPart row renders the bare tool name, no "Plan" card.
    expect(screen.getByText('ExitPlanMode')).toBeTruthy();
    expect(document.querySelector('details.block-plan')).toBeNull();
  });
});

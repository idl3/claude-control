// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { SkillInvocation } from './SkillInvocation';
import { AssistantMessage, UserMessage } from './Messages';
import { convertMessages } from '../lib/convert';
import type { Msg } from '../lib/types';

afterEach(cleanup);

// jsdom has no ResizeObserver; assistant-ui's ThreadPrimitive.Viewport (used by
// both the modal's SkillBodyRenderer and the full-pipeline harness below) needs
// one internally. A no-op stub is enough for these DOM-shape assertions.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const SKILL_TEXT =
  'Base directory for this skill: /home/user/.claude/skills/plan-hard\n' +
  '---\n' +
  'name: plan-hard\n' +
  'description: Deep planning skill\n' +
  '---\n' +
  'Body text describing the skill.';

// ── Chip-level behavior (renders SkillInvocation directly, no transcript) ────

describe('SkillInvocation chip', () => {
  it('renders an SVG icon, never the 🧩 emoji', () => {
    const { container } = render(createElement(SkillInvocation, { text: SKILL_TEXT }));
    expect(container.textContent).not.toContain('🧩');
    const button = screen.getByRole('button', { name: /plan-hard/i });
    expect(button.querySelector('svg')).toBeTruthy();
  });

  it('shows the skill name, "skill" tag, and description tooltip', () => {
    render(createElement(SkillInvocation, { text: SKILL_TEXT }));
    const button = screen.getByRole('button', { name: /plan-hard/i });
    expect(button.getAttribute('title')).toBe('Deep planning skill');
    expect(screen.getByText('plan-hard')).toBeTruthy();
    expect(screen.getByText('skill')).toBeTruthy();
  });

  it('opens the modal on click, with an SVG icon (no emoji) in the header', () => {
    render(createElement(SkillInvocation, { text: SKILL_TEXT }));
    fireEvent.click(screen.getByRole('button', { name: /plan-hard/i }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).not.toContain('🧩');
    expect(dialog.textContent).toContain('Skill: plan-hard');
    expect(dialog.querySelector('.modal-title-skill svg')).toBeTruthy();
  });

  it('opens the modal on Enter/Space (keyboard activation still works)', () => {
    render(createElement(SkillInvocation, { text: SKILL_TEXT }));
    const button = screen.getByRole('button', { name: /plan-hard/i });
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('closes the modal on Escape', () => {
    render(createElement(SkillInvocation, { text: SKILL_TEXT }));
    fireEvent.click(screen.getByRole('button', { name: /plan-hard/i }));
    expect(screen.queryByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// ── Full pipeline: raw transcript Msg[] → convertMessages → rendered row ─────
// Verifies the actual routing decision (convert.ts tags cockpitRole:'system')
// produces the intended DOM: no user bubble, no Copy action bar.

const messageComponents = {
  UserMessage,
  AssistantMessage,
  SystemMessage: AssistantMessage,
} as const;

function TestThread({ messages }: { messages: ThreadMessageLike[] }) {
  const runtime = useExternalStoreRuntime({
    messages,
    isDisabled: true,
    convertMessage: (m: ThreadMessageLike) => m,
    onNew: async () => {},
  });
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(
      ThreadPrimitive.Root,
      null,
      createElement(
        ThreadPrimitive.Viewport,
        null,
        createElement(ThreadPrimitive.Messages, { components: messageComponents }),
      ),
    ),
  );
}

describe('Skill invocation transcript row (full pipeline)', () => {
  it('renders as a system row: no user data-role, no Copy bar, chip carries an SVG icon', () => {
    const msgs: Msg[] = [
      { uuid: 'sk1', role: 'user', blocks: [{ kind: 'text', text: SKILL_TEXT }] },
    ];
    const { container } = render(
      createElement(TestThread, { messages: convertMessages(msgs) }),
    );

    const row = container.querySelector('.msg-row');
    expect(row).toBeTruthy();
    expect(row?.getAttribute('data-role')).toBe('system'); // NOT 'user'
    expect(container.querySelector('.msg-actions')).toBeNull(); // no Copy bar
    expect(container.querySelector('.skill-chip svg')).toBeTruthy(); // icon present
    expect(container.textContent).not.toContain('🧩');
  });

  it('regression control: an ordinary user message keeps its bubble + Copy bar', () => {
    const msgs: Msg[] = [{ uuid: 'u1', role: 'user', blocks: [{ kind: 'text', text: 'hello' }] }];
    const { container } = render(
      createElement(TestThread, { messages: convertMessages(msgs) }),
    );

    const row = container.querySelector('.msg-row');
    expect(row?.getAttribute('data-role')).toBe('user');
    expect(container.querySelector('.msg-actions')).toBeTruthy(); // Copy bar present
  });
});

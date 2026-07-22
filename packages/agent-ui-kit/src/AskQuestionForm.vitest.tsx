import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, renderHook } from '@testing-library/react';
import { AskQuestionForm } from './AskQuestionForm';
import { useHeightFlip } from './heightFlip';
import type { AskQuestion } from './types';

const single: AskQuestion[] = [
  {
    question: 'Pick one',
    header: 'Approach',
    options: [
      { label: 'Alpha', description: 'first' },
      { label: 'Beta' },
    ],
  },
];

const multi: AskQuestion[] = [
  {
    question: 'Pick many',
    multiSelect: true,
    options: [{ label: 'One' }, { label: 'Two' }, { label: 'Three' }],
  },
];

describe('AskQuestionForm — single select', () => {
  it('renders question, options, and the TUI-parity free-text rows by default', () => {
    render(<AskQuestionForm questions={single} onSubmit={() => {}} />);
    expect(screen.getByText('Pick one')).toBeTruthy();
    expect(screen.getByText('Approach')).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Type something')).toBeTruthy();
    expect(screen.getByText('Chat about this')).toBeTruthy();
  });

  it('hides the synthetic rows when freeTextRows is false', () => {
    render(<AskQuestionForm questions={single} onSubmit={() => {}} freeTextRows={false} />);
    expect(screen.queryByText('Type something')).toBeNull();
    expect(screen.queryByText('Chat about this')).toBeNull();
  });

  it('gates submit until every question has a selection, then submits labels', () => {
    const onSubmit = vi.fn();
    render(<AskQuestionForm questions={single} onSubmit={onSubmit} />);
    const submitBtn = screen.getByRole('button', { name: 'Send Answer' });
    expect((submitBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Alpha'));
    expect((submitBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submitBtn);
    expect(onSubmit).toHaveBeenCalledWith([['Alpha']]);
  });

  it('single-select replaces the previous choice', () => {
    const onSubmit = vi.fn();
    render(<AskQuestionForm questions={single} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByText('Alpha'));
    fireEvent.click(screen.getByText('Beta'));
    fireEvent.click(screen.getByRole('button', { name: 'Send Answer' }));
    expect(onSubmit).toHaveBeenCalledWith([['Beta']]);
  });

  it('uses a custom submitLabel', () => {
    render(<AskQuestionForm questions={single} onSubmit={() => {}} submitLabel="Answer" />);
    expect(screen.getByRole('button', { name: 'Answer' })).toBeTruthy();
  });
});

describe('AskQuestionForm — multi select', () => {
  it('toggles labels independently and submits the set', () => {
    const onSubmit = vi.fn();
    render(<AskQuestionForm questions={multi} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByText('One'));
    fireEvent.click(screen.getByText('Two'));
    fireEvent.click(screen.getByText('One')); // toggle off
    fireEvent.click(screen.getByRole('button', { name: 'Send Answer' }));
    expect(onSubmit).toHaveBeenCalledWith([['Two']]);
  });

  it('shows the multi-select hint', () => {
    render(<AskQuestionForm questions={multi} onSubmit={() => {}} />);
    expect(screen.getByText('select one or more')).toBeTruthy();
  });
});

describe('AskQuestionForm — split preview', () => {
  const withPreview: AskQuestion[] = [
    {
      question: 'Layout?',
      options: [
        { label: 'Grid', preview: '[ ][ ]\n[ ][ ]' },
        { label: 'List' },
      ],
    },
  ];

  it('renders the listbox + preview pane and previews the focused option', () => {
    const { container } = render(<AskQuestionForm questions={withPreview} onSubmit={() => {}} />);
    expect(screen.getByRole('listbox')).toBeTruthy();
    // First option is focused by default and has a preview (multiline <pre> —
    // assert on textContent since RTL text matching normalizes whitespace).
    const pre = container.querySelector('.ask-preview-content');
    expect(pre?.textContent).toBe('[ ][ ]\n[ ][ ]');
  });

  it('keyboard: arrow moves focus, space selects', () => {
    const onSubmit = vi.fn();
    render(<AskQuestionForm questions={withPreview} onSubmit={onSubmit} />);
    const rows = screen.getAllByRole('option');
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
    const focusedRow = screen
      .getAllByRole('option')
      .find((r) => r.getAttribute('data-focused') === 'true');
    expect(focusedRow?.textContent).toContain('List');
    fireEvent.keyDown(focusedRow!, { key: ' ' });
    fireEvent.click(screen.getByRole('button', { name: 'Send Answer' }));
    expect(onSubmit).toHaveBeenCalledWith([['List']]);
  });
});

describe('AskQuestionForm — free-text flow', () => {
  it('choosing "Type something" swaps to a textarea; Send emits a text directive', () => {
    const onSubmit = vi.fn();
    render(<AskQuestionForm questions={single} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByText('Type something'));
    const textarea = screen.getByPlaceholderText('Type your reply…');
    fireEvent.change(textarea, { target: { value: 'my custom answer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledWith([{ kind: 'text', text: 'my custom answer' }]);
  });

  it('"Chat about this" emits a chat directive', () => {
    const onSubmit = vi.fn();
    render(<AskQuestionForm questions={single} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByText('Chat about this'));
    fireEvent.change(screen.getByPlaceholderText('Type your reply…'), {
      target: { value: 'lets discuss' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledWith([{ kind: 'chat', text: 'lets discuss' }]);
  });

  it('onFreeTextReply overrides the structured directive path', () => {
    const onSubmit = vi.fn();
    const onFreeTextReply = vi.fn();
    render(
      <AskQuestionForm questions={single} onSubmit={onSubmit} onFreeTextReply={onFreeTextReply} />,
    );
    fireEvent.click(screen.getByText('Type something'));
    fireEvent.change(screen.getByPlaceholderText('Type your reply…'), {
      target: { value: 'plain reply' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onFreeTextReply).toHaveBeenCalledWith('plain reply');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Back returns to the option view', () => {
    render(<AskQuestionForm questions={single} onSubmit={() => {}} />);
    fireEvent.click(screen.getByText('Type something'));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Alpha')).toBeTruthy();
  });
});

describe('useHeightFlip', () => {
  function fakeEl(heights: number[]): HTMLElement {
    let i = 0;
    return {
      get offsetHeight() {
        return heights[Math.min(i++, heights.length - 1)];
      },
      animate: vi.fn(),
    } as unknown as HTMLElement;
  }

  it('animates from the captured height to the new height', () => {
    const el = fakeEl([100, 160]);
    const ref = { current: el };
    const { result, rerender } = renderHook(({ dep }) => useHeightFlip(ref, dep), {
      initialProps: { dep: 0 },
    });
    result.current(); // capture (reads 100)
    rerender({ dep: 1 }); // layout effect reads 160 and animates
    expect((el.animate as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual([
      { height: '100px' },
      { height: '160px' },
    ]);
  });

  it('skips the tween under prefers-reduced-motion', () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes('prefers-reduced-motion'),
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      const el = fakeEl([100, 160]);
      const ref = { current: el };
      const { result, rerender } = renderHook(({ dep }) => useHeightFlip(ref, dep), {
        initialProps: { dep: 0 },
      });
      result.current();
      rerender({ dep: 1 });
      expect(el.animate).not.toHaveBeenCalled();
    } finally {
      window.matchMedia = original;
    }
  });

  it('skips when the height barely changes', () => {
    const el = fakeEl([100, 101]);
    const ref = { current: el };
    const { result, rerender } = renderHook(({ dep }) => useHeightFlip(ref, dep), {
      initialProps: { dep: 0 },
    });
    result.current();
    rerender({ dep: 1 });
    expect(el.animate).not.toHaveBeenCalled();
  });
});

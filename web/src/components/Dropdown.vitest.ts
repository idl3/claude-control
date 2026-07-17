// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { Dropdown, type DropdownOption } from './Dropdown';

afterEach(cleanup);

const OPTIONS: DropdownOption[] = [
  { value: 'default', label: 'Opus 4.8', badge: 'Default' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-fable-5', label: 'Fable 5', disabled: true, title: 'not installed' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
];

function renderDropdown(overrides: Partial<Parameters<typeof Dropdown>[0]> = {}) {
  const onChange = vi.fn();
  const utils = render(createElement(Dropdown, {
    value: 'default',
    options: OPTIONS,
    onChange,
    ariaLabel: 'Model',
    ...overrides,
  }));
  return { onChange, ...utils };
}

describe('Dropdown trigger', () => {
  it('shows the selected option label and is closed by default', () => {
    renderDropdown();
    const trigger = screen.getByLabelText('Model');
    expect(trigger.textContent).toContain('Opus 4.8');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens the listbox on click, and toggles closed on a second click', () => {
    renderDropdown();
    const trigger = screen.getByLabelText('Model');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('listbox')).toBeTruthy();

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does not open when disabled', () => {
    renderDropdown({ disabled: true });
    const trigger = screen.getByLabelText('Model') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('renders exactly one row per option, with the badge and disabled title surfaced', () => {
    renderDropdown();
    fireEvent.click(screen.getByLabelText('Model'));
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(4);
    expect(screen.getByText('Default')).toBeTruthy();
    const fable = screen.getByText('Fable 5').closest('[role="option"]') as HTMLElement;
    expect(fable.getAttribute('aria-disabled')).toBe('true');
    expect(fable.getAttribute('title')).toBe('not installed');
  });
});

describe('Dropdown selection', () => {
  it('clicking an option commits its value and closes the menu', () => {
    const { onChange } = renderDropdown();
    fireEvent.click(screen.getByLabelText('Model'));
    fireEvent.click(screen.getByText('Sonnet 5').closest('[role="option"]') as HTMLElement);
    expect(onChange).toHaveBeenCalledWith('claude-sonnet-5');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('clicking a disabled option does nothing and leaves the menu open', () => {
    const { onChange } = renderDropdown();
    fireEvent.click(screen.getByLabelText('Model'));
    fireEvent.click(screen.getByText('Fable 5').closest('[role="option"]') as HTMLElement);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('closes on outside pointerdown without committing a value', () => {
    const { onChange } = renderDropdown();
    fireEvent.click(screen.getByLabelText('Model'));
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('Dropdown keyboard behavior', () => {
  it('ArrowDown opens the menu when closed, then moves the highlight without committing', () => {
    renderDropdown();
    const trigger = screen.getByLabelText('Model');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    // Highlight starts on the selected row (index 0); one more ArrowDown
    // moves to index 1 (Sonnet 5) — skipping is only for disabled rows.
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const sonnet = screen.getByText('Sonnet 5').closest('[role="option"]') as HTMLElement;
    expect(sonnet.getAttribute('id')).toBe(trigger.getAttribute('aria-activedescendant'));
  });

  it('ArrowDown skips a disabled row when moving the highlight', () => {
    renderDropdown();
    const trigger = screen.getByLabelText('Model');
    fireEvent.click(trigger);
    // index 0 (default/Opus) -> 1 (Sonnet 5) -> would land on 2 (Fable 5,
    // disabled) -> skips to 3 (Haiku 4.5).
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const haiku = screen.getByText('Haiku 4.5').closest('[role="option"]') as HTMLElement;
    expect(haiku.getAttribute('id')).toBe(trigger.getAttribute('aria-activedescendant'));
  });

  it('Enter commits the highlighted option', () => {
    const { onChange } = renderDropdown();
    const trigger = screen.getByLabelText('Model');
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // highlight -> Sonnet 5
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('claude-sonnet-5');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Escape closes the menu without committing', () => {
    const { onChange } = renderDropdown();
    const trigger = screen.getByLabelText('Model');
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { ErrorBoundary } from './ErrorBoundary';

afterEach(cleanup);

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(createElement(ErrorBoundary, { children: createElement('div', null, 'healthy') }));
    expect(screen.getByText('healthy')).toBeTruthy();
  });

  it('catches a render throw and surfaces the error message + label + Retry', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Boom = () => {
      throw new Error('kaboom in transcript');
    };
    render(createElement(ErrorBoundary, { label: 'Transcript failed', children: createElement(Boom) }));
    expect(screen.getByText('Transcript failed')).toBeTruthy(); // label shown
    expect(screen.getByText('kaboom in transcript')).toBeTruthy(); // the caught error is SHOWN
    expect(screen.getByText('Retry')).toBeTruthy();
    expect(screen.getByText('Stack trace')).toBeTruthy(); // details available
    spy.mockRestore();
  });

  it('Retry re-renders the subtree without a reload (resume in place)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;
    const Flaky = () => {
      if (shouldThrow) throw new Error('boom once');
      return createElement('div', null, 'recovered pane');
    };
    render(createElement(ErrorBoundary, { children: createElement(Flaky) }));
    expect(screen.getByText('boom once')).toBeTruthy(); // errored first

    shouldThrow = false; // the underlying cause cleared
    fireEvent.click(screen.getByText('Retry'));
    expect(screen.getByText('recovered pane')).toBeTruthy(); // subtree re-rendered, no reload
    spy.mockRestore();
  });
});

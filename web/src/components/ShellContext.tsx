import { createContext, useContext } from 'react';

/**
 * Shell ops for the composer's terminal mode (>_), provided by App from the
 * cockpit store. Lets the Composer (rendered inside assistant-ui's Thread, and
 * standalone in the live-pane branch) reach the shell pane without prop-drilling.
 */
export interface ShellApi {
  /** Latest capture of the dedicated shell pane. */
  output: string | null;
  /** Run a command line in the shell pane. */
  run: (line: string) => boolean;
  /** Send an allow-listed control key (e.g. C-c). */
  key: (k: string) => boolean;
  /** Poll the shell pane capture. */
  poll: (lines?: number) => boolean;
  /** Drop the cached capture. */
  clear: () => void;
}

const NOOP: ShellApi = {
  output: null,
  run: () => false,
  key: () => false,
  poll: () => false,
  clear: () => {},
};

export const ShellContext = createContext<ShellApi>(NOOP);
export const useShell = (): ShellApi => useContext(ShellContext);

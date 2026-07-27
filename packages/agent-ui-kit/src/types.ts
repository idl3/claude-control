/**
 * Kit-owned neutral types. Hosts map their own shapes onto these structurally:
 * claude-control's `PendingQuestion`/`PendingOption` are identical field-for-field;
 * the olam SPA maps `@olam/question-inbox-core`'s `InboxQuestion` (label/description
 * straight across; `value`/`destructive` stay host-side in a label→option map).
 */

export interface AskOption {
  label: string;
  description?: string;
  /** Multi-line text (ASCII diagram, code, arch mockup) shown monospace in the preview pane. */
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskOption[];
}

/**
 * One question's answer. Either the chosen option labels, OR a free-text/chat
 * directive carrying the literal text the user typed into the free-text row.
 */
export type AskAnswer = string[] | { kind: 'text' | 'chat'; text: string };

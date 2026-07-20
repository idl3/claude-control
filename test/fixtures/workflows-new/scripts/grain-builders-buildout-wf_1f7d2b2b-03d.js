export const meta = {
  name: 'grain-builders-buildout',
  description: 'Build the remaining Grain Builders pieces in isolated worktrees, tested + committed, not deployed.',
  phases: [
    { title: 'Build', detail: 'one agent per stream, own worktree/branch, implement+test+commit' },
    { title: 'Verify', detail: 'adversarial review of each stream diff (security + correctness)' },
  ],
}
// (STREAMS + pipeline body elided in the fixture — the reader never executes this.)

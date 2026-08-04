# Design — Artifacts system

Plan: `~/.claude/plans/artifacts-system.md` (pass 2, feature, autonomous, confidence 93).

Rubric stubs imported from the plan's `## Risk candidates` (T# threats / P# performance / S# simplicity). `/100x:execute` CP3 audits against these.

## Threat model
- **T1** [known]: presentation artifacts are self-contained HTML in the `allow-scripts`-only sandbox (same containment as prototypes). Mitigation: reuse the existing `sandbox` attribute verbatim; skill emits self-contained HTML, no external fetch; NEVER add `allow-same-origin`.
- **T2** [assumed]: a Markdown/HTML artifact could carry unsafe content if source data were untrusted. Mitigation: author is the agent/operator (no new trust boundary); same sandbox contains it.

## Performance findings
- **P1** [assumed]: React + charting bundles inflate the self-contained HTML. Target: keep artifact HTML within a few hundred KB where feasible; prefer lightweight charting; measure + log emitted size.
- **P2** [assumed]: gallery derivation parsing the transcript per session. Target: derive from the already-tailed transcript / bounded embed-tag scan; no new full-file reads.

## Simplicity findings
- **S1** [known]: NO persistent artifact DB/registry in v1 — derive the gallery from transcript embed tags.
- **S2** [assumed]: NO cc-bridge on presentation artifacts — self-contained; studio degrades on no-manifest.
- **S3** [assumed]: ONE skill with build lanes, not three skills.

## Seam
The `artifactKind`-tagged artifact riding the existing media-apps + `<embedded-app>` plumbing (named distinctly from the SPA `kind:'app'`), gallery derived from transcript embed tags (`embeds.ts:36` `TAG_RE`), studio kind-gating via manifest null-degrade (`appVersion.ts:131-139`).

## Unwind cost
Skill = self-contained global dir (delete). `artifactKind` manifest field + gallery = additive per-phase clean-revert. Only forward-only bit: static artifact files already published to the media root (harmless).

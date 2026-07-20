# Changelog

## Unreleased

- Post-implementation hardening: extension-owned XState 5 recording
  coordinator, immediate capture stop boundary, stale-operation guards,
  capture-size privacy enforcement, stronger replay/artifact validation,
  explicit Monaco EOL projection, bounded playback caches, TypeScript 7.0.2,
  and lifecycle/seek/failure regression coverage.
- Phase 9: release candidate — dev/diagnostic commands excluded from
  production builds, ADR 0003 (container), committed reproduction
  fixtures + generator, VSIX content audit (benchmark bundle excluded),
  clean-profile install smoke test.
- Phase 7: activation-time recovery (finalize/inspect/discard interrupted
  sessions, idempotent), diagnostics output channel, playback.defaultSpeed
  and diagnostics.level settings, failure-injection and 250k-event scale
  tests.
- Phase 6: `.nextrecording` v1 artifact (streaming ZIP, integrity hashes,
  fail-closed reader), recording library with Open/Export, Monaco-based
  read-only player (play/pause/seek/speed, reconstructed group layout,
  unsupported-surface placeholders).
- Phase 5: native recording lifecycle — start/stop commands, status-bar
  indicator, privacy disclosure, durable journal + checkpoints, headless
  replay validation, capture exclusions configuration.
- Phase 4: recoverable journal, atomic session metadata, checkpoint store,
  seek index, v1 runtime schemas.
- Phase 3: renderer evidence gate — Monaco selected over CodeMirror 6
  (ADR 0002).
- Phase 2: multi-document capture model (document shadows, surfaces,
  topology reconciliation).
- Phase 1: isolated extension scaffold — placeholder commands, placeholder
  read-only custom editor for `.nextrecording`, build/test/packaging
  pipeline, boundary verification.

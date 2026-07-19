# Changelog

## Unreleased

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

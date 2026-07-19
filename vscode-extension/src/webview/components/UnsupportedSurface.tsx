// Explicit placeholder for surfaces the recorder does not capture
// (plan §8.9): honest fidelity beats silent emptiness.
export function UnsupportedSurface(props: { kind: string; label: string }) {
  return (
    <div className="unsupported-surface">
      <div className="unsupported-kind">{props.kind}</div>
      <div className="unsupported-label">{props.label}</div>
      <div className="unsupported-note">
        This surface type was visible during recording but its contents are not captured.
      </div>
    </div>
  );
}

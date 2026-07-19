export function ErrorView(props: { message: string }) {
  return (
    <div className="error-view">
      <h2>Cannot open recording</h2>
      <p>{props.message}</p>
      <p className="error-hint">
        The file may be corrupted, truncated, produced by a newer format version, or not a Next
        Recording artifact.
      </p>
    </div>
  );
}

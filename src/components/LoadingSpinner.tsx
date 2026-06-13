export default function LoadingSpinner() {
  return (
    <div
      aria-label="Loading"
      className="mx-auto size-12 animate-spin rounded-full border-b-2 border-blue-400"
      role="status"
    />
  );
}

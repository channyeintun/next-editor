export default function LoadingSpinner({ className = "" }) {
  return (
    <div
      aria-label="Loading"
      className={`mx-auto size-12 animate-spin rounded-full border-b-2 border-blue-400 ${className}`}
      role="status"
    />
  );
}

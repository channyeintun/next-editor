interface LoadingSpinnerProps {
  className?: string;
  /**
   * What a screen reader announces for the spinner, as text inside its status
   * region (a live region announces its contents, not its aria-label). `null`
   * makes the spinner purely decorative, for a caller that shows its own loading
   * text and announces it through a live region it keeps mounted: a status region
   * that is inserted already filled is often not announced at all.
   */
  label?: string | null;
}

export default function LoadingSpinner({ className = "", label = "Loading" }: LoadingSpinnerProps) {
  const spinnerClassName = `mx-auto size-12 animate-spin rounded-full border-b-2 border-blue-400 ${className}`;
  if (label === null) return <div aria-hidden="true" className={spinnerClassName} />;
  return (
    <div className={spinnerClassName} role="status">
      <span className="sr-only">{label}</span>
    </div>
  );
}

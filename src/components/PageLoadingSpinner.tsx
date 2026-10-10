import LoadingSpinner from "./LoadingSpinner";

/**
 * A page still loading that has no skeleton of its own: the loading spinner on
 * the app's dark page. Eager-bundle-safe: the router's HydrateFallback renders
 * it.
 */
export default function PageLoadingSpinner() {
  return (
    <div className="h-dvh flex items-center justify-center bg-[#11141c] text-white">
      <LoadingSpinner />
    </div>
  );
}

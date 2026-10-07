import { useGitHubStars } from "../hooks/useGitHubStars";
import { analytics } from "../utils/analytics";
import LandingPage, { type LandingAnalyticsEvent } from "./LandingPage";

/** Adds browser-only data and analytics to the server-renderable landing view. */
export default function LandingPageRoute() {
  const starCount = useGitHubStars();

  const capture = (event: LandingAnalyticsEvent, properties?: Record<string, string>) => {
    analytics.capture(event, properties);
  };

  return <LandingPage onAnalyticsEvent={capture} starCount={starCount} />;
}

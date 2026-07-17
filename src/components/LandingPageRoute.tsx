import { usePostHog } from "@posthog/react";
import { useGitHubStars } from "../hooks/useGitHubStars";
import LandingPage, { type LandingAnalyticsEvent } from "./LandingPage";

/** Adds browser-only data and analytics to the server-renderable landing view. */
export default function LandingPageRoute() {
  const posthog = usePostHog();
  const starCount = useGitHubStars();

  const capture = (event: LandingAnalyticsEvent, properties?: Record<string, string>) => {
    posthog?.capture(event, properties);
  };

  return <LandingPage onAnalyticsEvent={capture} starCount={starCount} />;
}

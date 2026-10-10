import { Suspense } from "react";
import { Navigate, useParams } from "react-router";
import LessonPageSkeleton from "@app/components/LessonPageSkeleton";
import PageLoadingSpinner from "@app/components/PageLoadingSpinner";
import { useDocumentTitle } from "@app/hooks/useDocumentTitle";
import { lazyWithRecovery } from "@app/routeRecovery";
import { useLesson } from "../hooks/useLessons";
import { lessonPageTitle } from "../lib/lessonPageTitle";
import {
  isAuthorProfileSlug,
  loadAuthorProfilePage,
  loadLessonDetailRoute,
} from "../lessonRouteLoaders";

// Both views sit behind their own chunks, so this route module stays small.
// React Router awaits a route's lazy() before it commits a navigation, and the
// app shows no pending state, so a card clicked before the lesson player had
// loaded would otherwise leave the gallery frozen on screen while it
// downloads. Now the click switches at once and the view's own loading state
// covers the wait. The route's loader starts the right view's chunk alongside
// this module (prefetchLearnSlugView), and a stale chunk gets the same one-shot
// reload as the route's own.
const LessonDetailRoute = lazyWithRecovery(loadLessonDetailRoute, "LessonDetailRoute");
const AuthorProfilePage = lazyWithRecovery(loadAuthorProfilePage, "AuthorProfilePage");

// Single route for /learn/:slug. React Router's own path compiler only turns
// ":name" into a dynamic param when it's immediately preceded by "/" (see
// compilePath in react-router/dist/.../lib/router/utils.js) — a path like
// "/learn/@:username" therefore never becomes a param at the router level,
// it matches only the literal string "@:username". Disambiguating a profile
// URL (/learn/@handle) from a lesson slug (/learn/some-title-abc12345) has
// to happen here instead, by checking the "@" prefix on the single :slug
// param (isAuthorProfileSlug).
export default function LearnSlugRoute() {
  const { slug } = useParams();
  if (isAuthorProfileSlug(slug)) {
    const username = slug.slice(1);
    // "/learn/@" (empty handle) — bounce to the gallery rather than handing
    // AuthorProfilePage an empty username, which would leave it stuck on a
    // permanent loading state (its query hook has `enabled: !!username`).
    if (!username) {
      return <Navigate to="/learn" replace />;
    }
    return (
      <Suspense fallback={<AuthorProfileFallback username={username} />}>
        <AuthorProfilePage username={username} />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={<LessonDetailFallback slug={slug} />}>
      <LessonDetailRoute />
    </Suspense>
  );
}

// Stands in for LessonDetailRoute while its chunk downloads: the same skeleton
// and the same page title it will show (the lesson is usually cached already,
// primed by the gallery or dehydrated by the edge render), so a click from the
// gallery retitles the page at once. Its lookup is the one LessonDetailRoute
// then reads, so an uncached lesson is fetched alongside the chunk.
function LessonDetailFallback({ slug }: { slug: string | undefined }) {
  const lessonQuery = useLesson(slug);
  useDocumentTitle(lessonPageTitle(slug, lessonQuery));
  return <LessonPageSkeleton slug={slug} />;
}

// Stands in for AuthorProfilePage while its chunk downloads, titled as that
// page titles itself until it knows who is viewing.
function AuthorProfileFallback({ username }: { username: string }) {
  useDocumentTitle(`@${username} | Next Editor`);
  return <PageLoadingSpinner />;
}

import { useParams } from "react-router";
import AuthorProfilePage from "../AuthorProfilePage";
import LessonDetailRoute from "./LessonDetailRoute";

// Single route for /learn/:slug. React Router's own path compiler only turns
// ":name" into a dynamic param when it's immediately preceded by "/" (see
// compilePath in react-router/dist/.../lib/router/utils.js) — a path like
// "/learn/@:username" therefore never becomes a param at the router level,
// it matches only the literal string "@:username". Disambiguating a profile
// URL (/learn/@handle) from a lesson slug (/learn/some-title-abc12345) has
// to happen here instead, by checking the "@" prefix on the single :slug
// param — safe because lesson slugs (slugify() in
// infra/worker/routes/lessons.ts) never start with "@".
export default function LearnSlugRoute() {
  const { slug } = useParams();
  if (slug?.startsWith("@")) {
    return <AuthorProfilePage username={slug.slice(1)} />;
  }
  return <LessonDetailRoute />;
}

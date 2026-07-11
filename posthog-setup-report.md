<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog into next-editor, a React Router v8 + Vite SPA. PostHog is initialized in `src/main.tsx` with `PostHogProvider` wrapping the app. Twelve events are instrumented across six files covering the full user journey — from landing page CTAs through lesson creation, upload, and publish. User identification runs via `AuthMenu.tsx` whenever the Google OAuth session resolves (on login and on every page refresh while signed in). Error tracking is wired into the route error boundary in `src/router.tsx`.

| Event                    | Description                                                               | File                                        |
| ------------------------ | ------------------------------------------------------------------------- | ------------------------------------------- |
| `start_creating_clicked` | User clicks the "Start creating" CTA from the landing page hero.          | `src/components/LandingPage.tsx`            |
| `watch_lessons_clicked`  | User clicks the "Watch lessons" button from the landing page hero.        | `src/components/LandingPage.tsx`            |
| `github_star_clicked`    | User clicks the "Star on GitHub" link from the landing page.              | `src/components/LandingPage.tsx`            |
| `sign_in_initiated`      | User initiates Google sign-in from the upload modal to share a recording. | `infra/client/upload/UploadLessonModal.tsx` |
| `lesson_uploaded`        | User successfully uploads a lesson recording.                             | `infra/client/upload/UploadLessonModal.tsx` |
| `lesson_published`       | User publishes a lesson, making it publicly visible.                      | `infra/client/upload/UploadLessonModal.tsx` |
| `signed_out`             | User signs out of their account.                                          | `infra/client/auth/AuthMenu.tsx`            |
| `recording_imported`     | User imports a .ne recording file into the editor.                        | `src/components/EditorHeader.tsx`           |
| `recording_exported`     | User exports the current recording as a .ne file.                         | `src/components/EditorHeader.tsx`           |
| `workspace_downloaded`   | User downloads the current workspace project as a zip archive.            | `src/components/EditorHeader.tsx`           |
| `lesson_type_selected`   | User switches the active lesson framework/template type.                  | `src/components/EditorHeader.tsx`           |
| `project_zip_imported`   | User imports a project zip archive into the workspace.                    | `src/components/EditorHeader.tsx`           |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- [Analytics basics (wizard) — Dashboard](https://us.posthog.com/project/508050/dashboard/1833737)
- [Lesson upload conversion funnel (wizard)](https://us.posthog.com/project/508050/insights/cfyIcfgJ)
- [Lessons uploaded over time (wizard)](https://us.posthog.com/project/508050/insights/w0y7rQb8)
- [Lesson type selections breakdown (wizard)](https://us.posthog.com/project/508050/insights/K1Ju29Z2)
- [Landing page CTAs (wizard)](https://us.posthog.com/project/508050/insights/GGf0T7Tv)
- [Recording import and export activity (wizard)](https://us.posthog.com/project/508050/insights/qYAfkAgo)

## Verify before merging

- [ ] Run a full production build (`bun run build`) and fix any lint or type errors introduced by the generated code.
- [ ] Run the test suite — call sites that were rewritten or instrumented may need updated mocks or fixtures.
- [ ] Add `VITE_PUBLIC_POSTHOG_PROJECT_TOKEN` and `VITE_PUBLIC_POSTHOG_HOST` to `.env.example` and any CI/bootstrap scripts so collaborators know what to set.
- [ ] Wire source-map upload (`posthog-cli sourcemap` or your bundler's upload step) into CI so production stack traces de-minify.
- [ ] Confirm the returning-visitor path also calls `identify` — the current `useEffect` in `AuthMenu.tsx` fires whenever the auth query resolves (including page refresh), so returning sessions are covered. Verify this in a real sign-in round-trip.

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>

# React crash course — course guide

A 13-lesson React course narrated in Burmese. It goes from a first component to React 19.3 (React
only: no router, no state library). React terms stay in English and the code is shown as written.
Every lesson is a studio LessonScript in `src/studio/scripts/` (locale `my-MM`) that runs a real app
in the WebContainer, with a live preview, while the narration explains why each piece exists. All
lessons share one small app, a Yangon noodle shop's menu and orders, so learners meet the same names
and data from lesson to lesson.

The Burmese narration has **not** been reviewed by Chan yet. Lessons 1–12 were first drafted with
Fable, then edited and reviewed by Opus; lesson 13 was written by Opus. Every YAML's narration is
identical to the voice script it was built from. If the wording changes, change it in the YAML and
keep the marks (`[[mark:…]]`) in place and order.

## Lessons

Lengths are estimates at Burmese VoxCPM2 pace (~14 characters per second); the real voice decides
the final length.

| #   | Script                                           | Title                                                     | Runtime | ≈ min |
| --- | ------------------------------------------------ | --------------------------------------------------------- | ------- | ----- |
| 1   | `react-crash-course-01-components-jsx`           | React crash course 1: Component နဲ့ JSX                     | Vite 5  | 11    |
| 2   | `react-crash-course-02-props-lists`              | React crash course 2: Props၊ list နဲ့ condition             | Vite 5  | 11    |
| 3   | `react-crash-course-03-state-events`             | React crash course 3: State နဲ့ event                       | Vite 5  | 11    |
| 4   | `react-crash-course-04-forms-shared-state`       | React crash course 4: Form နဲ့ shared state                 | Vite 5  | 11    |
| 5   | `react-crash-course-05-reducer-context`          | React crash course 5: Reducer နဲ့ context                   | Vite 5  | 10    |
| 6   | `react-crash-course-06-refs-dom`                 | React crash course 6: Ref နဲ့ DOM                           | Vite 5  | 11    |
| 7   | `react-crash-course-07-effects-custom-hooks`     | React crash course 7: Effect နဲ့ custom hook                | Vite 5  | 12    |
| 8   | `react-crash-course-08-performance-transitions`  | React crash course 8: Performance နဲ့ transition            | Vite 5  | 10    |
| 9   | `react-crash-course-09-suspense-errors`          | React crash course 9: Suspense၊ use နဲ့ error boundary      | Vite 5  | 12    |
| 10  | `react-crash-course-10-actions-forms`            | React crash course 10: Action နဲ့ form hook တွေ              | Vite 5  | 12    |
| 11  | `react-crash-course-11-activity-view-transition` | React crash course 11: Activity နဲ့ ViewTransition          | Vite 5  | 11    |
| 12  | `react-crash-course-12-server-components`        | React crash course 12: Server Component နဲ့ Server Function | RSC     | 10    |
| 13  | `react-crash-course-13-react-19-3-recap`         | React crash course 13: React 19.3 နဲ့ အနှစ်ချုပ်                | RSC     | 10    |

Thumbnails (1280×720) are in [react-crash-course-thumbnails/](./react-crash-course-thumbnails/).
They are rendered from [react-crash-course-thumbnail.html](./react-crash-course-thumbnail.html) with
`bun docs/react-crash-course-thumbnails/render.ts`. The template is editable in Chrome like the Rust
from zero one, and its mascot is an original drawing (React has no free mascot, and its logo is
Meta's trademark).

## The two workspaces

- **Vite 5 (lessons 1–11):** react and react-dom 19.3.1 with vite 5.4.21, and JSX through esbuild's
  automatic runtime, so there is no React plugin and no Babel. `optimizeDeps.include` pre-bundles
  every React entry, so Vite never reloads the preview halfway through a lesson to optimize a new
  dependency. Without a React plugin, every JS edit fully reloads the preview, and the narration
  says so.
- **React Server Components (lessons 12–13):** React's own Vite integration,
  `@vitejs/plugin-rsc` 0.5.37 on vite 7.3.7, with no framework and no router. Vite 5 cannot run it,
  and Vite 8's Rolldown is slow inside the WebContainer. The `src/framework/` entries (rsc, ssr,
  client) are pinned and explained once. `webcontainer-fix.js` works around two bugs in the
  WebContainer's Node.js: a streaming `TextDecoder` that splits Burmese letters, and a server clock
  about 200 ms behind the browser that makes React's dev timing throw. On real Node it does nothing.

Both workspaces install with plain `pnpm install` and no lockfile. A cold boot plus install measured
36–43 s against `runtime.start`'s 45 s window. That is the same for both workspaces and the same for
the older WebContainer lessons. A slow network can still miss it; if a render fails at
`runtime.start`, render again (the second install is warm).

## Rendering a lesson

1. Choose **မြန်မာ · VoxCPM2 (Modal)** with your narrator reference in the voice row. The lessons pin
   the English Pocket profile, and Studio swaps in the Burmese provider at render time.
2. Open `/studio?plan=<script>`, keep the tab in front, and press **Start render**.
3. The app installs and runs live in the WebContainer, so the render needs network access for npm.
   Every preview interaction is checked (`expect.preview`), and any console error in the preview
   fails the render.
4. When every check passes, watch the replay, then **Create draft…**, publish, and add the lesson to
   the course playlist in the order above.

## What to look at while reviewing

- **The Burmese.** It follows the approved style of `next-editor-intro-mm` (connected, spoken,
  polite register; no code read aloud), but Chan has not read it yet. The shared glossary of spoken
  terms was applied across all lessons; it is not in the repo.
- **Length.** Every lesson runs 10–12 minutes, longer than the 6–9 planned, because the reviews
  asked for first-use explanations and reasons. The review notes name one clean cut per lesson if
  the course should be shorter.
- **Animations on replay.** The preview is replayed as DOM, so `<ViewTransition>` animations
  (lesson 11) are visible in the live render but not in the published replay. The narration says
  so and tells learners to run the code in their own browser to see the animation.
- **Thumbnail titles.** After a bold Latin word, the Burmese `၊` in "Props၊ list" and "Suspense၊ use"
  can look like an "ı" on a small card.

## Maintaining the course

- The authoring contract is [lesson-script-authoring.md](./lesson-script-authoring.md); the voice
  rules are [studio-persona.md](./studio-persona.md).
- Edits are insert-only, and the app is live while code is typed. So a new component is typed
  keystroke by keystroke into a pinned empty file the app does not import yet. Then it is wired in
  with atomic `block` inserts: the import line first, then the usage. Typing half-written JSX into an
  imported module shows Vite's error overlay in the recording and fails the render.
- Before a lesson was committed, it was replayed locally against real Vite and headless Chrome
  (anchors, every intermediate typing state, preview clicks and assertions, zero console errors). It
  was also scheduled at three Burmese speaking rates. Those two checkers are not in the repo; the
  studio render remains the gate that counts.
- Lesson 13 pins lesson 12's final `actions.js`, `OrderForm.jsx`, `AddButton.jsx` and `db.js`. If
  lesson 12's code changes, copy those files over again.
- Lessons point back to earlier lessons and close by naming the next one, so moving or removing a
  lesson means updating its neighbours.

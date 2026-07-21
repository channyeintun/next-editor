import Breadcrumb from "../components/Breadcrumb";
import Editor from "../components/Editor";
import StudioController from "./StudioController";

/**
 * The lesson production studio (docs/agent-lesson-production.md): the full
 * editor surface plus the render console overlay. Users pick a checked-in
 * LessonScript or import a YAML, and the lesson renders entirely client-side
 * — synthesis, performance, recording, and QA all happen in this page.
 * Creating a draft afterwards uses the standard authenticated upload flow.
 *
 * Query params: `plan` (lesson slug), `runtime` (`fixture` | `live`),
 * `autostart=1` to render on load (subject to the browser's audio autoplay
 * policy — start via the button when in doubt).
 */
export default function StudioRoute() {
  return (
    <Editor
      breadcrumb={<Breadcrumb title="Studio" />}
      overlay={<StudioController />}
      runtimeAutoStart={false}
    />
  );
}

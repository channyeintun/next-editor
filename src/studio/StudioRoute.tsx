import Breadcrumb from "../components/Breadcrumb";
import Editor from "../components/Editor";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import StudioController from "./StudioController";

/**
 * The lesson production studio (docs/agent-lesson-production.md): the full
 * editor surface plus the render console overlay. Users pick a checked-in
 * LessonScript or import a YAML, and the lesson renders entirely client-side
 * — synthesis, performance, recording, and QA all happen in this page.
 * Creating a draft afterwards uses the standard authenticated upload flow.
 *
 * Query params: `plan` (lesson slug), `runtime` (`fixture` | `live`),
 * `autostart=1` to render on load — honoured only in an automation-controlled
 * browser (scripts/studio-render.ts); everyone else starts via the button.
 *
 * The performed workspace is never saved: every tab shares one persisted
 * project, and a studio tab's Ctrl-S would otherwise overwrite it.
 */
export default function StudioRoute() {
  useDocumentTitle("Studio | Next Editor");

  return (
    <Editor
      breadcrumb={<Breadcrumb title="Studio" />}
      overlay={<StudioController />}
      runtimeAutoStart={false}
      recordingDrafts={false}
      persistWorkspace={false}
    />
  );
}

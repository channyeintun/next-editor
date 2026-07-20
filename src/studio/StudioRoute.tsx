import Breadcrumb from "../components/Breadcrumb";
import Editor from "../components/Editor";
import StudioController from "./StudioController";

/**
 * Dev-only production-studio route (docs/agent-lesson-production.md §12 M0):
 * the full editor surface plus the studio render console overlay. Registered
 * in the router only for dev builds; there is nothing to gate at runtime.
 *
 * Query params: `plan` (slug from src/studio/plans), `runtime` (`fixture` |
 * `live`), `autostart=1` to render on load (subject to the browser's audio
 * autoplay policy — start via the button when in doubt).
 */
export default function StudioRoute() {
  return <Editor breadcrumb={<Breadcrumb title="Studio" />} overlay={<StudioController />} />;
}

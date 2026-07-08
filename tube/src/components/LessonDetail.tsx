import Editor from "@app/components/Editor";
import type { Lesson } from "../types";
import Breadcrumb from "./Breadcrumb";

export default function LessonDetail({ lesson }: { lesson: Lesson }) {
  return (
    <Editor
      readOnly
      recordingUrl={`/${lesson.ne}`}
      breadcrumb={<Breadcrumb title={lesson.title} />}
    />
  );
}

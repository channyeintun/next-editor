import { Suspense } from "react";
import { lazyWithRecovery } from "@app/routeRecovery";
import type { UploadLessonModalProps } from "./UploadLessonModal";

// The modal only opens once an author has recorded and shares (or returns from
// signing in to do so), so it stays out of the chunk every lesson viewer
// downloads. Nothing renders until its chunk lands; the modal then mounts and
// takes focus exactly as it would have.
const loadUploadLessonModal = () => import("./UploadLessonModal");
const UploadLessonModalChunk = lazyWithRecovery(loadUploadLessonModal, "UploadLessonModal");

/**
 * Starts fetching the modal's chunk ahead of the first share, so it is in hand
 * when a take ends. A failed fetch is left to the modal's own load to report.
 */
export function preloadUploadLessonModal(): void {
  loadUploadLessonModal().catch(() => {});
}

export default function UploadLessonModal(props: UploadLessonModalProps) {
  return (
    <Suspense fallback={null}>
      <UploadLessonModalChunk {...props} />
    </Suspense>
  );
}

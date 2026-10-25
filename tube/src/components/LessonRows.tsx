import { useLayoutEffect, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { observeFirstRowThumbnails } from "../lib/firstRowThumbnails";
import type { Lesson } from "../types";
import LessonCard from "./LessonCard";
import LessonCardSkeleton from "@app/components/LessonCardSkeleton";

/**
 * The gallery's rows, virtualized against the page scroll, so the navbar and
 * footer stay in normal flow (no nested scrollbar) and only on-screen cards are
 * mounted. A null slot is a skeleton for a card still being fetched.
 *
 * Not compiled: `useWindowVirtualizer()` returns one mutable instance whose
 * methods read the scroll position, which React Compiler cannot memoize safely
 * (its Babel build lists only `useVirtualizer()` as incompatible; oxlint flags
 * both). Keeping the virtualizer here leaves LessonGrid compiled, and a scroll
 * re-renders these rows rather than the search bar above them.
 */
export default function LessonRows({
  rows,
  columns,
}: {
  rows: (Lesson | null)[][];
  columns: number;
}) {
  "use no memo";
  // scrollMargin offsets the virtual list by its distance from the document top.
  // It is measured whenever the list's node appears (a callback ref) and on resize.
  const [listNode, setListNode] = useState<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    if (!listNode) return;
    const update = () => setScrollMargin(listNode.offsetTop);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [listNode]);

  // oxlint-disable-next-line react/incompatible-library -- opted out above with "use no memo"
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => 320,
    overscan: 3,
    scrollMargin,
  });

  return (
    <div ref={setListNode}>
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((vi) => (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${vi.start - scrollMargin}px)` }}
          >
            <div
              ref={vi.index === 0 ? observeFirstRowThumbnails : undefined}
              className="grid gap-5 pb-5"
              style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            >
              {rows[vi.index].map((lesson, idx) =>
                lesson ? (
                  <LessonCard key={lesson.slug} lesson={lesson} priority={vi.index === 0} />
                ) : (
                  <LessonCardSkeleton key={`skel-${idx}`} />
                ),
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// The contract between the edge render (infra/worker/ssr/lessonDetail.ts),
// which dehydrates the React Query cache into the document, and the browser
// (src/queryClient.ts, tube/src/hooks/useLessons.ts), which hydrates it. If
// either side drifted, hydration would silently stop and every direct
// /learn/:slug visit would refetch, so both import it from here.

/** Where the dehydrated React Query cache is parked for the client to pick up. */
export const SERVER_QUERY_STATE_ELEMENT_ID = "__NE_QUERY_STATE__";

/** The lesson detail query's key: useLesson() runs it, the edge render pre-fills it.
 *  The client's other lesson and playlist keys sit beside it as lessonKeys.detail
 *  in infra/lessons/queryKeys.ts. */
export function lessonDetailQueryKey(slug: string | undefined) {
  return ["lessons", "detail", slug] as const;
}

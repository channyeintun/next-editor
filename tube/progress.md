# NextEditor Tube — Progress

## Tasks

- [x] 1. Scaffold Vite + React + TS app in `tube/` with Tailwind v4 (bun)
- [x] 2. Add `src/types.ts` (Lesson) and `src/lib/lessons.ts` (typed fetch)
- [x] 3. Add `src/lib/links.ts` (buildPlayUrl, resolveThumb)
- [x] 4. Build LessonCard, LessonGrid, Header, Footer components
- [x] 5. Wire App.tsx (Header + Grid + Footer, loading/empty/error states)
- [x] 6. Seed public/lessons.json with introduction lesson + copy .ne/.vtt files
- [x] 7. Add .env.example and vercel.json with CORS headers
- [x] 8. Final build verification + lint

## Post-v1 architecture changes

- [x] 9. Play in embedded iframe instead of navigating away (LessonPlayer overlay)
- [x] 10. Fix main-app SCR3 error (SPA-fallback proxy response hijack) in
      `src/hooks/useUrlLoader.ts`
- [x] 11. B1: serve editor same-origin via reverse proxy for cross-origin isolation
      (live WebContainer). Same-origin iframe URL; lessons under `/lessons/`;
      gallery bundles under `/gallery-assets/`; COOP/COEP headers; Caddyfile +
      vercel.json proxy editor paths; Vite dev `server.proxy` for local testing.

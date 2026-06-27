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
- [x] 11. B1 (superseded): serve editor same-origin via reverse-proxy subdomain.
- [x] 12. B2 (current): convert `tube` to the `@next-editor/tube` package and mount
      `LearnPage` at `/learn` in the main app — one origin, no proxy/CORS, isolation
      inherited from the main app so live WebContainer works. Removed all standalone
      app/build/deploy files (index.html, main.tsx, vite.config, tsconfig, Caddyfile,
      vercel.json, .env\*, index.css). Lesson assets moved to the main app's
      `public/lessons/` + `public/lessons.json`. Wired via tsconfig `paths` + Vite
      `resolve.alias` + Tailwind `@source` (not a bun workspace — bun's workspace
      mode drops a scoped `vite-plus` platform dep here). Verified tsc + lint + build.
- [x] 13. Replace the iframe with the real `Editor` component. `LessonDetail`
      lazy-loads `@app/components/Editor` (separate ~290KB chunk; gallery chunk ~9KB)
      and `LearnPage` switches grid ↔ detail via the `?url=` search param. Removed
      `LessonPlayer.tsx` and `buildPlayUrl`; added `@app/*` alias (tsconfig + Vite).

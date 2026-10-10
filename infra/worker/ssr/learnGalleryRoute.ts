import type { Env } from "../env";
import { readGalleryPage } from "../lessonCatalog";
import { renderGalleryResponse } from "./learnGallery";
import { serveAppShell } from "./staticDocuments";

/**
 * GET /learn — the SPA shell with the gallery's page 0 dehydrated into it and
 * its first row's thumbnails preloaded (ssr/learnGallery.ts). The page is the
 * same for every visitor, signed in or not, and its query string is the
 * client's business.
 *
 * The shell is fetched by its canonical URL, and unconditionally: the decorated
 * document has no validator of its own, and a 304 against a shell the browser
 * cached plain would hand it a document without page 0. The D1 read runs while
 * the shell is fetched, so the document waits for the slower of the two, not
 * their sum. Any failure degrades to the untouched shell, and the client
 * fetches page 0 itself, as it always did.
 */
export async function serveLearnGalleryDocument(env: Env, request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return serveAppShell(env.ASSETS, request);
  }

  const headers = new Headers(request.headers);
  headers.delete("if-none-match");
  headers.delete("if-modified-since");
  const [assetResponse, page] = await Promise.all([
    serveAppShell(env.ASSETS, new Request(request, { headers })),
    readGalleryPage(env, 0).catch((error: unknown) => {
      console.error("Gallery SSR failed", error);
      return null;
    }),
  ]);

  if (!page) {
    return assetResponse;
  }

  try {
    return await renderGalleryResponse(assetResponse, page);
  } catch (error) {
    console.error("Gallery SSR failed", error);
    return assetResponse;
  }
}

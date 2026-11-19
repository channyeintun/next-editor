// Keeps a preview's last picture on screen while the page reloads.
//
// A dev server reloads the whole page for an edit it cannot apply in place
// (Vite: an index.html edit, or a module with no hot-update boundary, which is
// every .jsx file of a project without a React plugin). An iframe shows
// nothing between the old document and the first paint of the new one, so the
// editor's own panel showed through the preview frame: a dark flash on every
// keystroke, under a dark theme.
//
// Where the browser has cross-document view transitions and the Navigation
// API (Chromium), the page's own reload becomes a replace navigation to the
// same address, which may start a view transition (a reload may not). The new
// document keeps the old one's picture on top until it has loaded and painted
// what its scripts rendered, then drops it. A reload that comes while the
// picture is still up waits for that moment, so a burst of them (one for each
// keystroke) becomes one, taken from a page that has been drawn. Everywhere
// else the reload runs as it always did.

/** What the old document leaves for the new one, in the preview origin's sessionStorage. */
export const IFRAME_RELOAD_HOLD_STORAGE_KEY = "__NEXT_EDITOR_RELOAD_HOLD__";

/** How long a note left by the old document stays valid: longer and the navigation was another. */
const NOTE_MAX_AGE_MS = 10_000;
/** The longest the old picture is kept, when the new page has not loaded by then. */
const HOLD_MAX_MS = 1_000;

/**
 * Both documents: allow the transition, and take the page as one picture (a
 * page's own named elements would otherwise move between their two places).
 */
const OPT_IN_CSS =
  "@view-transition{navigation:auto}" +
  "*,*::before,*::after{view-transition-name:none!important}" +
  ":root{view-transition-name:root!important}";

/**
 * The new document: the old picture stays as it was, on top, and the new one
 * is hidden under it. The animation only keeps the transition going until the
 * script ends it.
 */
const HOLD_CSS =
  "@keyframes next-editor-reload-hold{from{opacity:1}to{opacity:1}}" +
  "::view-transition-group(root),::view-transition-image-pair(root){animation:none!important}" +
  "::view-transition-old(root){animation:next-editor-reload-hold 10s linear both!important;opacity:1!important;mix-blend-mode:normal!important}" +
  "::view-transition-new(root){animation:none!important;opacity:0!important;mix-blend-mode:normal!important}";

/**
 * The script: once per window (`setupMarker`), in the document's head, before
 * the page's own scripts. No `<script>` wrapper.
 */
export function createIframeReloadHoldScript(setupMarker: string): string {
  return `
    (function() {
      const marker = ${JSON.stringify(setupMarker)};
      if (window[marker]) return;
      window[marker] = true;

      const key = ${JSON.stringify(IFRAME_RELOAD_HOLD_STORAGE_KEY)};
      const optInCss = ${JSON.stringify(OPT_IN_CSS)};
      const holdCss = ${JSON.stringify(HOLD_CSS)};
      const navigation = window.navigation;
      const document = window.document;

      // Without both, a reload is left alone: a replace navigation with no
      // transition would only lose the scroll position.
      if (
        !navigation ||
        typeof navigation.addEventListener !== "function" ||
        typeof window.CSSViewTransitionRule === "undefined" ||
        !("onpagereveal" in window)
      ) {
        return;
      }

      // The rules go in a constructed sheet, not a <style> element: they never
      // show in the page's DOM, nor in a snapshot of it. Answers how to remove them.
      function addRules(css) {
        try {
          const sheet = new window.CSSStyleSheet();
          sheet.replaceSync(css);
          document.adoptedStyleSheets = document.adoptedStyleSheets.concat(sheet);
          return function() {
            document.adoptedStyleSheets = document.adoptedStyleSheets.filter(function(other) {
              return other !== sheet;
            });
          };
        } catch (error) {
          const style = document.createElement("style");
          style.textContent = css;
          (document.head || document.documentElement).appendChild(style);
          return function() { style.remove(); };
        }
      }

      function readNote() {
        try {
          const stored = window.sessionStorage.getItem(key);
          if (stored === null) return null;
          window.sessionStorage.removeItem(key);
          const note = JSON.parse(stored);
          if (!note || note.href !== window.location.href) return null;
          if (!(Date.now() - note.at < ${NOTE_MAX_AGE_MS})) return null;
          return note;
        } catch (error) {
          return null;
        }
      }

      // ── the new document: keep the old picture until this one is ready ──
      // While the old picture is up this document has drawn nothing yet, so a
      // reload that comes now waits: taken at once, the picture kept for the
      // next document would be this empty one. Typing without a pause sends
      // reloads faster than a page loads.
      let holding = false;
      let reloadWaiting = false;

      const note = readNote();
      if (note) {
        const removeRules = addRules(optInCss + holdCss);
        let transition = null;
        holding = true;

        function release() {
          if (!holding) return;
          holding = false;
          // A replace navigation starts at the top; a reload kept its place.
          if (note.x || note.y) window.scrollTo(note.x, note.y);
          if (transition) transition.skipTransition();
          removeRules();
          // The reloads that waited, as one, now that this page is on screen.
          if (reloadWaiting) {
            reloadWaiting = false;
            window.location.reload();
          }
        }

        window.addEventListener("pagereveal", function(event) {
          transition = event.viewTransition || null;
          if (!holding && transition) transition.skipTransition();
        }, { once: true });

        // Loaded, then two frames: what the page's scripts rendered is painted.
        function afterLoad() {
          window.requestAnimationFrame(function() {
            window.requestAnimationFrame(release);
          });
        }
        if (document.readyState === "complete") afterLoad();
        else window.addEventListener("load", afterLoad, { once: true });
        window.setTimeout(release, ${HOLD_MAX_MS});
      }

      // ── the old document: reload as a replace navigation ──
      navigation.addEventListener("navigate", function(event) {
        // With a fragment, navigating to the same address only scrolls.
        if (event.navigationType !== "reload" || !event.cancelable || window.location.hash) return;
        if (holding) {
          event.preventDefault();
          reloadWaiting = true;
          return;
        }
        try {
          window.sessionStorage.setItem(key, JSON.stringify({
            at: Date.now(),
            href: window.location.href,
            x: window.scrollX,
            y: window.scrollY
          }));
        } catch (error) {
          return; // No storage, no note for the new document: reload as usual.
        }
        event.preventDefault();
        addRules(optInCss);
        // The browser learns that this document allows the transition when its
        // styles are next worked out. Left to the next frame, a navigation that
        // commits sooner (a local dev server answers in a few milliseconds) gets
        // no transition, so they are worked out now.
        if (typeof window.getComputedStyle === "function") {
          void window.getComputedStyle(document.documentElement).opacity;
        }
        window.location.replace(window.location.href);
      });
    })();
  `;
}

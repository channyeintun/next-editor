# Vendored rrweb record bundle

`rrweb.umd.min.cjs` is a verbatim copy of `node_modules/rrweb/dist/rrweb.umd.min.cjs`
from **rrweb@2.0.1** (see `package.json`).

It is vendored (rather than imported via the package) because:

- rrweb's `exports` field does not expose the UMD subpath, so a `?raw` bare-specifier
  import is rejected by the bundler.
- This bundle is inlined as text into the **WebContainer-served preview page** so it
  runs inside the preview realm and exposes `window.rrweb.record` for recording.

It is imported with `?raw` from `../rrwebPreview.ts`. The host app uses the regular
`rrweb` package (ESM `Replayer`) for replay — only recording needs the inlined UMD.

## Regenerate after bumping rrweb

```sh
cp node_modules/rrweb/dist/rrweb.umd.min.cjs src/components/preview/vendor/rrweb.umd.min.cjs
```

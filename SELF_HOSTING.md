# Self-Hosting

This repository includes a production Docker image for deployments outside Vercel.

The image builds the app with Bun inside a Node-based builder stage, then serves the generated `dist/` output with Caddy. The bundled server configuration preserves the two deployment requirements this app depends on:

- SPA fallback to `index.html`
- Cross-origin isolation headers for WebContainers

## Quick Start

Build the image:

```bash
docker build -t next-editor .
```

Run the container:

```bash
docker run --rm -p 8080:8080 next-editor
```

Open `http://localhost:8080`.

## Docker Compose

Start the app with Compose:

```bash
docker compose up --build
```

Run it in the background:

```bash
docker compose up --build -d
```

Stop the app:

```bash
docker compose down
```

## What The Container Does

- Installs Bun in a Node builder stage and runs the production build with Bun
- Serves the `dist/` output with Caddy
- Applies `Cross-Origin-Embedder-Policy: require-corp`
- Applies `Cross-Origin-Opener-Policy: same-origin`
- Rewrites unknown routes to `index.html`

## Production Requirements

If you deploy without Docker, your host must reproduce the same behavior as `Caddyfile`:

- Serve the built `dist/` directory
- Rewrite application routes to `index.html`
- Send `Cross-Origin-Embedder-Policy: require-corp` on app responses
- Send `Cross-Origin-Opener-Policy: same-origin` on app responses

Without those headers, the WebContainer-backed runtime features will not work correctly.

## Browser And TLS Notes

- Full `Node App Lesson` runtime support still requires a Chromium-based browser
- Real production deployments should be served over HTTPS, either by your platform, your ingress, or a reverse proxy in front of the container

## Files

- `Dockerfile` builds the app in a Node stage with Bun installed, then copies the production assets into the Caddy image
- `Caddyfile` defines the static hosting behavior used inside the container
- `docker-compose.yml` runs the same production image with a single service definition
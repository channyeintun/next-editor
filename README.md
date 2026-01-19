# Next Editor

<div align="center">
  <img src="public/logo.png" alt="Next Editor Logo" width="200" />
  <br />
</div>

A powerful code editor focused on recording, playback, and presentation. Next Editor allows you to record your coding sessions, synchronize them with interactive slides, and share them easily.

## Features

- 🎥 **Code Recording & Playback**: Record your typing, cursor movements, and interactions for high-fidelity playback.
- 📊 **Presentation Slides**: Integrated Reveal.js support for adding HTML or Markdown slides to your recordings.
- 🖼️ **Live Preview**: Instant preview of your code changes properly isolated in an iframe.
- 💾 **Steganography Storage**: Save your entire project and recording history embedded inside a single PNG image.
- 📝 **Rich Editing**: Powered by Monaco Editor for a VS Code-like editing experience.
- 🎯 **Cursor Tracking**: strict isolation and accurate reproduction of cursor movements.

## Getting Started

### Prerequisites

- Node.js (Latest LTS recommended)
- [Bun](https://bun.sh/) (Recommended, as `bun.lock` is present)

### Installation

Clone the repository and install dependencies:

```bash
bun install
# or
npm install
```

### Development

Start the local development server:

```bash
bun dev
# or
npm run dev
```

The application will launch at `http://localhost:5173`.

### Production Build

Build the application for production:

```bash
bun run build
# or
npm run build
```

## Project Structure

- `src/core`: Core logic for the editor state machine and recording/playback engine.
- `src/components`: React components for the UI.
- `src/contexts`: Context providers for state management.
- `public`: Static assets including the WASM module for steganography.

## License

Private

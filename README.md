# Next Editor

<div align="center">
  <img src="public/logo.png" alt="Next Editor Logo" width="200" />
  <br />
  <h1>Next-Level Code Recording & Presentation</h1>
</div>

Next Editor is a powerful, high-fidelity code playground and recording engine. It allows you to record your coding sessions, synchronize them with interactive slides, and export them as a single, portable file. Designed for developers who want to share their knowledge through interactive experiences rather than just static videos.

## 🚀 Key Features

- 🎥 **High-Fidelity Recording**: Capture every keystroke, cursor movement, and interaction with strict isolation and accurate reproduction.
- 📊 **Interactive Slides**: Built-in [reveal.js](https://revealjs.com/) support. Add HTML or Markdown slides that sync perfectly with your code playback.
- 🖼️ **Live Preview**: Instant, isolated preview of your code changes (HTML/CSS/JS) inside a secure iframe.
- 💾 **Portable Project Files**: Save your entire project—code, recording, and slides—in a single `.ne` file. Since we record events rather than pixels, `.ne` files are exceptionally small compared to traditional video formats.
- 📝 **Pro-Grade Editor**: Powered by [Monaco Editor](https://microsoft.github.io/monaco-editor/) for a familiar, VS Code-like experience.
- 🎨 **Modern Aesthetics**: A premium, dynamic UI built with Tailwind CSS 4 and Motion.

## 🛠️ Tech Stack

Next Editor uses a cutting-edge stack for maximum performance and developer experience:

- **Core**: [React 19](https://react.dev/), [Vite 8](https://vitejs.dev/), [Rolldown](https://rolldown.rs/) (High-performance bundler)
- **State Management**: [XState 5](https://stately.ai/docs/xstate) (Robust state machine for recording/playback)
- **Styling**: [Tailwind CSS 4](https://tailwindcss.com/) & [Motion](https://motion.dev/)
- **Serialization**: [SuperJSON](https://github.com/blitz-js/superjson) & [Pako](https://github.com/nodeca/pako) (zlib compression)
- **Performance**: [OXC](https://oxc-project.github.io/) for ultrafast linting and minification.

## 📂 Project Structure

- `src/core`: The "brain" of the editor—state machines and the recording/playback engine.
- `src/storage`: Serialization and data management logic.
- `src/components`: UI components including the Landing Page, Editor, and Preview.
- `src/contexts`: React contexts for global state management.
- `src/hooks`: Custom hooks for editor interactions and state access.
- `public`: Static assets used by the application.

## 🚦 Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (Recommended package manager)
- Node.js (Latest LTS)

### Installation

```bash
bun install
```

### Development

```bash
bun dev
```

The application will be available at `http://localhost:5173`.

### Production Build

```bash
bun run build
```

## 📖 Learn More

- [Slides Usage Guide](SLIDES_USAGE.md) - Learn how to add and customize presentation slides.

## 📄 License

Private / Confidential

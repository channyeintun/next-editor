# Presentation Slides Feature

This feature allows you to add presentation slides using reveal.js to your recordings and interact with them during recording and playback.

## Features

### Slide Management

- Add slides using HTML or Markdown content
- Toggle between Markdown and HTML modes
- Edit slides inline with live preview
- Reorder slides using up/down arrows
- Remove slides individually

### Slide Preview (powered by reveal.js)

- Two sizes: small (minimized) and large (maximized)
- Original reveal.js styling with controls and progress bar
- Full support for reveal.js features (transitions, fragments, backgrounds)
- Navigation controls for next/previous slides in large mode
- Keyboard shortcuts in large mode (← → arrows, Escape to minimize)
- Click to expand from small to large size

### Recording Integration

- Records slide open/close events during recording
- Records slide change events (when switching between slides)
- Records maximize/minimize events
- All events are synchronized with timeline for playback

## How to Use

### 1. Adding Slides

1. Click the "📊 Slides" button in the header (next to Import/Export buttons)
2. A dropdown will appear with the slides manager
3. Choose content type: **Markdown** or **HTML**
4. Enter your slide content in the textarea
5. Click "Add Slide" to add the slide

### 2. HTML Slide Content Example

```html
<h1>Welcome to My Presentation</h1>
<p>This is a paragraph with <strong>bold</strong> text.</p>
<ul>
  <li>Item 1</li>
  <li>Item 2</li>
  <li>Item 3</li>
</ul>
```

### 3. Markdown Slide Content Example

```markdown
# Welcome to My Presentation

This is a paragraph with **bold** text.

- Item 1
- Item 2
- Item 3
```

### 4. Advanced reveal.js Features

#### Fragments (step-by-step reveal)

```html
<h2>Step by Step</h2>
<p class="fragment">First item appears</p>
<p class="fragment">Then this one</p>
<p class="fragment">Finally this</p>
```

#### Background Colors

```html
<section data-background="#4d7e65">
  <h2>Green Background</h2>
</section>
```

#### Transitions

```html
<section data-transition="zoom">
  <h2>Zoom Transition</h2>
</section>
```

### 5. Managing Slides

- Click the **✏️** button or slide thumbnail to edit content
- Use **↑ ↓** buttons to reorder slides
- Use **×** button to remove slides

### 6. Starting Presentation

1. Click "Ready" button in the slides manager
2. The slides manager will automatically close
3. The slide preview will appear at bottom-right (minimized by default)
4. Click to expand to large size, or use maximize button

### 7. Navigation

- **Small size**: Click to expand to large or use green maximize button
- **Large size**:
  - Use keyboard arrows (← →) for navigation
  - Click reveal.js navigation arrows
  - Use header navigation buttons (‹ ›)
- **Minimize**: Yellow button in header or green button to toggle
- **Close**: Click outside the large preview

### 8. Recording with Slides

1. Add your slides first
2. Start presentation if desired
3. Start recording
4. Interact with slides (open, close, navigate, resize)
5. All slide interactions will be recorded and can be played back

## Supported reveal.js Features

- **Transitions**: slide, fade, convex, concave, zoom
- **Fragments**: step-by-step content reveal
- **Backgrounds**: colors, gradients, images
- **Code highlighting**: with highlight.js support
- **Auto-animate**: smooth element transitions
- **Progress bar**: visual progress indicator
- **Navigation controls**: arrow buttons

## Technical Notes

- Slides are stored in localStorage and persist across sessions
- Content type (HTML/Markdown) is stored with each slide
- Slide events are recorded with timestamps relative to recording start
- Events include: slide_open, slide_close, slide_change, slide_maximize, slide_minimize
- Markdown is processed by reveal.js's built-in Markdown plugin
- Keyboard navigation only works in large (maximized) mode

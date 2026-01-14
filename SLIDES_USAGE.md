# Presentation Slides Feature

This feature allows you to add presentation slides to your recordings and interact with them during recording and playback.

## Features

### Slide Management
- Add slides by providing image URLs (absolute or full paths)
- Reorder slides by using up/down arrows
- Remove slides individually
- Preview slides with thumbnail images

### Slide Preview
- Two sizes: small (minimized) and large (maximized)
- Positioned at bottom-right when minimized (similar to iframe preview)
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
3. Enter an image URL in the input field (absolute path like `/path/to/image.png` or full URL)
4. Click "Add" or press Enter
5. Repeat to add more slides

### 2. Managing Slides
- Use ↑ ↓ buttons to reorder slides
- Use × button to remove slides
- Use × button in the header to close the slides manager
- Slides are numbered automatically

### 3. Starting Presentation
1. Click "Start Presentation" button in the slides manager
2. The slides manager will automatically close
3. The slide preview will appear at bottom-right (minimized by default)
4. Click to expand to large size, or use maximize button

### 4. Navigation
- **Small size**: Click to expand to large or use green maximize button
- **Large size**: Use keyboard arrows (← →) or header navigation buttons (‹ ›)
- **Minimize**: Yellow button in header or green button to toggle
- **Close**: Click outside the large preview or use presentation controls

### 5. Recording with Slides
1. Add your slides first
2. Start presentation if desired
3. Start recording
4. Interact with slides (open, close, navigate, resize)
5. All slide interactions will be recorded and can be played back

### 6. Positioning
- **Small (minimized)**: Bottom-right corner
- **Large**: Centered on screen with overlay

## Example Image URLs

You can use various types of image URLs:

```
Absolute paths:
/Users/username/Pictures/slide1.png
/home/user/documents/presentation/slide2.jpg

Relative paths (if supported by your setup):
./assets/slide1.png
../images/slide2.jpg

Web URLs:
https://example.com/image.png
```

## Technical Notes

- Slide events are recorded with timestamps relative to recording start
- Events include: slide_open, slide_close, slide_change, slide_maximize, slide_minimize
- Images are loaded lazily and handle errors gracefully
- Keyboard navigation only works in large (maximized) mode
# Coding School Project - Claude Development Notes

## Project Overview
A React-based coding education platform with Scrimba-like recording and playback functionality. Features a **slides-based presentation system** combined with single-file HTML/CSS/JavaScript editing, real-time preview, and editor state recording/playback capabilities.

## Current Architecture

### Core Components
- **CodeEditor**: Monaco Editor wrapper with recording capabilities
- **Preview**: Live preview component that auto-detects content type (HTML/CSS/JS)
- **useScrimba**: Main hook for recording/playback functionality with editor state snapshots
- **ScrimbaContext**: Global state management for recording sessions
- **SlidesManager**: Presentation slides management with image URLs
- **SlidesContext**: Context for slides state and presentation mode

### Key Features
- ✅ Single file editing (HTML/CSS/JS)
- ✅ Real-time preview with content type detection
- ✅ **Slides-based presentation system** (not screen recording)
- ✅ Editor state recording (content, cursor, selection changes)
- ✅ Audio recording with playback synchronization
- ✅ Cursor movement tracking during playback
- ✅ Presentation slides with image URLs
- ✅ Import/export recordings
- ✅ Custom Monaco theme

### Technology Stack
- React 19+ with TypeScript
- Monaco Editor for code editing
- Vite for build tooling
- Tailwind CSS for styling
- Custom useScrimba hook for recording logic

## Development Commands
```bash
# Development
npm run dev

# Build
npm run build

# Type checking
npm run typecheck

# Linting
npm run lint
```

## Multi-File Support Implementation Plan

### Phase 1: File Management System
- [ ] Create FileExplorer component with tree structure
- [ ] Implement file CRUD operations (Create, Read, Update, Delete)
- [ ] Add file type detection and icons (HTML/CSS/JS)
- [ ] Track active file state in context
- [ ] Support multiple HTML files as pages

### Phase 2: Basic File Linking Preview
- [ ] Modify Preview component to handle multi-file projects
- [ ] Implement CSS/JS injection into HTML files
- [ ] Add file linking logic (generateLinkedHTML function)
- [ ] Handle file changes triggering preview updates
- [ ] Support switching between different HTML pages

### Phase 3: Multi-Page Navigation System
- [ ] Add navigation interception in iframe
- [ ] Implement single-iframe page navigation (index.html → about.html)
- [ ] Add browser-like navigation controls (back/forward)
- [ ] Track current page state in preview
- [ ] Handle anchor tag lessons with real navigation

### Phase 4: Enhanced Recording System
- [ ] Extend snapshot structure to include active file and current page
- [ ] Record file operations (create/delete/rename/switch) with timestamps
- [ ] Track navigation events between HTML pages
- [ ] Record file content changes per file
- [ ] Update playback to recreate file switches and page navigation

### Phase 5: UI/UX Polish
- [ ] Add file tabs for open files
- [ ] Implement file explorer with icons and operations
- [ ] Add navigation breadcrumbs in preview
- [ ] Keyboard shortcuts for file operations
- [ ] File search and filtering

## File Structure for Multi-File Support

### Proposed Data Structure (Folder-Aware)
```typescript
interface FileNode {
  id: string;
  name: string;                   // "index.html", "main.css", "styles"
  type: 'file' | 'folder';
  fileType?: 'html' | 'css' | 'js' | 'png' | 'jpg';  // Only for files
  content?: string;               // Only for files
  children?: FileNode[];          // Only for folders
  parentId?: string;              // Reference to parent folder
  path: string;                   // Full path: "css/main.css", "pages/about.html"
  isPage?: boolean;               // Mark HTML files as navigable pages
}

interface Project {
  files: FileNode[];              // Tree structure (root level items)
  activeFileId: string | null;    // Currently editing file
  currentPageId: string | null;   // Currently viewing page in preview  
  navigationHistory: string[];    // For back/forward navigation
}
```

### Enhanced Recording Structure
```typescript
interface FileOperation {
  type: 'create' | 'delete' | 'rename' | 'switch' | 'navigate' | 'move' | 'createFolder';
  fileId: string;
  timestamp: number;
  data?: {
    newName?: string;
    fileType?: 'html' | 'css' | 'js' | 'folder';
    content?: string;
    fromPage?: string;    // For navigation events
    toPage?: string;      // For navigation events
    fromPath?: string;    // For move operations
    toPath?: string;      // For move operations
    parentId?: string;    // For create operations
  };
}

interface FileSnapshot extends EditorSnapshot {
  activeFileId: string;           // Which file is being edited
  currentPageId?: string;         // Which page is shown in preview  
  fileOperation?: FileOperation;  // What file operation happened
  projectFiles?: FileNode[];      // Snapshot of complete file tree
}
```

## Technical Considerations

### Manual File Linking Approach (Educational Focus)
- **No automatic linking** - Students must write `<link>` and `<script>` tags
- **Manual CSS linking**: Students write `<link rel="stylesheet" href="css/styles.css">`
- **Manual JS linking**: Students write `<script src="js/main.js"></script>`
- **Manual navigation**: Students write `<a href="pages/about.html">About</a>`
- **Relative path education**: Students learn `../`, `./`, and directory navigation
- **File resolution**: System resolves relative paths to actual file content
- **Single iframe navigation**: Message passing for page navigation

### Folder-Aware File Management
- Support full directory tree structure with nested folders
- Support HTML, CSS, JS files plus common assets (PNG, JPG)
- File and folder operations recorded for playback
- Multiple HTML files treated as separate "pages" regardless of folder
- CSS/JS files linked only when explicitly referenced in HTML
- Realistic project organization patterns

### Single Iframe Navigation System
```typescript
// Navigation interception logic
const navigationScript = `
  <script>
    document.addEventListener('click', function(e) {
      if (e.target.tagName === 'A') {
        const href = e.target.getAttribute('href');
        if (href && href.endsWith('.html')) {
          e.preventDefault();
          window.parent.postMessage({
            type: 'NAVIGATE',
            target: href
          }, '*');
        }
      }
    });
  </script>
`;
```

### Recording System Extensions
- Current recording system captures editor state changes and slide interactions
- Extend to capture file operations (create/delete/rename/switch)
- Record navigation events between HTML pages
- Track both activeFileId (editing) and currentPageId (viewing)
- Playback recreates file states, page navigation, and slide states
- Maintain compatibility with existing slide presentation features

### Path Resolution and File Linking Logic
```typescript
// Resolve relative paths to actual files
function resolvePath(currentFilePath: string, relativePath: string): string {
  const currentDir = currentFilePath.split('/').slice(0, -1); // Get directory
  const pathParts = relativePath.split('/');
  
  const resolvedParts = [...currentDir];
  
  for (const part of pathParts) {
    if (part === '..') {
      resolvedParts.pop();      // Go up one directory
    } else if (part !== '.' && part !== '') {
      resolvedParts.push(part); // Go deeper
    }
  }
  
  return resolvedParts.join('/'); // Final resolved path
}

// Find file by path in tree structure
function findFileByPath(files: FileNode[], targetPath: string): FileNode | null {
  for (const file of files) {
    if (file.path === targetPath && file.type === 'file') {
      return file;
    }
    if (file.type === 'folder' && file.children) {
      const found = findFileByPath(file.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

// Replace file references with actual content
function resolveFileReferences(html: string, currentFilePath: string, project: Project): string {
  let resolvedHTML = html;
  
  // Replace CSS file references
  resolvedHTML = resolvedHTML.replace(/href=["']([^"']+\.css)["']/g, (match, relativePath) => {
    const resolvedPath = resolvePath(currentFilePath, relativePath);
    const cssFile = findFileByPath(project.files, resolvedPath);
    
    if (cssFile) {
      return `href="data:text/css,${encodeURIComponent(cssFile.content || '')}"`;
    }
    return match; // Keep original if file not found
  });
  
  // Replace JS file references
  resolvedHTML = resolvedHTML.replace(/src=["']([^"']+\.js)["']/g, (match, relativePath) => {
    const resolvedPath = resolvePath(currentFilePath, relativePath);
    const jsFile = findFileByPath(project.files, resolvedPath);
    
    if (jsFile) {
      return `src="data:application/javascript,${encodeURIComponent(jsFile.content || '')}"`;
    }
    return match; // Keep original if file not found
  });
  
  // Add navigation interception script
  const navigationScript = `
    <script>
      document.addEventListener('click', function(e) {
        if (e.target.tagName === 'A') {
          const href = e.target.getAttribute('href');
          if (href && href.endsWith('.html')) {
            e.preventDefault();
            const resolvedPath = '${currentFilePath}'.split('/').slice(0, -1).join('/');
            const targetPath = href.startsWith('../') || href.startsWith('./') 
              ? resolvePath('${currentFilePath}', href)
              : href;
            window.parent.postMessage({
              type: 'NAVIGATE',
              target: targetPath
            }, '*');
          }
        }
      });
    </script>
  `;
  
  resolvedHTML = resolvedHTML.replace('</body>', `${navigationScript}\n</body>`);
  return resolvedHTML;
}
```

## Implementation Priority

### **Phase 1: Folder-Aware File Management**
1. **FileExplorer component** - Tree view with folders and files
2. **Folder operations** - Create/delete/rename folders and files
3. **Project context** - Folder-aware state management
4. **Path tracking** - Full path support for all files
5. **Drag & drop** - Move files between folders

### **Phase 2: Path Resolution System**
6. **Path resolution logic** - Handle relative paths (../, ./, etc.)
7. **File reference replacement** - Replace href/src with content
8. **Manual linking enforcement** - Students must write link/script tags
9. **Preview component updates** - Handle folder-based projects

### **Phase 3: Multi-Page Navigation**
10. **Navigation interception** - Iframe message passing for anchor clicks
11. **Cross-folder navigation** - Handle navigation between folders
12. **Page state tracking** - Current page vs active file
13. **Navigation controls** - Back/forward with breadcrumbs

### **Phase 4: Recording Integration**  
14. **Enhanced snapshots** - Include complete file tree state
15. **Folder operation events** - Record all file and folder operations
16. **Path-aware playback** - Recreate folder structure during playback
17. **Navigation recording** - Track cross-folder page navigation

### **Phase 5: Educational Features**
18. **Relative path lessons** - Teach ../ and ./ navigation
19. **File organization lessons** - Best practices for folder structure
20. **Project template system** - Pre-built folder structures
21. **Visual path indicators** - Show file relationships in UI

## Example Use Cases

### **Relative Path Navigation Lesson:**
```
📁 Multi-Page Website
├── 📄 index.html                    <!-- <a href="pages/about.html">About</a> -->
├── 📁 pages/
│   ├── 📄 about.html               <!-- <a href="../index.html">Home</a> -->
│   ├── 📄 contact.html             <!-- <a href="../index.html">Home</a> -->
│   └── 📄 blog.html                <!-- <a href="about.html">About</a> -->
├── 📁 css/
│   ├── 🎨 main.css                 <!-- Shared styles -->
│   └── 🎨 responsive.css           <!-- Media queries -->
└── 📁 js/
    └── ⚡ navigation.js             <!-- Shared behavior -->
```

**Student Learning:**
- `index.html`: `<link rel="stylesheet" href="css/main.css">`
- `pages/about.html`: `<link rel="stylesheet" href="../css/main.css">`
- `pages/blog.html`: `<a href="contact.html">Contact</a>` (same folder)

### **CSS Organization Lesson:**
```
📁 Styled Website
├── 📄 index.html                    <!-- Links all CSS files -->
├── 📁 styles/
│   ├── 🎨 reset.css                 <!-- CSS reset -->
│   ├── 🎨 layout.css                <!-- Grid/flexbox -->
│   ├── 🎨 components.css            <!-- Buttons, cards -->
│   └── 🎨 responsive.css            <!-- Media queries -->
└── 📁 assets/
    └── 📁 images/
        ├── 🖼️ logo.png
        └── 🖼️ hero.jpg
```

**Student Learning:**
- Proper CSS organization and separation of concerns
- Multiple stylesheet linking: `<link rel="stylesheet" href="styles/reset.css">`
- Asset path references: `background: url('../assets/images/hero.jpg')`

## Notes for Development
- **Maintain backward compatibility** - Single-file mode should still work initially
- **Manual linking only** - Students must learn proper `<link>` and `<script>` syntax
- **Path resolution complexity** - Implement robust relative path handling
- **Test thoroughly** - Recording/playback with folder operations is very complex
- **Educational focus** - UI should teach proper file organization patterns
- **Performance considerations**:
  - Efficient tree rendering for large folder structures
  - Debounce preview updates when multiple files change
  - Lazy loading of file contents in large projects
- **Error handling** - Show helpful messages for broken file references
- **Future considerations**:
  - File upload/download for importing existing projects  
  - Project template system with common folder structures
  - Asset handling (images, fonts, etc.)
  - Build tool introduction (as advanced lessons)

## Implementation Complexity Assessment
- **High complexity** due to folder structure and path resolution
- **Educational value is very high** - teaches real web development patterns
- **Phases should be implemented incrementally** to manage complexity
- **Thorough testing required** for recording/playback with folder operations
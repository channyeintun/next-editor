# Publishing use-scrimba to NPM

## Prerequisites

1. **Node.js Version**: **Use Node.js 22 LTS** (avoid Node.js 23 due to a build bug where 'dist' becomes 'ist' in output paths)
   ```bash
   # Check your Node version
   node --version
   # Should be v22.x.x
   
   # If using nvm to manage Node versions:
   nvm install 22
   nvm use 22
   ```
2. **NPM Account**: Create an account at [npmjs.com](https://www.npmjs.com)
3. **NPM CLI**: Make sure you have npm installed
4. **Git Repository**: Push your code to GitHub/GitLab first

## Step-by-Step Publishing Process

### 1. Prepare Your Environment

```bash
# Navigate to the package directory
cd packages/use-scrimba

# Install dependencies
npm install

# Login to NPM (only needed once)
npm login
```

### 2. Update Package Information

Edit `package.json` to update:

```json
{
  "name": "use-scrimba",
  "version": "1.0.0",
  "author": {
    "name": "Your Name",
    "email": "your.email@example.com"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/yourusername/use-scrimba.git"
  },
  "bugs": {
    "url": "https://github.com/yourusername/use-scrimba/issues"
  },
  "homepage": "https://github.com/yourusername/use-scrimba#readme"
}
```

### 3. Quality Checks

```bash
# Type check
npm run type-check

# Lint code
npm run lint

# Run tests (if you have any)
npm test

# Build the package
npm run build
```

### 4. Verify Package Contents

```bash
# Check what files will be published
npm pack --dry-run

# This should show:
# - dist/ (compiled JavaScript)
# - README.md
# - package.json
# - LICENSE
```

### 5. Version Management

```bash
# For initial release
npm version 1.0.0

# For subsequent releases
npm version patch   # 1.0.1
npm version minor   # 1.1.0  
npm version major   # 2.0.0
```

### 6. Publish to NPM

```bash
# Publish the package
npm publish

# For scoped packages (if needed)
npm publish --access public
```

### 7. Verify Publication

```bash
# Check your package online
npm view use-scrimba

# Test installation
npm install use-scrimba
```

## Alternative: Manual Steps

If you prefer to do everything manually:

### 1. Set up NPM Account and Login

```bash
# Create account at npmjs.com, then:
npm login
# Enter your username, password, and email
```

### 2. Build and Test

```bash
# Install dependencies
npm install

# Build the package
npm run build

# Verify build output exists
ls -la dist/
# Should contain: index.js, index.esm.js, index.d.ts
```

### 3. Test the Package Locally

```bash
# Pack to test what gets published
npm pack

# This creates use-scrimba-1.0.0.tgz
# Extract and verify contents
tar -tzf use-scrimba-1.0.0.tgz
```

### 4. Publish

```bash
npm publish
```

## Post-Publication

### 1. Verify Installation

```bash
# Test in a new directory
mkdir test-use-scrimba
cd test-use-scrimba
npm init -y
npm install use-scrimba react @types/react monaco-editor @monaco-editor/react

# Create test file
echo 'import { useScrimba } from "use-scrimba";' > test.js
```

### 2. Update Documentation

- Add installation instructions to README
- Update version badges if you have them
- Create release notes

### 3. Share Your Package

- Tweet about it
- Post on Reddit r/reactjs
- Share in relevant Discord/Slack communities
- Add to awesome-react lists

## Troubleshooting

### Common Issues

1. **"Package name already exists"**
   ```bash
   # Check if name is available
   npm view use-scrimba
   # If taken, choose different name in package.json
   ```

2. **"Build files missing"**
   ```bash
   # Make sure build ran successfully
   npm run build
   ls -la dist/
   ```

3. **"TypeScript errors"**
   ```bash
   npm run type-check
   # Fix any errors before publishing
   ```

4. **"Authentication failed"**
   ```bash
   npm logout
   npm login
   # Enter credentials again
   ```

### Pre-publish Checklist

- [ ] README.md is comprehensive
- [ ] Examples work correctly
- [ ] All TypeScript types are exported
- [ ] Package.json has correct metadata
- [ ] Version number is appropriate
- [ ] No unused dependencies
- [ ] Build produces clean output
- [ ] Git repository is public and linked

## Continuous Publishing (Optional)

### GitHub Actions for Auto-publish

Create `.github/workflows/publish.yml`:

```yaml
name: Publish Package

on:
  release:
    types: [created]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm run build
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## Success! 🎉

Once published, users can install your package with:

```bash
npm install use-scrimba
```

And use it in their projects:

```tsx
import { useScrimba } from 'use-scrimba';
```

Your package is now available to the entire React/TypeScript community!
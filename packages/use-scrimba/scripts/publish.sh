#!/bin/bash

# use-scrimba Publishing Script
# Run this script to publish the package to NPM

set -e  # Exit on any error

echo "🚀 Starting use-scrimba publishing process..."

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Make sure you're in the package directory."
    exit 1
fi

# Check if logged into NPM
if ! npm whoami > /dev/null 2>&1; then
    echo "❌ Error: Not logged into NPM. Run 'npm login' first."
    exit 1
fi

echo "✅ NPM login verified"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Type check
echo "🔍 Running type check..."
npm run type-check

# Lint
echo "🧹 Running linter..."
npm run lint

# Build
echo "🔨 Building package..."
npm run build

# Verify build output
if [ ! -d "dist" ]; then
    echo "❌ Error: dist/ directory not found after build"
    exit 1
fi

if [ ! -f "dist/index.js" ] || [ ! -f "dist/index.esm.js" ] || [ ! -f "dist/index.d.ts" ]; then
    echo "❌ Error: Missing required build files"
    exit 1
fi

echo "✅ Build verification passed"

# Check what will be published
echo "📋 Checking package contents..."
npm pack --dry-run

echo ""
read -p "📤 Ready to publish. Continue? (y/N): " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🚀 Publishing to NPM..."
    npm publish
    
    if [ $? -eq 0 ]; then
        echo ""
        echo "🎉 Successfully published use-scrimba!"
        echo ""
        echo "📋 Next steps:"
        echo "  • Verify at: https://www.npmjs.com/package/use-scrimba"
        echo "  • Test install: npm install use-scrimba"
        echo "  • Share your package with the community!"
        echo ""
        
        # Get package info
        PACKAGE_VERSION=$(node -p "require('./package.json').version")
        echo "✅ Published version: $PACKAGE_VERSION"
    else
        echo "❌ Publishing failed. Check the error messages above."
        exit 1
    fi
else
    echo "❌ Publishing cancelled."
    exit 1
fi
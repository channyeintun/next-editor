#!/bin/bash

echo "Publishing use-scrimba package..."

# Build
npm run build

# Publish
npm publish --access public

echo "Done!"
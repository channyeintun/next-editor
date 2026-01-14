#!/bin/bash

echo "Publishing use-next-editor package..."

# Build
npm run build

# Publish
npm publish --access public

echo "Done!"
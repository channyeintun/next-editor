const resolve = require('@rollup/plugin-node-resolve');
const commonjs = require('@rollup/plugin-commonjs');
const typescript = require('@rollup/plugin-typescript');
const terser = require('@rollup/plugin-terser');
const { default: dts } = require('rollup-plugin-dts');
const postcss = require('rollup-plugin-postcss');
const { readFileSync } = require('fs');

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

const external = [
  ...Object.keys(pkg.peerDependencies || {}),
  'react/jsx-runtime',
];

module.exports = [
  // ESM and CJS builds
  {
    input: 'src/index.ts',
    external,
    output: [
      {
        file: pkg.main,
        format: 'cjs',
        sourcemap: true,
        inlineDynamicImports: true,
      },
      {
        file: pkg.module,
        format: 'esm',
        sourcemap: true,
        inlineDynamicImports: true,
      },
    ],
    plugins: [
      resolve(),
      commonjs(),
      postcss({
        extract: false, // Don't extract CSS to separate file
        inject: false, // Don't inject CSS into JS
        minimize: true,
      }),
      typescript({
        tsconfig: './tsconfig.json',
        declaration: false, // We'll generate declarations separately
        declarationMap: false, // Disable since declaration is false
        sourceMap: true,
      }),
      terser({
        compress: {
          drop_console: true, // Remove console.log statements
          drop_debugger: true, // Remove debugger statements
        },
        mangle: {
          reserved: ['useScrimba'], // Keep hook name readable
        },
        format: {
          comments: false, // Remove comments
        },
      }),
    ],
  },
  // Type definitions
  {
    input: 'src/index.ts',
    output: [{ file: 'dist/index.d.ts', format: 'esm' }],
    plugins: [dts()],
  },
];
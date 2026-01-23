import { defineConfig } from 'rolldown'

export default defineConfig([
    {
        input: 'src/core/src/index.ts',
        output: [
            {
                dir: 'dist/lib',
                format: 'es',
                entryFileNames: 'index.js',
                manualChunks: (id) => {
                    if (id.includes('node_modules')) {
                        if (id.includes('react') || id.includes('react-dom')) return 'vendor';
                        if (id.includes('monaco-editor')) return 'editor';
                        if (id.includes('xstate') || id.includes('@xstate/react')) return 'xstate';
                    }
                },
            },
            {
                dir: 'dist/lib',
                format: 'cjs',
                entryFileNames: 'index.cjs',
            },
        ],
        external: ['react', 'react-dom', 'monaco-editor', 'xstate', '@xstate/react'],
        minify: true,
    },
    {
        input: 'src/main.tsx',
        output: {
            dir: 'dist',
            format: 'es',
            manualChunks: (id) => {
                if (id.includes('node_modules')) {
                    if (id.includes('react') || id.includes('react-dom') || id.includes('react-router-dom')) return 'vendor';
                    if (id.includes('monaco-editor') || id.includes('@monaco-editor/react')) return 'editor';
                    if (id.includes('xstate') || id.includes('@xstate/react')) return 'xstate';
                    if (id.includes('pako') || id.includes('superjson')) return 'utils';
                }
            },
        },
        moduleTypes: {
            '.woff2': 'asset',
            '.ttf': 'asset',
            '.css': 'text',
        },
        minify: true,
    }
])

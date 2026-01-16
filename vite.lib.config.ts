import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

export default defineConfig({
    plugins: [react()],
    build: {
        lib: {
            entry: path.resolve(__dirname, 'src/use-next-editor/src/index.ts'),
            name: 'UseNextEditor',
            fileName: (format) => `index.${format === 'es' ? 'js' : 'cjs'}`,
            formats: ['es', 'cjs'],
        },
        rollupOptions: {
            external: ['react', 'react-dom', 'monaco-editor', 'xstate', '@xstate/react'],
            output: {
                globals: {
                    react: 'React',
                    'react-dom': 'ReactDOM',
                    'monaco-editor': 'monaco',
                    'xstate': 'XState',
                    '@xstate/react': 'XStateReact',
                },
            },
        },
        outDir: 'src/use-next-editor/dist',
        emptyOutDir: true,
        sourcemap: true, // Essential for library debugging
    },
});

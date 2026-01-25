import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
    plugins: [react()],
    root: 'renderer',
    base: './',
    build: {
        outDir: '../dist/renderer',
        emptyOutDir: true,
    },
    resolve: {
        alias: {
            '@components': path.resolve(__dirname, 'components'),
            '@services': path.resolve(__dirname, 'services'),
            '@types': path.resolve(__dirname, 'types'),
        },
    },
    server: {
        port: 5173,
    },
});

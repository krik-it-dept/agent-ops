import { defineConfig } from 'electron-vite';

export default defineConfig(({ command }) => ({
  main: {
    build: { rollupOptions: { output: { entryFileNames: 'index.cjs' } } },
  },
  preload: {
    build: {
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
    },
  },
  renderer: {
    resolve: {
      conditions: [
        'module',
        'browser',
        command === 'build' ? 'production' : 'development',
      ],
    },
    build: { minify: true },
    server: { host: '127.0.0.1', strictPort: true },
    plugins: [
      {
        name: 'development-csp',
        apply: 'serve',
        // Vite injects CSS and connects its local HMR socket only during development.
        transformIndexHtml: (html) =>
          html
            .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
            .replace(
              "connect-src 'none'",
              "connect-src 'self' ws://127.0.0.1:*",
            ),
      },
    ],
  },
}));

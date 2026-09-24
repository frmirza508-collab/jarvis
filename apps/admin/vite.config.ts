import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Injects a Content-Security-Policy that only allows the configured license API origin. */
function csp(apiUrl: string): Plugin {
  const origin = new URL(apiUrl).origin;
  const policy = `default-src 'self'; connect-src 'self' ${origin}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; base-uri 'self'; form-action 'self'`;
  return {
    name: 'jarvis-admin-csp',
    transformIndexHtml: (html) =>
      html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
  const apiUrl = env.VITE_LICENSE_API_URL ?? 'http://localhost:8787';
  return {
    plugins: [react(), csp(apiUrl)],
    define: { 'import.meta.env.VITE_LICENSE_API_URL': JSON.stringify(apiUrl) },
    build: { outDir: 'dist', sourcemap: false },
  };
});

import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';

export default defineConfig({
  site: 'https://dreptalk.com',
  output: 'server',
  adapter: cloudflare({
    // imageService 'compile' avoids requiring a Cloudflare Images binding at
    // runtime. The adapter 13 default changed to 'cloudflare-binding', which we
    // do not use; 'compile' keeps image handling self-contained in the build.
    imageService: 'compile',
    // Point Astro's built-in session store at our existing SESSIONS KV instead
    // of letting the adapter inject a separate default 'SESSION' binding. Our
    // own auth layer also uses SESSIONS; sharing the namespace is fine.
    sessionKVBindingName: 'SESSIONS',
  }),
  integrations: [react()],
  security: {
    // Content Security Policy for SSR responses. With the Cloudflare adapter,
    // Astro emits the policy as a real Content-Security-Policy response header
    // (not a <meta>), auto-generating SHA-256 hashes for its bundled and inline
    // scripts, i.e. the React island hydration runtime. That keeps script-src
    // strict (no 'unsafe-inline') while the islands still hydrate.
    //
    // The remaining security headers are set in src/middleware.ts, because
    // public/_headers does not apply to Worker-rendered responses on Workers
    // Static Assets. The middleware also relaxes style-src to 'self'
    // 'unsafe-inline': Astro always hash-pins its inline <style> blocks, which
    // disables 'unsafe-inline' for styles and would block the app's pervasive
    // inline style="" attributes (style-src-attr is not an option, as Safari
    // does not support it). Only script-src needs to be strict.
    csp: {
      directives: [
        "default-src 'self'",
        "connect-src 'self' https://cloudflareinsights.com",
        "img-src 'self' data:",
        "font-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ],
      scriptDirective: {
        // Override the default script-src sources: keep 'self' and also allow
        // the Cloudflare Web Analytics beacon origin. The per-build script
        // hashes are still appended automatically.
        resources: ["'self'", 'https://static.cloudflareinsights.com'],
      },
    },
  },
});

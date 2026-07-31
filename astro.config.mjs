import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';

// The theme-init script is inlined into <head> via set:html (see Layout.astro)
// so it runs before first paint without a render-blocking network request.
// Strict CSP has no 'unsafe-inline' for scripts, so pin this exact inline body
// with its own SHA-256 hash, computed here from the same file that gets inlined.
// Keeping it derived means editing theme-init.js cannot desync the hash.
const themeInitSource = readFileSync(
  fileURLToPath(new URL('./src/scripts/theme-init.js', import.meta.url)),
  'utf8',
);
const themeInitHash = `sha256-${createHash('sha256').update(themeInitSource).digest('base64')}`;

// Same approach for the governance-list sort preference script (persist/restore),
// inlined via set:html on the governance category page. Derived from the same
// file that gets inlined, so editing it cannot desync the CSP hash.
const govPrefsSource = readFileSync(
  fileURLToPath(new URL('./src/scripts/gov-prefs-restore.js', import.meta.url)),
  'utf8',
);
const govPrefsHash = `sha256-${createHash('sha256').update(govPrefsSource).digest('base64')}`;

// Same approach for the vote dashboard's filter/sort script, inlined via set:html
// on /vote. Derived from the same file that is inlined so editing it cannot desync
// the CSP hash.
const voteFiltersSource = readFileSync(
  fileURLToPath(new URL('./src/scripts/vote-filters.js', import.meta.url)),
  'utf8',
);
const voteFiltersHash = `sha256-${createHash('sha256').update(voteFiltersSource).digest('base64')}`;

// The voting-record filter + "show more" script, inlined via set:html on /vote.
// Derived from the inlined file so editing it cannot desync the CSP hash.
const voteRecordSource = readFileSync(
  fileURLToPath(new URL('./src/scripts/vote-record.js', import.meta.url)),
  'utf8',
);
const voteRecordHash = `sha256-${createHash('sha256').update(voteRecordSource).digest('base64')}`;

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
  // The registration page moved from /drep (too close to /dreps and the on-chain
  // /drep/<hash>.json documents) to /register-drep. Redirect so old links hold.
  redirects: {
    '/drep': '/register-drep',
  },
  vite: {
    // Pin React to a single instance. Astro's React islands load the renderer's
    // React through Vite's optimized deps (the ?v= query), while a component's
    // own `import { useState } from 'react'` can resolve to a second,
    // non-optimized copy when Vite re-optimizes mid-session (e.g. after editing
    // source files during `npm run dev`). Two React copies means an island's
    // useState reads a null dispatcher and the island crashes on hydration
    // ("Cannot read properties of null (reading 'useState')"), so it silently
    // disappears. dedupe forces one copy; optimizeDeps.include keeps React
    // pre-bundled consistently so renderer and islands share it. The production
    // build is unaffected (Rollup already bundles a single React).
    resolve: { dedupe: ['react', 'react-dom'] },
    optimizeDeps: {
      include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    },
    // The SSR dep optimizer runs a separate pass (deps_ssr). If it discovers
    // react-dom/server only on the first SSR request, it re-optimizes mid-flight
    // and the in-flight chunk URLs 404 ("file does not exist ... in the optimize
    // deps directory"), plus React briefly splits into two copies (null
    // dispatcher). Pre-including the server-side React entrypoints bundles them at
    // startup so no mid-session re-optimize happens. Dev-only; the prod build is
    // unaffected.
    ssr: {
      optimizeDeps: {
        include: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
      },
    },
  },
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
        //
        // 'unsafe-eval' is required for mobile wallet in-app browsers. Eternl on
        // iOS (and likely other mobile wallets) injects its CIP-30 provider via
        // eval/Function; a strict script-src without it blocks the injection, so
        // window.cardano never appears and login shows "no wallet detected" (only
        // on mobile, desktop extensions bypass page CSP via content scripts).
        // Confirmed on device: 'wasm-unsafe-eval' was not enough, full
        // 'unsafe-eval' is needed. This does NOT weaken inline-script protection:
        // the sha256 hashes below still gate inline <script>; 'unsafe-eval' only
        // permits eval/Function, never inline scripts.
        resources: ["'self'", 'https://static.cloudflareinsights.com', "'unsafe-eval'"],
        // Astro hashes its own bundled/inline scripts but not author is:inline
        // ones, so add the inlined script hashes explicitly.
        hashes: [themeInitHash, govPrefsHash, voteFiltersHash, voteRecordHash],
      },
    },
  },
});

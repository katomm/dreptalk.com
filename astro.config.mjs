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
});

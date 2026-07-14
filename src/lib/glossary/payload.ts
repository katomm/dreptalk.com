// Inline JSON payload for the GlossaryTerms component: term and description
// for every entry the term patterns can actually mark. The collection is
// immutable per deploy, so the string is built once per isolate instead of on
// every SSR render.
import { getCollection } from 'astro:content';
import { serializeJsonLd } from '../forum/view.js';
import { GLOSSARY_PATTERNS } from './patterns.js';

let cached: string | undefined;

export async function getGlossaryPayloadJson(): Promise<string> {
  if (!cached) {
    const keys = new Set(GLOSSARY_PATTERNS.map((p) => p.key));
    cached = serializeJsonLd(
      Object.fromEntries(
        (await getCollection('glossary'))
          .filter((e) => keys.has(e.id))
          .map((e) => [e.id, { term: e.data.term, description: e.data.description }]),
      ),
    );
  }
  return cached;
}

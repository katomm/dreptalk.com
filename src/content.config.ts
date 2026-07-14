import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { CATEGORY_ORDER } from './lib/help/categories.js';
import { GROUP_ORDER } from './lib/glossary/groups.js';

const guides = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/guides' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    cardLabel: z.string(),
    category: z.enum(CATEGORY_ORDER),
    order: z.number(),
    featured: z.boolean().default(false),
    updated: z.coerce.date().optional(),
    faqs: z.array(z.object({ q: z.string(), a: z.string() })).optional(),
  }),
});

const glossary = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/glossary' }),
  schema: z.object({
    term: z.string(),
    description: z.string(),
    group: z.enum(GROUP_ORDER),
    order: z.number(),
    updated: z.coerce.date().optional(),
  }),
});

export const collections = { guides, glossary };

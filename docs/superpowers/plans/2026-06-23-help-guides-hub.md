# Help Guides Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/help` into a learning hub whose pages are authored as Markdown guides in an Astro content collection, migrate the 9 existing articles, and add 4 new how-to guides for DReps and ADA holders.

**Architecture:** A `guides` content collection (Astro 6 content layer, `glob()` loader over `src/content/guides/*.md`) is the single source for help content. One SSR dynamic route `src/pages/help/[...slug].astro` renders any guide and generates breadcrumb/Article/FAQPage JSON-LD from frontmatter. The hub index, the client search palette (fed via props from the server, since it cannot call `getCollection`), and the sitemap all derive their entries from the collection. The old per-article `.astro` files and `src/lib/help/articles.ts` are removed.

**Tech Stack:** Astro 6.4 (SSR via `@astrojs/cloudflare` 13, `prerender = false`), Zod (bundled with Astro), Vitest 4, Biome (lint only). Plain Markdown, no MDX.

## Global Constraints

- Astro 6.4, `@astrojs/cloudflare` 13; all help routes stay SSR (`export const prerender = false`).
- URLs stay `/help/<slug>`; no existing slug changes, no redirects.
- No typographic dashes anywhere (content, code, comments): no `—` `–` `―` nor `&mdash;`/`&ndash;`/`&#8212;`/`&#8211;`/`&#x2014;`/`&#x2013;`. Use comma, colon, or "to" for ranges.
- Public repo: no internal references, no mention of SEO/optimization intent in code, commits, or content.
- Guide copy is English.
- Verification gates run `npm run typecheck` (astro check), `npm run lint` (biome lint), `npm run test` (vitest run), `npm run build`.
- Lint is `biome lint` only; never run `biome format` repo-wide.

---

## File Structure

**Create:**
- `src/content.config.ts` — `guides` collection definition + Zod frontmatter schema.
- `src/lib/help/categories.ts` — `CATEGORY_ORDER` constant (single source for category names and their display order).
- `src/lib/help/jsonld.ts` — pure builders for Breadcrumb / Article / FAQPage JSON-LD objects.
- `src/lib/help/jsonld.test.ts` — unit tests for the builders.
- `src/pages/help/[...slug].astro` — SSR dynamic route rendering one guide.
- `src/content/guides/*.md` — 13 guides (9 migrated + 4 new).

**Modify:**
- `src/pages/help/index.astro` — read the collection, group cards by category.
- `src/layouts/Layout.astro` — load guides, pass help entries to `SearchTrigger`.
- `src/components/search/SearchTrigger.tsx` — accept `helpEntries` prop, forward to palette.
- `src/components/search/SearchPalette.tsx` — accept `helpEntries`, match client-side.
- `src/lib/search/staticEntries.ts` — drop Help mapping (Pages only); export a generic `matchEntries`.
- `src/lib/search/staticEntries.test.ts` — update expectations.
- `src/pages/sitemap.xml.ts` — add guide URLs from the collection.

**Delete (after consumers are switched):**
- `src/lib/help/articles.ts`
- `src/pages/help/signing-in.astro`, `managing-your-drep.astro`, `data-freshness.astro`, `governance-statuses.astro`, `proposers.astro`, `sorting.astro`, `moderation.astro`, `badges.astro`, `open-source.astro`

---

## Frontmatter contract (used by every task)

Every `src/content/guides/<slug>.md` file has this frontmatter shape:

```yaml
---
title: "Managing your DRep: register, change metadata, get your deposit back"
description: "How to register as a Cardano DRep, change your on-chain metadata, and deregister to get your 500 ADA deposit back."
category: "For DReps"          # must be one of CATEGORY_ORDER
order: 1                        # sort within the category (ascending)
featured: false                # at most one guide is featured
updated: 2026-06-23             # optional; omit if not meaningful
cardLabel: "Managing your DRep" # short title for hub card + search + breadcrumb
faqs:                           # optional; drives FAQPage JSON-LD
  - q: "How do I register as a DRep on Cardano?"
    a: "Open Register as a DRep, connect a CIP-95 capable wallet ..."
---
```

`cardLabel` exists because page `title` is long/SEO-shaped, while cards, breadcrumbs, and search results want the short name (today's `HelpArticle.title`). The file's slug is its filename without `.md`.

---

### Task 1: JSON-LD builders

**Files:**
- Create: `src/lib/help/jsonld.ts`
- Test: `src/lib/help/jsonld.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `buildBreadcrumbLd(origin: string, slug: string, cardLabel: string): Record<string, unknown>`
  - `buildArticleLd(origin: string, slug: string, title: string, description: string, updated?: Date): Record<string, unknown>`
  - `buildFaqLd(faqs: { q: string; a: string }[]): Record<string, unknown> | null` (returns `null` for empty/undefined input)

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/help/jsonld.test.ts
import { describe, it, expect } from 'vitest';
import { buildBreadcrumbLd, buildArticleLd, buildFaqLd } from './jsonld.js';

const ORIGIN = 'https://dreptalk.com';

describe('buildBreadcrumbLd', () => {
  it('builds a 3-level breadcrumb to the guide', () => {
    const ld = buildBreadcrumbLd(ORIGIN, 'open-source', 'Open source') as any;
    expect(ld['@type']).toBe('BreadcrumbList');
    expect(ld.itemListElement).toHaveLength(3);
    expect(ld.itemListElement[2]).toMatchObject({
      position: 3,
      name: 'Open source',
      item: 'https://dreptalk.com/help/open-source',
    });
    expect(ld.itemListElement[1].item).toBe('https://dreptalk.com/help');
  });
});

describe('buildArticleLd', () => {
  it('builds an Article with url and headline', () => {
    const ld = buildArticleLd(ORIGIN, 'open-source', 'Open source - DRepTalk', 'Desc') as any;
    expect(ld['@type']).toBe('Article');
    expect(ld.headline).toBe('Open source - DRepTalk');
    expect(ld.description).toBe('Desc');
    expect(ld.url).toBe('https://dreptalk.com/help/open-source');
    expect(ld.inLanguage).toBe('en');
    expect('dateModified' in ld).toBe(false);
  });

  it('includes dateModified when updated is given', () => {
    const ld = buildArticleLd(ORIGIN, 'x', 'T', 'D', new Date('2026-06-23T00:00:00Z')) as any;
    expect(ld.dateModified).toBe('2026-06-23');
  });
});

describe('buildFaqLd', () => {
  it('returns null for empty input', () => {
    expect(buildFaqLd([])).toBeNull();
    expect(buildFaqLd(undefined as any)).toBeNull();
  });

  it('builds a FAQPage with Question/Answer entries', () => {
    const ld = buildFaqLd([{ q: 'Q1', a: 'A1' }]) as any;
    expect(ld['@type']).toBe('FAQPage');
    expect(ld.mainEntity[0]).toMatchObject({
      '@type': 'Question',
      name: 'Q1',
      acceptedAnswer: { '@type': 'Answer', text: 'A1' },
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/help/jsonld.test.ts`
Expected: FAIL (`Cannot find module './jsonld.js'`).

- [ ] **Step 3: Implement the builders**

```ts
// src/lib/help/jsonld.ts
// Pure JSON-LD builders for help guides. Kept free of Astro APIs so they are
// unit-testable and reused by the guide route.

export interface Faq {
  q: string;
  a: string;
}

// ISO date without the time part, e.g. "2026-06-23".
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function buildBreadcrumbLd(origin: string, slug: string, cardLabel: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'DRepTalk', item: `${origin}/` },
      { '@type': 'ListItem', position: 2, name: 'Help', item: `${origin}/help` },
      { '@type': 'ListItem', position: 3, name: cardLabel, item: `${origin}/help/${slug}` },
    ],
  };
}

export function buildArticleLd(
  origin: string,
  slug: string,
  title: string,
  description: string,
  updated?: Date,
): Record<string, unknown> {
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description,
    url: `${origin}/help/${slug}`,
    inLanguage: 'en',
    publisher: { '@type': 'Organization', name: 'DRepTalk', url: origin },
  };
  if (updated) ld.dateModified = isoDate(updated);
  return ld;
}

export function buildFaqLd(faqs: Faq[] | undefined): Record<string, unknown> | null {
  if (!faqs || faqs.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/help/jsonld.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/help/jsonld.ts src/lib/help/jsonld.test.ts
git commit -m "feat: add help guide JSON-LD builders"
```

---

### Task 2: Collection config, categories constant, dynamic route, featured guide migrated

This task stands up the whole rendering pipeline and proves it with the featured article (`managing-your-drep`, which also exercises FAQPage). After it, the featured guide is served from Markdown and the 8 other `.astro` articles still work (a specific `.astro` route wins over the `[...slug]` rest route).

**Files:**
- Create: `src/lib/help/categories.ts`
- Create: `src/content.config.ts`
- Create: `src/pages/help/[...slug].astro`
- Create: `src/content/guides/managing-your-drep.md`
- Delete: `src/pages/help/managing-your-drep.astro`

**Interfaces:**
- Consumes: `buildBreadcrumbLd`, `buildArticleLd`, `buildFaqLd` from Task 1.
- Produces:
  - `CATEGORY_ORDER: readonly string[]` from `src/lib/help/categories.ts`
  - collection name `guides` with the frontmatter schema (fields per the Frontmatter contract).

- [ ] **Step 1: Create the categories constant**

```ts
// src/lib/help/categories.ts
// The hub's category buckets, in display order. Also the allowed values for a
// guide's `category` frontmatter, so a typo fails the build instead of dropping
// a guide into an unrendered group.
export const CATEGORY_ORDER = [
  'Start here',
  'For DReps',
  'Understanding governance',
  'About DRepTalk',
] as const;

export type Category = (typeof CATEGORY_ORDER)[number];
```

- [ ] **Step 2: Create the collection config**

```ts
// src/content.config.ts
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { CATEGORY_ORDER } from './lib/help/categories.js';

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

export const collections = { guides };
```

- [ ] **Step 3: Create the dynamic route**

```astro
---
// src/pages/help/[...slug].astro
export const prerender = false;

import { getEntry, render } from 'astro:content';
import HelpLayout from '@/layouts/HelpLayout.astro';
import JsonLd from '@/components/JsonLd.astro';
import { buildBreadcrumbLd, buildArticleLd, buildFaqLd } from '@/lib/help/jsonld.js';

const { slug } = Astro.params;
const entry = slug ? await getEntry('guides', slug) : undefined;
if (!entry) return new Response('Not found', { status: 404 });

const { Content } = await render(entry);
const d = entry.data;
const origin = Astro.site?.origin ?? 'https://dreptalk.com';

const breadcrumbLd = buildBreadcrumbLd(origin, entry.id, d.cardLabel);
const articleLd = buildArticleLd(origin, entry.id, d.title, d.description, d.updated);
const faqLd = buildFaqLd(d.faqs);

// Public help pages: cache at the edge but keep them reasonably fresh.
Astro.response.headers.set('Cache-Control', 'public, max-age=300, s-maxage=3600');
---

<HelpLayout title={`${d.title} - DRepTalk`} description={d.description} crumb={d.cardLabel}>
  <JsonLd data={breadcrumbLd} />
  <JsonLd data={articleLd} />
  {faqLd && <JsonLd data={faqLd} />}

  {d.updated && (
    <p class="guide-updated">Last updated {d.updated.toISOString().slice(0, 10)}</p>
  )}

  <article class="prose">
    <Content />
  </article>
</HelpLayout>

<style>
  .guide-updated {
    margin: 0 0 1.25rem;
    font-size: 0.8125rem;
    color: var(--muted);
  }
  .prose {
    max-width: 64ch;
  }
  .prose :global(p),
  .prose :global(li) {
    color: var(--muted);
    line-height: 1.65;
    font-size: 0.9375rem;
  }
  .prose :global(h2) {
    margin: 1.75rem 0 0.5rem;
    font-size: 1.0625rem;
    color: var(--fg);
  }
  .prose :global(h3) {
    margin: 1.25rem 0 0.4rem;
    font-size: 0.9875rem;
    color: var(--fg);
  }
  .prose :global(a) {
    color: var(--accent);
  }
  .prose :global(ul),
  .prose :global(ol) {
    padding-left: 1.25rem;
  }
  .prose :global(li) {
    margin: 0.3rem 0;
  }
  .prose :global(strong) {
    color: var(--fg);
  }
  .prose :global(code) {
    font-size: 0.85em;
    background: color-mix(in srgb, var(--fg) 8%, transparent);
    padding: 0.1em 0.35em;
    border-radius: 4px;
  }
</style>
```

- [ ] **Step 4: Migrate the featured guide to Markdown**

Port the visible prose of `src/pages/help/managing-your-drep.astro` (lines 79 to 153) into Markdown body, and move its 5 FAQ objects (the `faqLd.mainEntity` array, lines 16 to 57) into the frontmatter `faqs` field. Convert each `<section><h2>` to a `##` heading, each `<a href>` to a Markdown link, each `<strong>` to `**bold**`. The `cardLabel` and short `description` come from today's `HELP_ARTICLES` entry for this href.

```markdown
---
title: "Managing your DRep: register, change metadata, get your deposit back"
description: "How to register as a Cardano DRep, change your on-chain metadata (name, bio, links, image), and deregister to get your 500 ADA deposit back. Step by step and non-custodial: your wallet signs every transaction."
cardLabel: "Managing your DRep"
category: "For DReps"
order: 1
featured: true
faqs:
  - q: "How do I register as a DRep on Cardano?"
    a: "Open Register as a DRep, connect a CIP-95 capable wallet (for example Lace, Eternl, or Typhon), and fill in your profile: name, a short bio, links, and an optional image. Your wallet submits the registration certificate. Registering locks a refundable 500 ADA deposit plus a small network fee; the deposit is returned in full when you later deregister."
  - q: "How do I change my DRep metadata?"
    a: "Sign in as a DRep and open Settings. The form is prefilled with your current on-chain profile (name, bio, links, image). Edit it and submit; your wallet signs an update certificate that points to the new metadata. The change is on the chain as soon as the transaction confirms, and wallets and explorers show it after their next sync."
  - q: "How much does it cost to update my DRep metadata?"
    a: "Updating your metadata has no deposit. Your wallet pays only the small Cardano network fee. The 500 ADA deposit is only locked once, at registration, and stays locked until you deregister."
  - q: "How do I get my 500 ADA DRep deposit back?"
    a: "The 500 ADA deposit is refunded automatically when you deregister (retire) your DRep. Sign in as a DRep, open Settings, and use Retire DRep. Your wallet submits a deregistration certificate, and the full deposit is returned to your wallet once the transaction confirms."
  - q: "Does retiring my DRep delete my DRepTalk forum account?"
    a: "No. Deregistering is an on-chain action only. It retires your DRep on Cardano and refunds your deposit, but it does not delete your DRepTalk forum account, your posts, or your profile page."
---

DRepTalk can submit the three on-chain DRep lifecycle actions for you:
registering, changing your metadata, and deregistering (which returns your
deposit). All of them are **non-custodial**: dreptalk.com never sees your keys;
your wallet signs and submits each transaction, so you always confirm the exact
certificate and cost in your wallet. You need a CIP-95 capable wallet (for
example Lace, Eternl, or Typhon).

## How do I register as a DRep on Cardano?

Go to [Register as a DRep](/register-drep), connect your wallet, and fill in
your profile: name, a short bio, links, and an optional profile image (JPG or
PNG, up to 256 KB). DRepTalk hosts this as a CIP-119 metadata document and your
wallet submits the registration certificate pointing at it. Registration locks a
**refundable 500 ADA deposit** plus a small network fee; the deposit comes back
in full when you later deregister.

## How do I set up or change my DRep metadata?

Your on-chain metadata is what wallets, explorers, and DRepTalk show to
delegators. If yours is outdated, or you registered without any, sign in as a
DRep and open [Settings](/settings). The form is prefilled with your current
on-chain profile; edit the name, bio, or links, upload an image if you like, and
submit. Your wallet signs an update certificate that points to the new document.
There is **no deposit** for updates, only the small network fee.

The change is on the chain as soon as the transaction confirms; DRepTalk and
other sites show it after their next sync (on DRepTalk, within about an hour).

## How do I get my 500 ADA DRep deposit back?

The 500 ADA you locked when you registered is refunded automatically when you
**deregister** (retire) your DRep. Sign in as a DRep, open [Settings](/settings),
and use **Retire DRep** in the danger zone. Your wallet submits a deregistration
certificate, and the full deposit is returned to your wallet once the transaction
confirms. There is no separate withdrawal step and no extra deposit; you pay only
the small network fee for the transaction.

## How do I retire (deregister) my DRep?

Retiring is done from [Settings](/settings). It submits a deregistration
certificate to the chain: your 500 ADA deposit is refunded once it confirms, and
everyone who delegated their voting power to you loses that delegation. You can
register again later, but delegators would need to delegate to you again.

Retiring is an **on-chain action only**. It does not delete your DRepTalk forum
account, your posts, or your profile page.

## What these actions never do

None of them move your funds beyond the shown deposit and fee, and none ask for a
seed phrase or private key. Your wallet shows you the certificate and the exact
cost before anything is submitted; if something looks different, reject it.

## Related

- [How to become a DRep](/help/become-a-drep)
- [Writing a vote rationale](/help/writing-a-vote-rationale)
```

- [ ] **Step 5: Delete the migrated `.astro` file**

```bash
git rm src/pages/help/managing-your-drep.astro
```

- [ ] **Step 6: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed. (`/help/managing-your-drep` now resolves through `[...slug].astro`.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/help/categories.ts src/content.config.ts src/pages/help/'[...slug].astro' src/content/guides/managing-your-drep.md
git commit -m "feat: render help guides from a markdown collection"
```

---

### Task 3: Migrate the 8 remaining articles to Markdown

**Files:**
- Create: `src/content/guides/signing-in.md`, `data-freshness.md`, `governance-statuses.md`, `proposers.md`, `sorting.md`, `moderation.md`, `badges.md`, `open-source.md`
- Delete: the matching 8 `src/pages/help/*.astro` files

**Interfaces:**
- Consumes: collection schema and route from Task 2.
- Produces: 8 more entries in the `guides` collection.

For each article, read its `.astro` source under `src/pages/help/<slug>.astro`, port the visible prose to Markdown body (`<section><h2>` to `##`, `<a href>` to Markdown links, `<strong>` to `**`), and take `cardLabel` + `description` from that href's entry in `src/lib/help/articles.ts`. Use these frontmatter values:

| slug | category | order | cardLabel |
|------|----------|-------|-----------|
| signing-in | Start here | 3 | Signing in |
| data-freshness | About DRepTalk | 4 | Data freshness |
| governance-statuses | Understanding governance | 2 | Governance action statuses |
| proposers | Understanding governance | 4 | Proposers |
| sorting | Understanding governance | 3 | Sorting governance actions |
| moderation | About DRepTalk | 2 | Moderation |
| badges | About DRepTalk | 3 | Badges |
| open-source | About DRepTalk | 1 | Open source |

`title` for each: reuse the existing `<HelpLayout title=...>` value from the source `.astro` (already SEO-shaped) but without the trailing ` - DRepTalk` (the route appends it). `description`: reuse the existing `<HelpLayout description=...>`. Carry over any existing `faqs` (only `managing-your-drep` had them, already migrated). Add a short `## Related` list of 2 to 3 adjacent guides at the end of each.

- [ ] **Step 1: Create the 8 Markdown files** per the table and porting rules above.

- [ ] **Step 2: Delete the 8 migrated `.astro` files**

```bash
git rm src/pages/help/signing-in.astro src/pages/help/data-freshness.astro \
  src/pages/help/governance-statuses.astro src/pages/help/proposers.astro \
  src/pages/help/sorting.astro src/pages/help/moderation.astro \
  src/pages/help/badges.astro src/pages/help/open-source.astro
```

- [ ] **Step 3: Verify no help `.astro` articles remain** (only `index.astro` and `[...slug].astro`)

Run: `ls src/pages/help`
Expected: exactly `[...slug].astro` and `index.astro`.

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed. Note: at this point `index.astro`, `staticEntries.ts`, and `sitemap.xml.ts` still import `articles.ts` (which still exists), so the build stays green.

- [ ] **Step 5: Commit**

```bash
git add src/content/guides
git commit -m "feat: migrate remaining help articles to markdown"
```

---

### Task 4: Switch the hub index to the collection

**Files:**
- Modify: `src/pages/help/index.astro`

**Interfaces:**
- Consumes: `getCollection('guides')`, `CATEGORY_ORDER`.
- Produces: a hub that groups cards by category and renders the featured guide full-width.

- [ ] **Step 1: Rewrite the index frontmatter and markup**

Replace the `articles.ts` import and the flat `PAGES` list with a category-grouped read of the collection. Keep all existing `<style>` rules; add the group-heading styles shown.

```astro
---
export const prerender = false;

import Layout from '@/layouts/Layout.astro';
import { getCollection } from 'astro:content';
import { CATEGORY_ORDER } from '@/lib/help/categories.js';

Astro.response.headers.set('Cache-Control', 'public, max-age=300, s-maxage=3600');

const guides = await getCollection('guides');
const featured = guides.find((g) => g.data.featured);

// Group the non-featured guides by category, preserving CATEGORY_ORDER and
// sorting within each group by `order`.
const groups = CATEGORY_ORDER.map((cat) => ({
  category: cat,
  items: guides
    .filter((g) => g.data.category === cat && !g.data.featured)
    .sort((a, b) => a.data.order - b.data.order),
})).filter((grp) => grp.items.length > 0);
---

<Layout title="Help - DRepTalk" description="DRepTalk help and guides: becoming a DRep, delegating, governance actions, and how DRepTalk works.">
  <nav style="font-size:0.875rem;color:var(--muted);margin-bottom:1rem;">
    <a href="/">DRepTalk</a>
    <span style="margin:0 0.375rem;">/</span>
    <span>Help</span>
  </nav>

  <h1 style="margin:0 0 0.5rem;">Help</h1>
  <p class="help-lede">
    Guides and short pages on becoming a DRep, delegating your voting power,
    Cardano governance, and how DRepTalk works.
  </p>

  {featured && (
    <a href={`/help/${featured.id}`} class="help-card help-card--featured reveal" style="--reveal-delay:60ms">
      <span class="help-card__body">
        <span class="help-card__head">
          <span class="help-card__title">{featured.data.cardLabel}</span>
          <span class="help-card__flag">Getting started</span>
        </span>
        <p class="help-card__text">{featured.data.description}</p>
      </span>
      <svg class="help-card__chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
    </a>
  )}

  {groups.map((grp) => (
    <section class="help-group">
      <h2 class="help-group__title">{grp.category}</h2>
      <div class="help-list">
        {grp.items.map((g, i) => (
          <a href={`/help/${g.id}`} class="help-card reveal" style={`--reveal-delay:${60 + i * 60}ms`}>
            <span class="help-card__body">
              <span class="help-card__head">
                <span class="help-card__title">{g.data.cardLabel}</span>
              </span>
              <p class="help-card__text">{g.data.description}</p>
            </span>
            <svg class="help-card__chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
          </a>
        ))}
      </div>
    </section>
  ))}
</Layout>
```

Keep the existing `<style>` block from the current file unchanged, and add these rules to it:

```css
  .help-group {
    margin-top: 2rem;
  }
  .help-group__title {
    margin: 0 0 0.75rem;
    font-size: 0.8125rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .help-list {
    margin-top: 0;
  }
  .help-card--featured {
    margin-top: 1.25rem;
  }
```

(The featured card no longer lives inside `.help-list`, so the existing
`grid-column: 1 / -1` rule is harmless; leave it.)

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 3: Visually confirm the hub** (optional local check)

Run: `npm run dev`, open `http://localhost:4321/help`, confirm groups render with the featured card on top. Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add src/pages/help/index.astro
git commit -m "feat: group help hub by category from the collection"
```

---

### Task 5: Feed the search palette from the collection

The client palette cannot call `getCollection`, so the server (`Layout.astro`) loads the guides and passes them down to the island as a prop.

**Files:**
- Modify: `src/lib/search/staticEntries.ts`
- Modify: `src/lib/search/staticEntries.test.ts`
- Modify: `src/layouts/Layout.astro`
- Modify: `src/components/search/SearchTrigger.tsx`
- Modify: `src/components/search/SearchPalette.tsx`

**Interfaces:**
- Consumes: `getCollection('guides')` (server), `matchEntries` (new).
- Produces:
  - `interface HelpEntry { label: string; href: string; keywords: string }`
  - `matchEntries<T extends { label: string; keywords: string }>(entries: readonly T[], q: string): T[]`
  - `matchStaticEntries(q)` keeps its signature but now returns Pages only.
  - `SearchTrigger` and `SearchPalette` accept `helpEntries: HelpEntry[]`.

- [ ] **Step 1: Update `staticEntries.ts` (drop Help, add `matchEntries`)**

```ts
// Static palette entries: top-level pages. Help entries are passed in from the
// server (they come from the guides content collection, which is server-only).
import { NAV_LINKS } from '../config/nav.js';

export interface StaticEntry {
  group: 'Pages' | 'Help';
  label: string;
  href: string;
  keywords: string;
}

export interface HelpEntry {
  label: string;
  href: string;
  keywords: string;
}

const PAGE_KEYWORDS: Record<string, string> = {
  '/dreps': 'delegate representatives directory voting power',
  '/c/governance-actions': 'proposals votes ga',
  '/discussions': 'forum topics threads',
};

export const STATIC_ENTRIES: readonly StaticEntry[] = [
  { group: 'Pages', label: 'Home', href: '/', keywords: 'home start dreptalk' },
  ...NAV_LINKS.map((l): StaticEntry => ({ group: 'Pages', label: l.label, href: l.href, keywords: PAGE_KEYWORDS[l.href] ?? '' })),
  { group: 'Pages', label: 'Help', href: '/help', keywords: 'documentation guide faq guides' },
];

/** Case-insensitive label/keyword filter; empty query returns everything. */
export function matchEntries<T extends { label: string; keywords: string }>(entries: readonly T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter(
    (e) => e.label.toLowerCase().includes(needle) || e.keywords.toLowerCase().includes(needle),
  );
}

/** Pages-group static entries matching the query. */
export function matchStaticEntries(q: string): StaticEntry[] {
  return matchEntries(STATIC_ENTRIES, q);
}
```

- [ ] **Step 2: Update `staticEntries.test.ts`**

Replace the old expectations (which assumed Help entries lived in `STATIC_ENTRIES`) with these:

```ts
import { describe, it, expect } from 'vitest';
import { matchStaticEntries, matchEntries, STATIC_ENTRIES } from './staticEntries.js';

describe('matchStaticEntries', () => {
  it('empty query returns all static (Pages) entries', () => {
    expect(matchStaticEntries('')).toEqual([...STATIC_ENTRIES]);
  });

  it('matches a page by keyword', () => {
    const hits = matchStaticEntries('directory');
    expect(hits.some((e) => e.href === '/dreps')).toBe(true);
  });

  it('only contains Pages entries now', () => {
    expect(STATIC_ENTRIES.every((e) => e.group === 'Pages')).toBe(true);
  });

  it('no match returns empty', () => {
    expect(matchStaticEntries('zzzzzz')).toEqual([]);
  });
});

describe('matchEntries', () => {
  const help = [
    { label: 'Open source', href: '/help/open-source', keywords: 'apache license github' },
    { label: 'Badges', href: '/help/badges', keywords: 'achievement bronze silver gold' },
  ];

  it('empty query returns all', () => {
    expect(matchEntries(help, '')).toEqual([...help]);
  });

  it('matches by keyword', () => {
    expect(matchEntries(help, 'apache')).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the search tests**

Run: `npx vitest run src/lib/search/staticEntries.test.ts`
Expected: PASS.

- [ ] **Step 4: Pass help entries from `Layout.astro`**

In `src/layouts/Layout.astro`, add to the frontmatter (top, after existing imports):

```ts
import { getCollection } from 'astro:content';
import type { HelpEntry } from '@/lib/search/staticEntries.js';

const helpEntries: HelpEntry[] = (await getCollection('guides'))
  .map((g) => ({ label: g.data.cardLabel, href: `/help/${g.id}`, keywords: g.data.description }))
  .sort((a, b) => a.label.localeCompare(b.label));
```

Then change the mount at line 128 from `<SearchTrigger client:idle />` to:

```astro
<SearchTrigger client:idle helpEntries={helpEntries} />
```

- [ ] **Step 5: Thread the prop through `SearchTrigger.tsx`**

Add a typed prop and forward it to the palette:

```tsx
import type { HelpEntry } from '@/lib/search/staticEntries.js';

interface TriggerProps {
  helpEntries: HelpEntry[];
}

export default function SearchTrigger({ helpEntries }: TriggerProps) {
```

And update the palette render (line ~73):

```tsx
<SearchPalette open={open} onClose={() => setOpen(false)} returnFocusRef={btnRef} helpEntries={helpEntries} />
```

- [ ] **Step 6: Consume the prop in `SearchPalette.tsx`**

Change the import to also pull `matchEntries` and `HelpEntry`:

```tsx
import { matchStaticEntries, matchEntries, type HelpEntry } from '@/lib/search/staticEntries.js';
```

Add `helpEntries` to `PaletteProps`:

```tsx
interface PaletteProps {
  open: boolean;
  onClose: () => void;
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>;
  helpEntries: HelpEntry[];
}
```

`buildRows` needs the help entries, so give it a parameter and use it. Change the signature and the static-entries loop:

```tsx
function buildRows(q: string, data: SearchResponseBody | null, helpEntries: HelpEntry[]): Row[] {
  // ... unchanged body until the static-entries loop ...
  for (const e of matchStaticEntries(q)) {
    rows.push({ key: `static-${e.href}`, href: e.href, group: e.group, label: e.label });
  }
  for (const e of matchEntries(helpEntries, q)) {
    rows.push({ key: `help-${e.href}`, href: e.href, group: 'Help', label: e.label });
  }
  return rows;
}
```

Find the `buildRows(...)` call site in the component (inside the `useMemo` that builds rows) and pass `helpEntries`:

```tsx
const rows = useMemo(() => buildRows(deferredQuery, data, helpEntries), [deferredQuery, data, helpEntries]);
```

(Match the existing variable names at the call site; the key change is adding `helpEntries` as the third argument and to the dependency array. Destructure `helpEntries` from props at the top of the component.)

- [ ] **Step 7: Typecheck, lint, build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all succeed.

- [ ] **Step 8: Commit**

```bash
git add src/lib/search/staticEntries.ts src/lib/search/staticEntries.test.ts src/layouts/Layout.astro src/components/search/SearchTrigger.tsx src/components/search/SearchPalette.tsx
git commit -m "feat: source help search entries from the guides collection"
```

---

### Task 6: Add guides to the sitemap and remove `articles.ts`

**Files:**
- Modify: `src/pages/sitemap.xml.ts`
- Delete: `src/lib/help/articles.ts`

**Interfaces:**
- Consumes: `getCollection('guides')`.
- Produces: `/help` and every `/help/<slug>` in the sitemap.

- [ ] **Step 1: Add the help hub and guides to the sitemap**

In `src/pages/sitemap.xml.ts`, import the collection helper at the top:

```ts
import { getCollection } from 'astro:content';
```

Then extend the static `entries` array (after the `/badges` line) with the hub and the guides:

```ts
    { path: '/help' },
    ...(await getCollection('guides')).map((g) => ({
      path: `/help/${g.id}`,
      ...(g.data.updated ? { lastmod: g.data.updated.toISOString() } : {}),
    })),
```

- [ ] **Step 2: Confirm `articles.ts` has no importers left**

Run: `grep -rn "help/articles" src/`
Expected: no matches (index, search, and sitemap have all moved off it).

- [ ] **Step 3: Delete `articles.ts`**

```bash
git rm src/lib/help/articles.ts
```

- [ ] **Step 4: Typecheck, lint, build, full test run**

Run: `npm run typecheck && npm run lint && npm run test && npm run build`
Expected: all succeed.

- [ ] **Step 5: Commit**

```bash
git add src/pages/sitemap.xml.ts
git commit -m "feat: list help guides in the sitemap"
```

---

### Task 7: New guide, become a DRep

**Files:**
- Create: `src/content/guides/become-a-drep.md`

**Interfaces:**
- Consumes: collection schema.
- Produces: guide at `/help/become-a-drep`, category "Start here".

This guide targets the beginner, informational question ("what is a DRep, how do I become one"). It must NOT duplicate `managing-your-drep` (the operational reference): keep it conceptual and orienting, and link out to `managing-your-drep` for the exact register/update/retire mechanics.

- [ ] **Step 1: Write the file**

Frontmatter:

```yaml
---
title: "How to become a DRep on Cardano"
description: "What a DRep is, what the role involves, which wallet you need, and how to register, in plain terms for first-time delegated representatives."
cardLabel: "How to become a DRep"
category: "Start here"
order: 1
featured: false
updated: 2026-06-23
---
```

Body must cover, as `##` sections with prose (write full sentences, no dashes):

1. **What is a DRep?** A delegated representative who votes on Cardano governance actions on behalf of ADA holders who delegate their voting power to them. Voting power equals the stake delegated, not the DRep's own balance.
2. **What the role involves.** Reviewing governance actions, voting (Yes / No / Abstain), and ideally publishing a rationale. Note that DRepTalk is where DReps can discuss and post rationales.
3. **What you need.** A CIP-95 capable wallet (Lace, Eternl, or Typhon), a small amount of ADA for fees, and a refundable 500 ADA deposit.
4. **Steps to register.** Brief ordered list: connect wallet, fill profile (name, bio, links, image), submit registration. Then link to [Managing your DRep](/help/managing-your-drep) for the full mechanics, costs, and how to change or retire later.
5. **After you register.** Delegators can find and delegate to you; you can start voting. Keep your metadata current.

End with:

```markdown
## Related

- [Managing your DRep](/help/managing-your-drep)
- [How to delegate to a DRep](/help/delegate-to-a-drep)
- [Writing a vote rationale](/help/writing-a-vote-rationale)
```

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed; `/help/become-a-drep` resolves.

- [ ] **Step 3: Commit**

```bash
git add src/content/guides/become-a-drep.md
git commit -m "feat: add guide on becoming a DRep"
```

---

### Task 8: New guide, delegate to a DRep

**Files:**
- Create: `src/content/guides/delegate-to-a-drep.md`

**Interfaces:**
- Produces: guide at `/help/delegate-to-a-drep`, category "Start here".

Audience: any ADA holder, not only DReps. Plain language.

- [ ] **Step 1: Write the file**

Frontmatter:

```yaml
---
title: "How to delegate your voting power to a DRep"
description: "How any ADA holder hands their Cardano voting power to a DRep, what Abstain and No Confidence mean, and how to switch DReps later."
cardLabel: "Delegating to a DRep"
category: "Start here"
order: 2
featured: false
updated: 2026-06-23
---
```

Body, `##` sections:

1. **What delegating voting power means.** Your ADA stays in your wallet; you only hand the *voting power* to a DRep, who then votes on governance actions for you. It is separate from staking your ADA to a stake pool; you can do both.
2. **Choosing a DRep.** Browse the [DRep directory](/dreps); look at their profile, activity, and rationales. There is no lock-in.
3. **How to delegate.** Short ordered list done in a CIP-95 capable wallet (Lace, Eternl, or Typhon): open the wallet's governance or voting section, pick a DRep (by DRep ID or from a list), confirm the transaction. Only a small network fee, no deposit.
4. **Abstain and No Confidence.** Two special options instead of a specific DRep. "Always Abstain" counts your stake as present but not taking a side. "No Confidence" votes against the current governance setup on every action. Explain when each makes sense.
5. **Switching or changing later.** You can re-delegate to a different DRep at any time; the latest delegation wins. There is nothing to withdraw.

End with:

```markdown
## Related

- [How to become a DRep](/help/become-a-drep)
- [Governance action types](/help/governance-action-types)
```

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add src/content/guides/delegate-to-a-drep.md
git commit -m "feat: add guide on delegating to a DRep"
```

---

### Task 9: New guide, governance action types

**Files:**
- Create: `src/content/guides/governance-action-types.md`

**Interfaces:**
- Produces: guide at `/help/governance-action-types`, category "Understanding governance".

Cover the CIP-1694 / Conway governance action types. Keep the per-type voting requirements at a clear, high level; the fact-check task (Task 11) verifies the exact thresholds and voter combinations against current rules.

- [ ] **Step 1: Write the file**

Frontmatter:

```yaml
---
title: "Cardano governance action types explained"
description: "The kinds of on-chain governance actions on Cardano, what each one does, and which bodies (DReps, SPOs, the Constitutional Committee) vote on them."
cardLabel: "Governance action types"
category: "Understanding governance"
order: 1
featured: false
updated: 2026-06-23
---
```

Body: a short intro, then one `##` per action type, each 2 to 4 sentences (what it does, who votes). The seven types:

1. **Motion of no confidence** (state the chain has lost confidence in the committee).
2. **Update the constitutional committee and/or its threshold** (add/remove members, change the threshold).
3. **New constitution or guardrails script** (adopt a new constitution document or guardrails).
4. **Hard fork initiation** (move to a new protocol major version; voted on by SPOs and DReps).
5. **Protocol parameter changes** (adjust on-chain parameters).
6. **Treasury withdrawals** (move ADA out of the treasury to a stake address).
7. **Info action** (non-binding; records on-chain opinion, no parameters change, no thresholds enforced).

Then a `## Who votes` section summarizing the three bodies (DReps, SPOs, Constitutional Committee) and that different action types need different combinations of their approval. Keep specifics general and flag that exact thresholds are set by protocol parameters.

End with:

```markdown
## Related

- [Governance action statuses](/help/governance-statuses)
- [Writing a vote rationale](/help/writing-a-vote-rationale)
```

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add src/content/guides/governance-action-types.md
git commit -m "feat: add guide on governance action types"
```

---

### Task 10: New guide, writing a vote rationale

**Files:**
- Create: `src/content/guides/writing-a-vote-rationale.md`

**Interfaces:**
- Produces: guide at `/help/writing-a-vote-rationale`, category "For DReps".

- [ ] **Step 1: Write the file**

Frontmatter:

```yaml
---
title: "How to write a DRep vote rationale"
description: "How a DRep writes a clear, useful rationale for a governance vote, what to include, and how it is published as on-chain metadata."
cardLabel: "Writing a vote rationale"
category: "For DReps"
order: 2
featured: false
updated: 2026-06-23
---
```

Body, `##` sections:

1. **What a rationale is.** A short written explanation of why you voted the way you did, attached to your vote as metadata so delegators and the community can see your reasoning.
2. **Why it matters.** Builds trust with delegators, creates a public record, and helps others weigh the action.
3. **What to include.** Your position (Yes / No / Abstain), the key reasons, any concerns or conditions, and links to supporting discussion. Keep it specific to the action.
4. **A simple structure.** Suggest: one-line summary of your vote, two or three reasons, optional concerns, optional links. Plain language over jargon.
5. **How it is published.** The rationale is recorded as a metadata document linked to your vote following the community standard (CIP-100), most commonly as a single comment field. Most rationales are short; a paragraph or two is enough.

End with:

```markdown
## Related

- [Governance action types](/help/governance-action-types)
- [Managing your DRep](/help/managing-your-drep)
```

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add src/content/guides/writing-a-vote-rationale.md
git commit -m "feat: add guide on writing a vote rationale"
```

---

### Task 11: Fact-check pass over all guides

A required verification gate from the spec. Review every guide for factual correctness, not just the new four.

**Files:**
- Modify: any `src/content/guides/*.md` that contains an error.

- [ ] **Step 1: Review each guide against current Cardano governance rules and the actual app behavior.** For each of the 13 guides, check claims against authoritative sources (CIP-1694, the Conway-era rules, CIP-95, CIP-100, CIP-119) and against what DRepTalk actually does (cross-check Settings, register flow, sorting, moderation, badges, data freshness against the codebase). Pay special attention to:
  - `governance-action-types`: the seven types, and which bodies vote on each.
  - `delegate-to-a-drep`: the meaning of Abstain vs No Confidence.
  - `become-a-drep` and `managing-your-drep`: the 500 ADA deposit, CIP-95 wallets, fees.
  - `writing-a-vote-rationale`: CIP-100 metadata, comment field dominant.
  - `data-freshness`: refresh intervals match the real sync cadence.

- [ ] **Step 2: Fix any inaccuracies inline** in the relevant `.md` files. Keep the no-dashes rule.

- [ ] **Step 3: Verify no typographic dashes slipped into content**

Run: `grep -rnE "—|–|―|&mdash;|&ndash;|&#8212;|&#8211;|&#x2014;|&#x2013;" src/content/guides`
Expected: no matches.

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 5: Commit (only if anything changed)**

```bash
git add src/content/guides
git commit -m "fix: correct help guide content after review"
```

---

### Task 12: Chrome MCP walkthrough, desktop and mobile

A required verification gate from the spec. Drive the running site through the Chrome DevTools MCP and confirm every guide and the hub render correctly on both viewports.

**Files:** none (verification only; fixes loop back to the relevant file if needed).

- [ ] **Step 1: Start the local server**

Run: `npm run dev` (note the URL, typically `http://localhost:4321`).

- [ ] **Step 2: Desktop walkthrough.** Using the Chrome DevTools MCP at a desktop viewport (for example 1280x800): open `/help`, confirm the category groups and the featured card. Click into all 13 guides; for each confirm the heading, breadcrumb (`DRepTalk / Help / <cardLabel>`), body readability, working internal links, and the "Related" list. Open the search palette and confirm help guides appear and navigate correctly.

- [ ] **Step 3: Mobile walkthrough.** Switch the Chrome DevTools MCP to a mobile viewport (for example 390x844): repeat the hub check (single-column cards) and spot-check at least the 4 new guides plus the featured guide for layout, tap targets, and no overflow.

- [ ] **Step 4: Record findings and fix.** Note any layout or content issues; fix them in the relevant file (guide `.md`, `index.astro`, or `[...slug].astro` styles) and re-verify in Chrome. Stop the dev server when done.

- [ ] **Step 5: Final full verification and commit any fixes**

Run: `npm run typecheck && npm run lint && npm run test && npm run build`
Expected: all succeed.

```bash
git add -A
git commit -m "fix: polish help guides after cross-device review"
```

---

## Self-Review notes

- **Spec coverage:** evergreen hub (Task 4), URLs unchanged (route at `/help/[...slug]`, Tasks 2 to 3), Markdown collection + schema (Task 2), JSON-LD Breadcrumb/Article/FAQPage and no HowTo (Task 1, wired in Task 2), 9 migrations (Tasks 2 to 3), 4 new guides (Tasks 7 to 10), search + sitemap from the collection and `articles.ts` removed (Tasks 5 to 6), cross-linking (Related sections throughout), fact-check (Task 11), Chrome MCP mobile + desktop (Task 12). All present.
- **Type consistency:** `buildBreadcrumbLd/buildArticleLd/buildFaqLd` names match between Task 1 and Task 2; `CATEGORY_ORDER` consistent across categories.ts, content.config.ts, index.astro; `HelpEntry` and `matchEntries` consistent across staticEntries.ts, Layout.astro, SearchTrigger.tsx, SearchPalette.tsx; `cardLabel`/`featured`/`order` frontmatter fields used consistently by route, index, search, sitemap.
- **Ordering safety:** `articles.ts` is deleted only in Task 6, after its three importers (index Task 4, search Task 5, sitemap Task 6) have moved to the collection, so every task ends on a green build.

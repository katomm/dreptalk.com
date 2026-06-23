# Help section becomes a learning hub of Markdown guides

Date: 2026-06-22
Status: Approved

## Goal

Turn the current FAQ-style `/help` section into a central learning hub of
long-form, evergreen how-to guides aimed at DReps and ADA holders. Content that
answers the real questions people search for, so the section pulls its weight as
discoverable, durable reference material.

## Decisions (settled)

- **Evergreen hub, not a chronological blog.** Guides are grouped by topic, not
  ordered by date. Dated, reverse-chron posts would look stale and add no value
  for evergreen how-tos. An optional "Last updated" line is allowed; no
  prominent publish date. A real news/changelog feed, if ever wanted, is a
  separate future section.
- **URLs stay under `/help/<slug>`.** No existing URL breaks, no redirects, and
  the existing pages keep whatever authority they have built. New guides also
  live at `/help/<slug>`.
- **Markdown content collection** replaces the per-article `.astro` files.
- Plain Markdown only (prose + links). No MDX, no extra integration.

## Architecture

### Content collection (Astro 6 content layer)

- New file `src/content.config.ts` defines a `guides` collection using the
  `glob()` loader over `src/content/guides/*.md`.
- Frontmatter schema (Zod-validated):
  - `title: string` (long, used for the page `<title>` and Article headline)
  - `cardLabel: string` (short name for hub cards, breadcrumb, H1, and search)
  - `description: string`
  - `category: string` (free string, drives hub grouping; easy to reorganize)
  - `order: number` (sort within category and across the search/sitemap)
  - `featured: boolean` (default false; renders full-width on the hub)
  - `updated: date` (optional; renders "Last updated" and feeds `dateModified`)
  - `faqs: { q: string; a: string }[]` (optional; drives FAQPage JSON-LD)
- A single dynamic route `src/pages/help/[...slug].astro` renders every guide:
  it loads the collection, renders the Markdown body, and generates layout,
  breadcrumb, meta tags, and JSON-LD automatically from frontmatter. Adding a
  guide is just adding one `.md` file.
- `src/lib/help/articles.ts` is removed; the collection is the single source.
  The search palette (`src/lib/search/staticEntries.ts`) and `sitemap.xml.ts`
  derive their entries from the collection instead.

### Layout and styling

- `HelpLayout.astro` keeps providing the base layout + breadcrumb. The dynamic
  route passes `title`, `description`, `crumb`, and the rendered body.
- A scoped `.prose` style block in the guide route styles rendered Markdown
  (headings, paragraphs, links, lists) to match the look the inline-styled
  `.astro` articles have today (muted body text, `max-width` ~62ch, comfortable
  line height). No global CSS framework added.

### Structured data

Generated per guide from frontmatter:
- `BreadcrumbList` always (DRepTalk / Help / {title}).
- `Article` always (headline, description, url, `dateModified` from `updated`
  when present).
- `FAQPage` only when `faqs` is non-empty (mirrors today's
  `managing-your-drep` behavior).
- Deliberately **no `HowTo` schema**: Google removed HowTo rich results in 2023,
  so it adds markup weight with no benefit.

### Hub page `src/pages/help/index.astro`

- Cards grouped by `category` with section headings; order within a group by
  `order`.
- The `featured` guide renders full-width at the top (as `managing-your-drep`
  does today).
- Categories (initial assignment; free strings in frontmatter):
  - **Start here**: become-a-drep, delegate-to-a-drep, signing-in
  - **For DReps**: managing-your-drep (featured), writing-a-vote-rationale
  - **Understanding governance**: governance-action-types,
    governance-statuses, sorting, proposers
  - **About DRepTalk**: open-source, moderation, badges, data-freshness

## Content

### Migrated (9 existing articles, .astro -> .md, old files deleted)

signing-in, managing-your-drep, data-freshness, governance-statuses,
proposers, sorting, moderation, badges, open-source. Existing FAQ entries on
`managing-your-drep` move into its frontmatter `faqs`.

### New guides (4)

- **become-a-drep**: beginner walkthrough (what a DRep is, choosing a wallet,
  creating a profile, registering, the deposit). Targets the informational
  query; links to `managing-your-drep` for operational details so the two pages
  serve distinct intents rather than competing for the same one.
- **delegate-to-a-drep**: for any ADA holder. How to delegate voting power,
  what Abstain and No-Confidence mean, how to switch DReps.
- **governance-action-types**: the governance action types, what each means,
  and the thresholds/votes each needs.
- **writing-a-vote-rationale**: how a DRep writes a clear, CIP-100-compliant
  rationale.

### Cross-linking

Each guide ends with a short "Related" list linking adjacent guides, to help
readers and to strengthen internal linking.

## Verification (required before PR)

1. **Fact-check pass**: critically review every help article (all of them, not
   just the new four) for factual correctness against current Cardano
   governance rules and the actual app behavior. Fix anything wrong or stale.
2. **Chrome MCP walkthrough**: open the hub and every guide in Chrome MCP and
   click through them on both mobile and desktop viewports. Confirm layout,
   readability, breadcrumbs, links, and that no rendering is broken.
3. Standard build checks: `astro check` / lint pass; sitemap and search palette
   list every guide.

## Out of scope

- Per-item dynamic OG images for guides (existing static OG default applies).
- News/changelog feed.
- i18n/translation of guides (site is English-only today).

## Constraints honored

- Lean and cheap: content collection is build-time, zero added runtime cost.
- No typographic dashes anywhere in content or code/comments.
- Public repo: no internal references in content, commits, or PR.
- Guide copy is English (user-facing language of the site).

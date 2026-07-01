# TODO

## Composer: CodeMirror 6 editor (optional upgrade)

The Composer (`src/components/Composer.tsx`) currently uses a plain `<textarea>`
plus a Markdown toolbar (`src/lib/forum/markdownToolbar.ts`). A future upgrade is
to swap the textarea for a CodeMirror 6 editor in Markdown mode.

What it would add:
- Syntax highlighting for Markdown while typing (headings, emphasis, code, links).
- Better selection/caret handling, so the toolbar wraps map cleanly onto the
  editor's selection API instead of `textarea.selectionStart/End`.
- Optional niceties: soft-wrap, list continuation on Enter, paste-as-link.

Approach:
- Packages: `@codemirror/state`, `@codemirror/view`, `@codemirror/lang-markdown`,
  `@codemirror/language` (theme via `@codemirror/theme-one-dark` or a custom one
  matching our `--bg`/`--fg`/`--accent` tokens). CM6 is modular, so only pull the
  modules actually used.
- Keep `bodyMd` as the single source of truth; mirror the editor's doc into state
  on every change so submit/preview keep working unchanged.
- Reuse `applyMarkdown` from `markdownToolbar.ts`: read the CM selection, run the
  transform, dispatch a CM change + new selection. The pure function already
  covers the logic, only the read/write glue changes.

Watch-outs (lean hosting):
- CM6 adds client JS weight. Lazy-load the editor island so non-writers and
  read-only views never download it.
- Verify it hydrates fine under the pinned-React-instance setup (see #41).

Until then the textarea + toolbar covers the 80% case with zero added deps.

## Header: cardenticon identicon for the signed-in user

The signed-in header (`src/components/RoleEntry.astro`) shows a role badge plus a
Logout control. A future enhancement is to render a small Cardano identicon next
to the badge so the signed-in identity is recognizable at a glance.

What it would add:
- A deterministic per-account avatar (the same identity always renders the same
  icon), making it obvious which wallet/identity the session belongs to.

Approach:
- Package: `cardenticon` (npm, Apache-2.0, zero runtime deps, ~18 KB, ESM+CJS+TS).
  It returns an SVG string server-side (works in SSR / Cloudflare Workers), so it
  renders inline in `RoleEntry.astro` with no client JS, keeping the header CSP-clean.
- Input: the session carries `{ id, roles }` (middleware). `user.id` is the
  primary credential (drepId / stakeAddr / poolId / ccCred); cardenticon accepts
  any address/stake/hex/string, so feed it `user.id` for a stable icon. (If a
  more meaningful key is wanted later, the user row has drep_id / stake_addr.)
- Render: `cardenticon(user.id)` into a ~20-24px slot inside `.role-entry__badge`
  via `set:html` (trusted, deterministic generator output, no user HTML).

Watch-outs (lean hosting):
- SSR SVG, zero client JS; the ~18 KB lives in the server bundle and runs
  server-side, so no edge-cache or client-weight impact beyond the already-SSR header.
- Only ever pass the identity string to cardenticon, never raw user input; confirm
  the emitted SVG contains no script before using `set:html`.

Until then the role badge alone marks the signed-in state.

## Glossary: definitional pages for governance terms

The help guides (`src/content/guides/*`) answer "how do I X" (become a DRep, vote,
delegate). They do not cover "what is X" as standalone, linkable definitions. A
glossary would add short reference pages for the core governance vocabulary so
each term has its own discoverable entry, complementing the task-oriented guides.

What it would add:
- A `/glossary` hub listing every term, each with its own page: DRep, Constitutional
  Committee, SPO, voting power, delegation, No Confidence, Abstain, and one page per
  governance action type (treasury withdrawal, parameter change, hard fork, info, etc.).
- Each entry is a couple of plain paragraphs that cross-link the relevant help guide
  and the live data it describes (e.g. the "treasury withdrawal" entry links to
  `/c/budget`; the "DRep" entry links to `/dreps` and `/help/become-a-drep`). The
  interlinking is the point: definitions tie into guides and real governance actions.

Approach:
- Reuse the content-collection pattern already used for guides: a `glossary`
  collection under `src/content/`, an index page (`/glossary`) and a
  `[slug]` route, mirroring `src/pages/help/`.
- Feed the hub into the existing search index (`staticEntries`) and the sitemap
  (`src/pages/sitemap.xml.ts`) the same way guides already are.
- Much of the copy already exists as fragments in the guides and in
  `config/categories` / governance action-type labels; the work is consolidating
  it into canonical, nachschlagbare entries and writing clean definitions.

Watch-outs:
- Primarily an editorial task: the definitions need someone with Cardano
  governance knowledge to write and review, not just scaffolding.
- Keep entries genuinely definitional, not duplicated guide content, so the two
  layers stay distinct (what-is vs how-to).

Until then the how-to guides cover the task flows but there is no term-by-term reference.

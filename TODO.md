# TODO

## Composer: CodeMirror 6 editor (optional upgrade)

The Markdown editor (`src/components/MarkdownEditor.tsx`, used by the Composer)
currently uses a plain `<textarea>` plus a Markdown toolbar
(`src/lib/forum/markdownToolbar.ts`). A future upgrade is to swap the textarea
for a CodeMirror 6 editor in Markdown mode.

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
- Port the @-mention autocomplete (`src/lib/forum/mentionAutocomplete.ts`): it
  currently reads the textarea caret to detect the active mention query and to
  position the dropdown; CM6 has its own autocomplete facility that could
  replace the hand-rolled popup.

Watch-outs (lean hosting):
- CM6 adds client JS weight. Lazy-load the editor island so non-writers and
  read-only views never download it.
- Verify it hydrates fine under the pinned-React-instance setup (see #41,
  `resolve.dedupe` in astro.config.mjs).

Until then the textarea + toolbar covers the 80% case with zero added deps.

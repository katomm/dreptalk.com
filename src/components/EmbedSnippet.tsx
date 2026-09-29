// One copy-paste snippet block: a heading, a copy button, a note and a live
// preview. Shared by /brand (rendered statically, no client directive) and the
// DRep share kit in the drep.link settings island (rendered on the client, so
// it follows the handle). The copy button keeps the classes public/brand-copy.js
// listens for, and that script listens on document, so it also catches buttons
// React renders. Styles are global (src/styles/global.css), because Astro
// scoped styles would not reach a component used from two pages.
//
// `html` is trusted: it is built only by the badge modules, from escaped input,
// and the preview inserts it as markup. A plain text snippet (preview="text")
// is shown as text.
interface Props {
  title: string;
  note: string;
  html: string;
  copyLabel?: string;
  preview?: 'html' | 'text';
}

export default function EmbedSnippet({ title, note, html, copyLabel = 'Copy HTML', preview = 'html' }: Props) {
  return (
    <div className="embed">
      <div className="embed__head">
        <h3 className="embed__title">{title}</h3>
        <button className="btn btn-secondary embed__copy" type="button" data-copy={html}>
          <span data-copy-label={copyLabel}>{copyLabel}</span>
        </button>
      </div>
      <p className="embed__note">{note}</p>
      {preview === 'text' ? (
        <div className="embed__preview embed__preview--text">{html}</div>
      ) : (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: the snippet is built by the badge modules from escaped input, see the header comment
        <div className="embed__preview" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}

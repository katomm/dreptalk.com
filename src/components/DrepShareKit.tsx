// Badges and a share text a DRep pastes into their own site or social
// profiles, all pointing at their drep.link. Rendered inside the drep.link
// settings island from its current handle, so a saved rename updates every
// snippet at once, with no reload that would throw away an unsaved profile
// draft further down the page. Collapsed by default so the metadata form
// stays in view.
import EmbedSnippet from './EmbedSnippet.tsx';
import { buildDrepBadges, drepShareText } from '@/lib/brand/drepBadges.js';

export default function DrepShareKit({ handle, name }: { handle: string | null; name: string | null }) {
  const badges = handle ? buildDrepBadges(handle, name) : [];
  const shareText = handle ? drepShareText(handle) : null;
  return (
    <details className="kit">
      <summary className="kit__summary">Share your votes</summary>
      {badges.length === 0 ? (
        <p className="kit__note">Pick a drep.link name above to get badges and a share text for your own site.</p>
      ) : (
        <>
          <p className="kit__note">
            Let your delegators follow how you vote. Every badge links to drep.link/{handle}, which always leads to your
            DRepTalk profile. No JavaScript and no external requests, paste the HTML straight into your site.
          </p>
          {shareText && (
            <EmbedSnippet
              title="Share text"
              note="For your social bios and posts."
              html={shareText}
              copyLabel="Copy text"
              preview="text"
            />
          )}
          {badges.map((b) => (
            <EmbedSnippet key={b.kind} title={b.title} note={b.note} html={b.html} />
          ))}
        </>
      )}
    </details>
  );
}

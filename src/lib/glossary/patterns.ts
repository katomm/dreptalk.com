// Term-detection patterns for in-page glossary marking, used by the
// client-side walker in components/glossary/GlossaryTerms.astro.
//
// Order matters: longer, more specific phrases come first so they win when
// several patterns could match the same text. Each `key` must be the id of an
// entry in src/content/glossary/. Patterns must not carry the /g flag: the
// walker relies on exec() returning the first match of each text node.

export interface GlossaryPattern {
  key: string;
  regex: RegExp;
}

export const GLOSSARY_PATTERNS: GlossaryPattern[] = [
  // Multi-word phrases first so they win over their substrings.
  { key: 'update-constitutional-committee', regex: /\bupdate (?:the |of )?constitutional committee\b/i },
  { key: 'motion-of-no-confidence', regex: /\bmotions? of no[ -]confidence\b|\bno[ -]confidence\b/i },
  { key: 'constitutional-committee', regex: /\bconstitutional committee\b/i },
  { key: 'protocol-parameter-change', regex: /\b(?:protocol )?parameter changes?\b/i },
  { key: 'hard-fork-initiation', regex: /\bhard[ -]fork(?: initiation)?s?\b/i },
  { key: 'treasury-withdrawal', regex: /\btreasury withdrawals?\b/i },
  { key: 'governance-action', regex: /\bgovernance actions?\b/i },
  { key: 'new-constitution', regex: /\bnew constitution\b|\bguardrails(?: script)?\b/i },
  { key: 'info-action', regex: /\binfo actions?\b/i },
  { key: 'voting-power', regex: /\bvoting power\b/i },
  { key: 'vote-rationale', regex: /\b(?:vote )?rationales?\b/i },
  { key: 'spo', regex: /\bSPOs?\b|\bstake pool operators?\b/i },
  // Deliberately not case-insensitive: a bech32 id like "drep1..." must not
  // match, and the spelled-out form appears in title or sentence case only.
  { key: 'drep', regex: /\b[Dd]Reps?\b|\b[Dd]elegated [Rr]epresentatives?\b/ },
  { key: 'delegation', regex: /\bdelegations?\b/i },
  { key: 'abstain', regex: /\babstain(?:ed|s|ing)?\b/i },
  { key: 'proposer', regex: /\bproposers?\b/i },
];

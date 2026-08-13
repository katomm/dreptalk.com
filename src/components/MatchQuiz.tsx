// The find-your-drep matching quiz island. Renders the question deck, scores
// answers against the DRep vote matrix client-side, and shows the ranked
// results. Stub only: Task 4 fills in the real implementation.
import type { CardanoNetwork } from '@/lib/config/network.js';
import type { MatchDrep } from '@/lib/match/logic.js';

// SSR payload shape for one question, built by src/pages/match.astro from a
// selected governance action row.
export interface MatchQuestion {
  gaId: string;
  title: string;
  typeLabel: string;
  abstract: string;
  slug: string | null;
}

interface Props {
  network: CardanoNetwork;
  questions: MatchQuestion[];
  dreps: MatchDrep[];
}

export default function MatchQuiz(_props: Props) {
  return <p>Loading the DRep match quiz…</p>;
}

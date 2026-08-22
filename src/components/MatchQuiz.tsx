// The find-your-drep matching quiz island. Renders the question deck, scores
// answers against the DRep vote matrix client-side, and shows the ranked
// results. Nothing here ever leaves the browser: the SSR page hands down the
// question set and the DRep vote matrix, and all scoring happens in
// rankDreps (src/lib/match/logic.ts).
import { useEffect, useState } from 'react';
import DelegateButton from '@/components/DelegateButton.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { drepPath } from '@/lib/dreps/profile.js';
import { formatAdaCompact } from '@/lib/format/ada.js';
import { voteStatementPath } from '@/lib/governance/voteStatement.js';
import { identiconSvg } from '@/lib/identity/identicon.js';
import {
  decodeShareFragment,
  encodeShareFragment,
  minAnsweredFor,
  minSharedFor,
  rankDreps,
  setFingerprint,
  type MatchDrep,
  type RankedDrep,
  type UserAnswer,
} from '@/lib/match/logic.js';

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

type Phase = 'intro' | 'quiz' | 'results';

// Heuristic character count approximating when the CSS 3-line clamp on the
// abstract actually truncates something. Exact overflow depends on font
// metrics and viewport width, but this keeps the toggle CSS-only with no
// layout measurement, so the intro and question screens stay server-renderable.
const ABSTRACT_CLAMP_THRESHOLD = 260;

function answerLabel(a: UserAnswer): string {
  if (a === 'y') return 'Yes';
  if (a === 'n') return 'No';
  if (a === 'a') return 'Abstain';
  return 'Skipped';
}

function voteLabel(v: string): string {
  if (v === 'Y') return 'Yes';
  if (v === 'N') return 'No';
  if (v === 'A') return 'Abstain';
  return 'Did not vote';
}

/** Index of the first not-yet-answered question, or 0 when everything is answered. */
function firstSkippedIndex(answers: readonly UserAnswer[]): number {
  const idx = answers.indexOf('s');
  return idx === -1 ? 0 : idx;
}

export default function MatchQuiz({ network, questions, dreps }: Props) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<UserAnswer[]>(() => questions.map(() => 's'));
  const [staleLink, setStaleLink] = useState(false);
  const [shownCount, setShownCount] = useState<10 | 25>(10);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showFullAbstract, setShowFullAbstract] = useState(false);

  const minAnswered = minAnsweredFor(questions.length);
  const minShared = minSharedFor(questions.length);
  const gaIds = questions.map((q) => q.gaId);

  // Restore a shared result from the URL fragment once, after hydration. The
  // initial render always shows the intro (matching the server-rendered
  // markup exactly), so there is no hydration mismatch. This effect only
  // flips the phase after mount, never during render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: questions/dreps are SSR-rendered props, render-stable for the island's lifetime, this restore must run exactly once on mount
  useEffect(() => {
    const decoded = decodeShareFragment(window.location.hash);
    if (!decoded) return;
    if (decoded.answers.length !== questions.length) {
      // Well-formed fragment, but the question set has drifted in size since
      // the link was shared (selectQuestions picks however many candidates
      // qualify). Same notice as a fingerprint mismatch, not a silent no-op.
      setStaleLink(true);
      return;
    }
    let cancelled = false;
    void setFingerprint(gaIds).then((fingerprint) => {
      if (cancelled) return;
      if (fingerprint === decoded.fingerprint) {
        setAnswers(decoded.answers);
        setPhase('results');
      } else {
        setStaleLink(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function goToQuestion(index: number) {
    setStep(index);
    setShowFullAbstract(false);
  }

  function handleAnswer(value: UserAnswer) {
    const next = answers.slice();
    next[step] = value;
    setAnswers(next);
    setShowFullAbstract(false);
    const target = step + 1;
    if (target >= questions.length) {
      const answeredCount = next.filter((a) => a !== 's').length;
      if (answeredCount < minAnswered) {
        setStep(questions.length);
      } else {
        setPhase('results');
      }
      return;
    }
    setStep(target);
  }

  function startQuiz() {
    setStaleLink(false);
    setPhase('quiz');
  }

  function answerMore() {
    setPhase('quiz');
    goToQuestion(firstSkippedIndex(answers));
  }

  function startOver() {
    setAnswers(questions.map(() => 's'));
    setStep(0);
    setStaleLink(false);
    setShownCount(10);
    setExpanded(null);
    setCopied(false);
    setPhase('intro');
    window.history.replaceState(null, '', window.location.pathname);
  }

  async function handleShare() {
    const fingerprint = await setFingerprint(gaIds);
    const frag = encodeShareFragment(fingerprint, answers);
    window.history.replaceState(null, '', `#${frag}`);
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked (no permission or insecure context). The
      // fragment is still written to the URL, so the link itself still works.
    }
  }

  return (
    <div className="match-quiz">
      {phase === 'intro' && (
        <IntroScreen staleLink={staleLink} questionCount={questions.length} onStart={startQuiz} />
      )}
      {phase === 'quiz' && (
        <QuizScreen
          step={step}
          questions={questions}
          answers={answers}
          minAnswered={minAnswered}
          showFullAbstract={showFullAbstract}
          onToggleAbstract={() => setShowFullAbstract((v) => !v)}
          onAnswer={handleAnswer}
          onBack={() => goToQuestion(Math.max(0, step - 1))}
          onJumpToSkipped={() => goToQuestion(firstSkippedIndex(answers))}
        />
      )}
      {phase === 'results' && (
        <ResultsScreen
          network={network}
          questions={questions}
          answers={answers}
          dreps={dreps}
          minShared={minShared}
          shownCount={shownCount}
          onShowMore={() => setShownCount((c) => (c === 10 ? 25 : 10))}
          expanded={expanded}
          onToggleExpanded={(drepId) => setExpanded((cur) => (cur === drepId ? null : drepId))}
          copied={copied}
          onShare={() => void handleShare()}
          onAnswerMore={answerMore}
          onStartOver={startOver}
        />
      )}
    </div>
  );
}

function IntroScreen({
  staleLink,
  questionCount,
  onStart,
}: {
  staleLink: boolean;
  questionCount: number;
  onStart: () => void;
}) {
  return (
    <section className="match-panel match-intro">
      {staleLink && (
        <div className="callout callout--warning match-notice" role="status">
          <div className="callout__body">
            This link was created with an older question set. The questions have changed since, so
            the result cannot be reproduced. Start fresh below.
          </div>
        </div>
      )}
      <p className="match-intro__lede">
        You will see {questionCount} real governance actions that Cardano DReps have already
        voted on. For each one, say how you would have voted: Yes, No or Abstain. At the end,
        see the DReps whose past votes line up most closely with your answers.
      </p>
      <p className="match-intro__privacy">
        <strong>Your answers never leave your device.</strong> Matching runs entirely in your
        browser.
      </p>
      <p className="match-intro__how">
        <a href="/help/drep-matching/">How matching works</a>
      </p>
      <button type="button" className="btn btn-primary match-intro__start" onClick={onStart}>
        Start
      </button>
    </section>
  );
}

function QuizScreen({
  step,
  questions,
  answers,
  minAnswered,
  showFullAbstract,
  onToggleAbstract,
  onAnswer,
  onBack,
  onJumpToSkipped,
}: {
  step: number;
  questions: MatchQuestion[];
  answers: UserAnswer[];
  minAnswered: number;
  showFullAbstract: boolean;
  onToggleAbstract: () => void;
  onAnswer: (value: UserAnswer) => void;
  onBack: () => void;
  onJumpToSkipped: () => void;
}) {
  const backButton = (
    <button type="button" className="btn btn-ghost" onClick={onBack} disabled={step === 0}>
      Back
    </button>
  );

  if (step >= questions.length) {
    const answeredCount = answers.filter((a) => a !== 's').length;
    return (
      <section className="match-panel match-quiz-panel">
        <div className="callout callout--warning match-notice" role="status">
          <div className="callout__body">
            <p className="match-gate__msg">
              Answer at least {minAnswered} governance actions for a meaningful result. You have answered{' '}
              {answeredCount} so far.
            </p>
            <button type="button" className="btn btn-primary" onClick={onJumpToSkipped}>
              Jump to the first skipped question
            </button>
          </div>
        </div>
        <div className="match-nav">{backButton}</div>
      </section>
    );
  }

  const q = questions[step];
  const showToggle = q.abstract.length > ABSTRACT_CLAMP_THRESHOLD;

  return (
    <section className="match-panel match-quiz-panel">
      <p className="match-progress">
        Governance action {step + 1} of {questions.length}
      </p>
      <span className="match-badge">{q.typeLabel}</span>
      <h2 className="match-question__title">{q.title}</h2>
      {q.abstract && (
        <>
          <p
            className={
              showFullAbstract
                ? 'match-question__abstract match-question__abstract--full'
                : 'match-question__abstract'
            }
          >
            {q.abstract}
          </p>
          {showToggle && (
            <button type="button" className="match-showmore" onClick={onToggleAbstract}>
              {showFullAbstract ? 'Show less' : 'Show more'}
            </button>
          )}
        </>
      )}
      <p className="match-question__prompt">How would you have voted on this governance action?</p>
      <div className="match-answers">
        <button type="button" className="btn btn-secondary match-answer" onClick={() => onAnswer('y')}>
          Yes
        </button>
        <button type="button" className="btn btn-secondary match-answer" onClick={() => onAnswer('n')}>
          No
        </button>
        <button type="button" className="btn btn-secondary match-answer" onClick={() => onAnswer('a')}>
          Abstain
        </button>
        <button
          type="button"
          className="btn btn-ghost match-answer match-answer--skip"
          onClick={() => onAnswer('s')}
        >
          Skip
        </button>
      </div>
      <div className="match-nav">{backButton}</div>
    </section>
  );
}

function ResultsScreen({
  network,
  questions,
  answers,
  dreps,
  minShared,
  shownCount,
  onShowMore,
  expanded,
  onToggleExpanded,
  copied,
  onShare,
  onAnswerMore,
  onStartOver,
}: {
  network: CardanoNetwork;
  questions: MatchQuestion[];
  answers: UserAnswer[];
  dreps: MatchDrep[];
  minShared: number;
  shownCount: 10 | 25;
  onShowMore: () => void;
  expanded: string | null;
  onToggleExpanded: (drepId: string) => void;
  copied: boolean;
  onShare: () => void;
  onAnswerMore: () => void;
  onStartOver: () => void;
}) {
  const ranked = rankDreps(answers, dreps, minShared);

  if (ranked.length === 0) {
    return (
      <section className="match-panel match-results">
        <h2 className="match-results__heading">Your voting match</h2>
        <p className="match-results__sub">Based only on past on-chain votes.</p>
        <div className="callout callout--info match-noresults">
          <div className="callout__body">
            <p>
              No DRep shares enough answered questions with you yet to produce a reliable match.
              Answer more of the governance actions to improve your odds.
            </p>
            <button type="button" className="btn btn-primary" onClick={onAnswerMore}>
              Answer more questions
            </button>
          </div>
        </div>
        <div className="match-startover">
          <button type="button" className="btn btn-ghost" onClick={onStartOver}>
            Start over
          </button>
        </div>
      </section>
    );
  }

  const visible = ranked.slice(0, shownCount);

  return (
    <section className="match-panel match-results">
      <h2 className="match-results__heading">Your voting match</h2>
      <p className="match-results__sub">Based only on past on-chain votes.</p>
      <ol className="match-results__list">
        {visible.map((r) => (
          <ResultRow
            key={r.drep.drepId}
            network={network}
            questions={questions}
            answers={answers}
            ranked={r}
            isOpen={expanded === r.drep.drepId}
            onToggle={() => onToggleExpanded(r.drep.drepId)}
          />
        ))}
      </ol>
      {ranked.length > 10 && (
        <button type="button" className="btn btn-secondary match-showall" onClick={onShowMore}>
          {shownCount === 10 ? `Show all ${Math.min(ranked.length, 25)}` : 'Show top 10'}
        </button>
      )}
      <div className="match-share">
        <button type="button" className="btn btn-primary" onClick={onShare}>
          {copied ? 'Copied' : 'Copy share link'}
        </button>
        <p className="match-share__caption">
          The link contains your answers. Share it only if you are comfortable with that.
        </p>
      </div>
      <p className="match-disclosure">
        Matches focus on active DReps with 25K to 50M ₳ voting power that voted on at least two
        thirds of the questions. <a href="/help/drep-matching/">How matching works</a>
      </p>
      <div className="match-startover">
        <button type="button" className="btn btn-ghost" onClick={onStartOver}>
          Start over
        </button>
      </div>
    </section>
  );
}

function ResultRow({
  network,
  questions,
  answers,
  ranked,
  isOpen,
  onToggle,
}: {
  network: CardanoNetwork;
  questions: MatchQuestion[];
  answers: UserAnswer[];
  ranked: RankedDrep;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const d = ranked.drep;
  const power = formatAdaCompact(d.powerLovelace) ?? '0 ₳';
  const breakdownId = `match-breakdown-${d.drepId}`;

  return (
    <li className="match-row">
      <div className="match-row__main">
        <span className="match-row__avatar" aria-hidden="true">
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: identiconSvg renders deterministic markup from a locally generated seed, not user input, same pattern as Avatar.astro */}
          <span dangerouslySetInnerHTML={{ __html: identiconSvg(d.identiconSeed, 40) }} />
          {d.imageHash && (
            <span
              className="match-row__avatarimg"
              style={{ backgroundImage: `url(/api/avatar/${d.imageHash})` }}
            />
          )}
        </span>
        <div className="match-row__info">
          <a className="match-row__name" href={drepPath({ drepId: d.drepId, slug: d.slug })}>
            {d.name}
          </a>
          <span className="match-row__meta">
            <span>
              {ranked.shared} shared {ranked.shared === 1 ? 'vote' : 'votes'}
            </span>
            <span className="match-row__dot" aria-hidden="true">
              ·
            </span>
            <span>{power} voting power</span>
            {d.delegatorCount != null && (
              <>
                <span className="match-row__dot" aria-hidden="true">
                  &middot;
                </span>
                <span>
                  {d.delegatorCount.toLocaleString('en-US')}{' '}
                  {d.delegatorCount === 1 ? 'delegator' : 'delegators'}
                </span>
              </>
            )}
          </span>
        </div>
        <span className="match-row__pct">{ranked.matchPct}%</span>
      </div>
      <div className="match-row__actions">
        <button
          type="button"
          className="btn btn-secondary match-row__toggle"
          aria-expanded={isOpen}
          aria-controls={breakdownId}
          onClick={onToggle}
        >
          {isOpen ? 'Hide comparison' : 'Compare answers'}
        </button>
        <DelegateButton
          network={network}
          target={{
            drepId: d.drepId,
            slug: d.slug,
            name: d.name,
            credentialHex: d.credentialHex,
            isScript: d.isScript,
          }}
        />
      </div>
      {isOpen && (
        <div className="match-row__breakdown" id={breakdownId}>
          {questions.map((q, i) => {
            const a = answers[i];
            const v = d.votes[i];
            if (a === 's' || v === '-') return null;
            const rationaleHref =
              d.rationales[i] === '1' && q.slug
                ? voteStatementPath('drep', d.slug ?? d.drepId, q.slug)
                : null;
            return (
              <div className="match-row__q" key={q.gaId}>
                <span className="match-row__qtitle">{q.title}</span>
                <span className="match-row__qyou">You: {answerLabel(a)}</span>
                <span className="match-row__qthem">
                  {d.name}: {voteLabel(v)}
                </span>
                {rationaleHref && (
                  <a className="match-row__rationale" href={rationaleHref}>
                    Read their rationale
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
    </li>
  );
}

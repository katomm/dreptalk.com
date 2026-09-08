// Frontmatter contract of a Governance Review edition. Shared by the content
// collection (build-time validation) and the node tests that read the files
// directly, so the two can never disagree.
import { z } from 'zod';

export const actionRowSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}#\d+$/),
  title: z.string().min(1),
  /** Short names the body uses for this action ("the committee update"), so
   *  the fact check can find every paragraph about it. Digits are rejected: an
   *  alias is a name, and a number inside one would ride into the body as link
   *  text that no pack field has to back. */
  aliases: z.array(z.string().min(3).regex(/^\D*$/, 'an alias must not contain digits')).default([]),
  type: z.string().min(1),
  outcome: z.enum(['ratified', 'enacted', 'expired', 'dropped', 'closed', 'open', 'submitted']),
  epoch: z.number().int(),
  drepYesPct: z.number().nullable(),
});
export type ActionRow = z.infer<typeof actionRowSchema>;

export const factTileSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  source: z.string().min(1),
});

export const reviewFrontmatterSchema = z
  .object({
    title: z.string().min(1),
    standfirst: z.string().min(1),
    /** Short form of the title for the index and the homepage teaser. The full
     *  title stays on the edition page, where a reader has already chosen it. */
    listTitle: z.string().min(1).max(90).optional(),
    /** Two sentences for the index: what happened, and what a reader gets from
     *  the piece. Without it the index falls back to the standfirst, which is
     *  written for someone who has already opened the edition. */
    teaser: z.string().min(1).max(320).optional(),
    epochFrom: z.number().int().positive(),
    epochTo: z.number().int().positive(),
    published: z.coerce.date(),
    dataAsOf: z.string().datetime(),
    packVersion: z.number().int().positive(),
    /** Git blob hash of the frozen pack file (git hash-object), so the edition pins the exact bytes it was written from. */
    packBlob: z.string().regex(/^[0-9a-f]{40}$/),
    facts: z.array(factTileSchema).length(4),
    featuredActions: z.array(z.string()).default([]),
    /** The figure the social card shows. Carries a source so the fact check can
     *  hold it to the pack exactly like a fact tile. */
    ogFigure: z.object({ value: z.string(), label: z.string(), source: z.string().min(1) }),
    alsoDecided: z.array(actionRowSchema).default([]),
    openActions: z.array(actionRowSchema).default([]),
    numbers: z.object({
      delegatedPowerStartAda: z.number().nullable(),
      delegatedPowerEndAda: z.number().nullable(),
      votesCast: z.number().int().nullable(),
      finalDrepVoters: z.number().int().nullable(),
      treasuryStartAda: z.number().nullable(),
      treasuryEndAda: z.number().nullable(),
      limitations: z.array(z.string()).default([]),
    }),
    derived: z.array(z.object({ value: z.number(), op: z.enum(['sum', 'diff']), from: z.array(z.string()).min(1).max(3) })).default([]),
    corrections: z.array(z.object({ date: z.coerce.date(), note: z.string() })).default([]),
  })
  .refine((d) => d.epochTo - d.epochFrom >= 2 && d.epochTo - d.epochFrom <= 5, {
    message: 'an edition covers 3 to 6 epochs',
  })
  .refine((d) => d.featuredActions.every((id) => [...d.alsoDecided, ...d.openActions].some((r) => r.id === id)), {
    message: 'every featured action needs a row in alsoDecided or openActions',
  });
export type ReviewFrontmatter = z.infer<typeof reviewFrontmatterSchema>;

// POST /api/groups/actions
// Opens a signing link for a client built DRep group transaction. Nothing is stored unless the
// transaction carries exactly the payload the intent asks for in the current state, its required
// signers are the action's signers, and the engine's own rules find every event valid with them.
// A group has at most one open control action, and no two open actions spend the same output.
import type { APIRoute } from 'astro';
import { credKey, majorityScript, type NativeScript } from 'drep-groups';
import { z } from 'zod';
import { currentNetwork, jsonResponse, runtimeEnv } from '@/lib/api/response';
import { checkRate } from '@/lib/rate';
import { actionHoldingInputs, createGroupAction, openActionInputs, openControlAction } from '@/lib/groups/actionStore';
import {
  feeInputKeys,
  intentSchema,
  isControlKind,
  isIntentFailure,
  describeTxNamed,
  koiosFor,
  notifySigners,
  openJoinsOf,
  payloadMembers,
  policyJson,
  releaseStaleSlot,
  sessionOf,
} from '@/lib/groups/actionServer';
import { controlSeq, type DecodedGroupTx, decodeGroupTx, eventsOf, unsignedShapeError } from '@/lib/groups/actionTx';
import {
  bindContent,
  expectedPayload,
  type GroupIntent,
  type GroupState,
  mayInitiate,
  neededKeys,
  signerSetSatisfies,
  uniq,
} from '@/lib/groups/actions';
import { scriptDisplayJson } from '@/lib/groups/codec';
import { ACTION_RATE, ACTION_TTL_SECONDS } from '@/lib/groups/constants';
import { drepGroupsAvailable } from '@/lib/groups/gate';
import { credentialForDrepId, drepIdForCredential, groupIdParam, groupIdString } from '@/lib/groups/ids';
import { liveFactsFor, PreviewUnavailable, previewGroupTx, previewRefusal, readGroupState } from '@/lib/groups/preview';

export const prerender = false;

// The tip may move between the client's build and this check.
const VALIDITY_SLACK_SLOTS = 600;

const schema = z.object({
  intent: intentSchema,
  unsignedTxCbor: z.string().regex(/^[0-9a-fA-F]+$/).max(32_768),
  selected: z.array(z.string().regex(/^[0-9a-fA-F]{56}$/)).max(64),
});

/** Keys a create or an update adds to a policy, which must belong to currently registered key DReps. */
function addedKeys(intent: GroupIntent, mandatory: string[]): string[] {
  if (intent.kind === 'group_create') {
    const admission = intent.admission === 'same' || intent.admission === null ? [] : intent.admission.keys;
    return uniq([...intent.control.keys, ...admission]);
  }
  return intent.kind === 'group_update' ? mandatory : [];
}

/** The policy stored for display, and for a script DRep member the script the gate and witnesses follow. */
function displayPolicy(intent: GroupIntent, state: GroupState | null, memberScript: NativeScript | null): string {
  switch (intent.kind) {
    case 'group_create':
      return scriptDisplayJson(majorityScript(intent.control.keys, intent.control.n).script);
    case 'group_join':
    case 'group_leave': {
      const c = credentialForDrepId(intent.member);
      if (c?.kind === 'script' && memberScript) return scriptDisplayJson(memberScript);
      return scriptDisplayJson({ type: 'sig', keyHash: (c?.hash ?? '').toLowerCase() });
    }
    case 'group_approve':
    case 'group_remove':
      return state?.admission ? policyJson(state.admission) : '{}';
    default:
      return state ? policyJson(state.control) : '{}';
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  if (!drepGroupsAvailable(currentNetwork().network)) return jsonResponse({ error: 'not found' }, 404);
  const user = (locals as App.Locals).user;
  if (!user) return jsonResponse({ error: 'unauthorized' }, 401);
  const session = sessionOf(user);
  if (!session.keyHash && !session.drepId) return jsonResponse({ error: 'forbidden' }, 403);

  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const rateLimiter = env.RATE_LIMITER;
  if (!db || !rateLimiter) return jsonResponse({ error: 'service unavailable' }, 503);
  if (!(await checkRate(rateLimiter, `group-action:${user.id}`, { ...ACTION_RATE, now: Date.now() }))) {
    return jsonResponse({ error: 'rate_limited' }, 429);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // A founding without its profile is a refused action rather than malformed input.
    const founding = (raw as { intent?: { kind?: unknown } } | null)?.intent?.kind === 'group_create';
    const noProfile = founding && parsed.error.issues.some((i) => i.path.join('.') === 'intent.profile');
    return noProfile ? jsonResponse({ error: 'a group needs a profile' }, 422) : jsonResponse({ error: 'invalid input' }, 400);
  }
  const { intent, unsignedTxCbor } = parsed.data;
  const selected = uniq(parsed.data.selected);
  const refuse = (error: string, status = 422) => jsonResponse({ error }, status);

  let tx: DecodedGroupTx;
  try {
    tx = decodeGroupTx(unsignedTxCbor);
  } catch {
    return refuse('invalid transaction');
  }
  // Witnesses are folded in at submit next to the original body bytes.
  const shape = unsignedShapeError(tx);
  if (shape) return refuse(shape);

  const koios = koiosFor(env);
  const now = Math.floor(Date.now() / 1000);

  try {
    // A second action on an output an open action spends could never be valid once the first one is
    // on chain. The holder is named only to its own initiator.
    const group = intent.kind === 'group_create' ? null : groupIdParam(intent.group);
    const [open, state] = await Promise.all([openActionInputs(db), group ? readGroupState(db, group) : null]);
    const holder = actionHoldingInputs(open, tx.inputs);
    if (holder) return jsonResponse({ error: 'fee inputs held', id: holder.createdBy === user.id ? holder.id : null }, 409);

    if (intent.kind !== 'group_create' && !group) return refuse('bad group id');
    if (group && !state) return refuse('unknown group');
    if (!mayInitiate(intent, state, session)) return refuse('not allowed to open this action', 403);

    // The validity end bounds how long signatures stay usable and how long a control slot is held.
    const ttl = tx.chain.invalidHereafter;
    if (ttl === null) return refuse('transaction has no validity end');
    const tip = await koios.tip();
    if (ttl <= BigInt(tip.abs_slot)) return refuse('transaction already expired');
    if (ttl > BigInt(tip.abs_slot + ACTION_TTL_SECONDS + VALIDITY_SLACK_SLOTS)) return refuse('validity end too far ahead');

    const members = payloadMembers(intent);
    const memberCred = intent.kind === 'group_join' || intent.kind === 'group_leave' ? members[0] : null;
    const draftKeys = neededKeys(intent, state, null);
    const added = addedKeys(intent, draftKeys.mandatory);
    const live = await liveFactsFor(koios, [...members, ...added.map((hash) => ({ kind: 'key' as const, hash }))]);
    const memberScript = memberCred?.kind === 'script' ? (live.memberScripts.get(credKey(memberCred)) ?? null) : null;
    if (memberCred?.kind === 'script' && !memberScript) return refuse('member script not found');
    for (const k of added) {
      if (!live.registered.has(credKey({ kind: 'key', hash: k }))) return refuse(`key ${k} is not a registered DRep`);
    }
    if (intent.kind === 'group_create') {
      for (const c of members) if (!live.registered.has(credKey(c))) return refuse(`founder ${drepIdForCredential(c)} is not a registered DRep`);
    }

    const joinMembers =
      intent.kind === 'group_leave' && intent.join === undefined && group && memberCred ? await openJoinsOf(db, group, memberCred) : new Map();
    const expected = expectedPayload(intent, state, joinMembers);
    const { mandatory, optional } = neededKeys(intent, state, memberScript);
    const allowed = new Set([...mandatory, ...optional]);
    if (selected.some((k) => !allowed.has(k))) return refuse('a selected signer is not a key of this action');
    const signers = uniq([...mandatory, ...selected]);

    const bound = bindContent(tx.facts, tx.decoded, expected, tx.chain.requiredSigners, signers);
    if (!bound.ok) return refuse(bound.reason);
    const interval = { invalidBefore: tx.chain.invalidBefore, invalidHereafter: tx.chain.invalidHereafter };
    if (!signerSetSatisfies(state, intent, memberScript, signers, interval)) return refuse('the selected signers do not satisfy the action');

    const previewError = previewRefusal(await previewGroupTx(db, tx.bytes, tx.chain.requiredSigners, signers, live));
    if (previewError) return refuse(previewError);

    // The payment keys of the fee inputs never change for the row, they are read once here.
    const fee = await feeInputKeys(koios, tx.inputs);
    if (fee.spent) return refuse('fee input spent');
    if (fee.payKeys.size === 0) return refuse('fee inputs must come from a key address');

    const controlSlot = isControlKind(intent.kind);
    const subjectId =
      intent.kind === 'group_create'
        ? groupIdString({ txHash: tx.bodyHash, index: 0 })
        : memberCred && (intent.kind === 'group_join' || intent.kind === 'group_leave')
          ? drepIdForCredential(memberCred)
          : groupIdString((state as GroupState).ref);
    const profile = intent.kind === 'group_create' ? intent.profile : intent.kind === 'group_update' ? (intent.profile ?? null) : null;
    const id = crypto.randomUUID().replace(/-/g, '');
    const rec = {
      id,
      kind: intent.kind,
      subjectKind: memberCred ? ('member' as const) : ('group' as const),
      subjectId,
      intent,
      nativeScriptJson: displayPolicy(intent, state, memberScript),
      unsignedTxCbor: unsignedTxCbor.toLowerCase(),
      bodyHash: tx.bodyHash,
      requiredSigners: signers,
      invalidHereafter: Number(ttl),
      feeInputs: tx.inputs,
      feePayKeys: [...fee.payKeys],
      eventCount: expected.events.length,
      controlSlot,
      profileHash: profile?.dataHash.toLowerCase() ?? null,
      createdBy: user.id,
      now,
    };
    let stored = await createGroupAction(db, rec);
    if (stored === 'slot taken') {
      const open = await openControlAction(db, subjectId);
      // An open action built against an older seq can never apply, its slot is freed at once.
      if (open && state && controlSeq(decodeGroupTx(open.unsigned_tx_cbor).decoded) !== state.seq) {
        await releaseStaleSlot(db, open, now);
        stored = await createGroupAction(db, rec);
      }
      if (stored === 'slot taken') {
        const holder = await openControlAction(db, subjectId);
        return jsonResponse({ error: 'slot taken', id: holder?.id ?? null }, 409);
      }
    }

    // The initiator's key joins the name lookup, the request names who asks.
    const nameKeys = session.keyHash ? [...signers, session.keyHash] : signers;
    const { lines, names } = await describeTxNamed(db, { events: eventsOf(tx.decoded), state, scripts: tx.decoded?.scripts ?? [], signers: nameKeys });
    await notifySigners(db, {
      rowId: id,
      groupId: state ? groupIdString(state.ref) : subjectId,
      group: state?.ref ?? null,
      signers,
      initiator: user.id,
      initiatorName: session.keyHash ? (names.get(session.keyHash) ?? null) : null,
      summary: lines.join(' '),
    });
    return jsonResponse({ id }, 200);
  } catch (err) {
    if (err instanceof PreviewUnavailable) return refuse(err.message, 503);
    if (isIntentFailure(err)) return refuse((err as Error).message);
    console.error('[drep-groups] opening a group action failed', err);
    return refuse('service unavailable', 503);
  }
};

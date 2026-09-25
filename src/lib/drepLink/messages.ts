// User-facing texts for drep.link claim refusals. Shared by the settings island
// for client-side validation and for API answers.
const date = (sec: number) =>
  new Date(sec * 1000).toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric' });

export function claimErrorMessage(error: string, until: number | null): string {
  switch (error) {
    case 'taken':
      return 'This drep.link is already taken.';
    case 'reserved':
      return 'This name is reserved.';
    case 'length':
      return 'Use 3 to 40 characters.';
    case 'shape':
      return 'Use lowercase letters, digits and single hyphens.';
    case 'id_namespace':
      return 'Links starting with "drep" are kept for DRep ids.';
    case 'unchanged':
      return 'That is already your drep.link.';
    case 'cooldown':
      return until ? `You can change your drep.link again on ${date(until)}.` : 'You changed your drep.link recently.';
    case 'previous_pending':
      return until
        ? `Not yet: your previous link still redirects until ${date(until)}. You can take that one back now.`
        : 'Your previous link is still active.';
    case 'stale':
      return 'Your link changed in the meantime. Reload the page and try again.';
    case 'not_open':
      return 'Changing your drep.link opens soon.';
    case 'not_synced':
      return 'Your DRep registration is not synced yet. Try again in a few minutes.';
    case 'not_registered':
      return 'Only registered DReps can change their drep.link.';
    case 'rate_limited':
      return 'Too many attempts. Please wait a few minutes.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

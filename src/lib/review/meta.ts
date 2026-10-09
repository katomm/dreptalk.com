import { clipExcerpt } from '../forum/view.js';

/** Meta description limit shared with the other page types. */
const META_DESCRIPTION_MAX = 155;

/**
 * Page title and meta description for a review edition. The section name is
 * already in the breadcrumb and URL, so the title only carries the headline.
 */
export function reviewMeta(title: string, standfirst: string): { title: string; description: string } {
  return {
    title: `${title} - DRepTalk`,
    description: clipExcerpt(standfirst, META_DESCRIPTION_MAX),
  };
}

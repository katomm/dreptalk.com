// Pure flow logic for submitting topic/post forms from the Composer island.
// All I/O is injected via fetchImpl so tests can supply a fake fetch.

export interface ComposerPayload {
  categorySlug?: string;
  title?: string;
  topicId?: string;
  bodyMd: string;
}

export interface ComposerResult {
  ok: boolean;
  slug?: string;
  error?: string;
}

/**
 * Submit a new topic or reply post to the forum API.
 *
 * mode 'topic': POST /api/topics with { categorySlug, title, bodyMd }.
 *   On 201 resolves { ok: true, slug }.
 * mode 'post': POST /api/topics/<topicId>/posts with { bodyMd }.
 *   On 201 resolves { ok: true }.
 * Any non-2xx response resolves { ok: false, error }.
 * Never throws: network errors are caught and returned as { ok: false, error }.
 */
export async function submitComposer(args: {
  mode: 'topic' | 'post';
  payload: ComposerPayload;
  fetchImpl?: typeof fetch;
}): Promise<ComposerResult> {
  const fetcher = args.fetchImpl ?? fetch;
  const { mode, payload } = args;

  try {
    let url: string;
    let body: Record<string, string | undefined>;

    if (mode === 'topic') {
      url = '/api/topics';
      body = {
        categorySlug: payload.categorySlug,
        title: payload.title,
        bodyMd: payload.bodyMd,
      };
    } else {
      url = `/api/topics/${payload.topicId}/posts`;
      body = { bodyMd: payload.bodyMd };
    }

    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (response.status >= 200 && response.status < 300) {
      if (mode === 'topic') {
        const data = (await response.json()) as { ok: boolean; slug?: string };
        return { ok: true, slug: data.slug };
      }
      return { ok: true };
    }

    // Non-2xx: try to read a message from the response body.
    let errorMessage: string | undefined;
    try {
      const data = (await response.json()) as { error?: string };
      errorMessage = data.error;
    } catch {
      // Body unreadable; fall through to fallback.
    }

    return {
      ok: false,
      error: errorMessage ?? `Request failed with status ${response.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network error',
    };
  }
}

import { expect, type Page } from '@playwright/test';

export type Role = 'drep' | 'proposer' | 'delegator';

/** Matches the sign-in verify request or response. */
export const isVerify = (r: { url(): string }): boolean => r.url().endsWith('/api/auth/verify');

/**
 * A wallet account no earlier run has used, for tests that create an account:
 * on a dev machine the local database keeps accounts between runs.
 */
export const freshAccountIndex = (): number => Date.now() % 2 ** 31;

/**
 * Waits until every Astro island on the page has hydrated. A click on a
 * server-rendered island before hydration is lost, or React resets it, and a
 * retried click can mistake that brief state for success.
 */
export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(() => [...document.querySelectorAll('astro-island')].every((i) => !i.hasAttribute('ssr')));
}

/** Opens the login page for a role, waits for the injected wallet to be picked, clicks sign in. */
export async function signIn(page: Page, role: Role): Promise<void> {
  await page.goto(`/login?role=${role}`);
  await waitForHydration(page);
  const button = page.getByRole('button', { name: 'Sign in with wallet' });
  await expect(button).toBeEnabled();
  await button.click();
}

/** The JSON the verify endpoint answered, for flows that stop at role resolution. */
export async function verifyAnswer(page: Page, role: Role): Promise<{ status: number; error?: string }> {
  const response = page.waitForResponse(isVerify);
  await signIn(page, role);
  const r = await response;
  const body = (await r.json()) as { error?: string };
  return { status: r.status(), error: body.error };
}

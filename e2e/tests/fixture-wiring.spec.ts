import { expect, test } from './fixtures.js';

// Guards the wiring every other mock test depends on: the dev server must read
// Koios from the fixture server. Without KOIOS_BASE_URL it would read real
// preprod, and the other tests would fail in confusing ways or pass by luck.
test('the dev server reads Koios from the fixture server', async ({ page, koios }) => {
  // An epoch no real chain has, so the answer can only come from the fixture.
  await koios.set({ protocolParams: { epoch_no: 999_999 } });
  const res = await page.request.get('/api/koios/epoch_params?limit=1');
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject([{ epoch_no: 999_999 }]);
});

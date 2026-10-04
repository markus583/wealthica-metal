import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateValues, makePlan, executePlan, MAX_QUOTE_AGE_MS, MAX_PREVIEW_AGE_MS } from '../core.mjs';
const now = Date.parse('2026-10-04T21:10:00Z');
const config = { goldOz: 2.5, silverGrams: 311.034768, goldDiscount: 0, silverDiscount: 0, goldAsset: 'a'.repeat(24), silverAsset: 'b'.repeat(24) };
const quotes = { gold: { symbol: 'XAU', currency: 'EUR', price: 3680, updatedAt: new Date(now).toISOString() }, silver: { symbol: 'XAG', currency: 'EUR', price: 54, updatedAt: new Date(now).toISOString() } };
const assets = [{ _id: config.goldAsset, name: 'Gold', currency: 'eur', market_value: 9000 }, { _id: config.silverAsset, name: 'Silver', currency: 'eur', market_value: 500 }];
function mock(overrides = {}) {
  const records = structuredClone(assets), calls = [];
  return { calls, records, request: async args => {
    calls.push(args);
    if (overrides.request) await overrides.request(args, records);
    const asset = records.find(a => args.endpoint === `assets/${a._id}`);
    if (!asset) throw new Error('Missing asset');
    if (args.method === 'PUT') asset.market_value = args.body.market_value;
    return { ...asset };
  } };
}
test('fine troy-ounce conversion and independent resale deductions', () => {
  assert.deepEqual(calculateValues(config, quotes, now), { gold: 9200, silver: 540 });
  assert.equal(calculateValues({ ...config, goldDiscount: 2, silverDiscount: 5 }, quotes, now).gold, 9016);
  assert.equal(calculateValues({ ...config, silverGrams: 31.1034768 }, quotes, now).silver, 54);
});
test('rejects wrong metal/currency, invalid prices, stale and future quotes', () => {
  for (const change of [{ currency: 'USD' }, { symbol: 'BTC' }, { price: NaN }, { price: -1 }, { price: '3680' }, { updatedAt: 'bad' }, { updatedAt: new Date(now - MAX_QUOTE_AGE_MS - 1).toISOString() }, { updatedAt: new Date(now + 600001).toISOString() }]) {
    assert.throws(() => calculateValues(config, { ...quotes, gold: { ...quotes.gold, ...change } }, now));
  }
  for (const change of [{ goldOz: 0 }, { goldOz: 1e308 }, { silverGrams: 1e-308 }, { silverGrams: NaN }, { goldDiscount: 100 }, { silverDiscount: -1 }]) assert.throws(() => calculateValues({ ...config, ...change }, quotes, now));
});
test('rejects duplicated targets and non-EUR/deleted targets', () => {
  assert.throws(() => makePlan({ ...config, silverAsset: config.goldAsset }, quotes, assets, now));
  for (const change of [{ currency: 'cad' }, { deleted: true }, { market_value: NaN }]) assert.throws(() => makePlan(config, quotes, [{ ...assets[0], ...change }, assets[1]], now));
});
test('writes only market_value after validating both targets; verifies each write', async () => {
  const api = mock();
  const results = await executePlan(makePlan(config, quotes, assets, now), api.request, { now });
  assert.equal(results.filter(r => r.status === 'verified').length, 2);
  assert.deepEqual(api.calls.slice(0, 2).map(c => c.method), ['GET', 'GET']);
  assert.deepEqual(api.calls.filter(c => c.method === 'PUT').map(c => c.body), [{ market_value: 9200 }, { market_value: 540 }]);
});
test('stale previews and changed targets cause zero mutations', async () => {
  const plan = makePlan(config, quotes, assets, now);
  let api = mock();
  await assert.rejects(executePlan(plan, api.request, { now: now + MAX_PREVIEW_AGE_MS + 1 }));
  assert.equal(api.calls.length, 0);
  api = mock(); api.records[1].market_value = 999;
  await assert.rejects(executePlan(plan, api.request, { now }), /changed/);
  assert.equal(api.calls.filter(c => c.method === 'PUT').length, 0);
});
test('large changes require explicit opt-in', async () => {
  const changed = { ...config, goldOz: 10 };
  const api = mock(), plan = makePlan(changed, quotes, assets, now);
  await assert.rejects(executePlan(plan, api.request, { now }), /50%/);
  assert.equal(api.calls.filter(c => c.method === 'PUT').length, 0);
  const results = await executePlan(plan, api.request, { now, allowLargeChange: true });
  assert.equal(results[0].status, 'verified');
});
test('first mutation failure stops later writes and reports unconfirmed', async () => {
  const api = mock({ request: args => { if (args.method === 'PUT') throw new Error('Forbidden'); } });
  const results = await executePlan(makePlan(config, quotes, assets, now), api.request, { now });
  assert.equal(results.length, 1); assert.equal(results[0].status, 'unconfirmed');
  assert.equal(api.calls.filter(c => c.method === 'PUT').length, 1);
});
test('second mutation failure preserves the verified first result', async () => {
  const api = mock({ request: args => { if (args.method === 'PUT' && args.endpoint.endsWith(config.silverAsset)) throw new Error('Timeout'); } });
  const results = await executePlan(makePlan(config, quotes, assets, now), api.request, { now });
  assert.deepEqual(results.map(r => r.status), ['verified', 'unconfirmed']);
  assert.equal(api.records[0].market_value, 9200); assert.equal(api.records[1].market_value, 500);
});
test('tampered preview is rejected before any API calls', async () => {
  const plan = makePlan(config, quotes, assets, now); plan.items[0].after = 999999;
  const api = mock(); await assert.rejects(executePlan(plan, api.request, { now })); assert.equal(api.calls.length, 0);
});
test('a failed read-back stops the second write', async () => {
  let puts = 0;
  const api = mock({ request: args => { if (args.method === 'PUT') puts++; else if (puts) throw new Error('Read unavailable'); } });
  const results = await executePlan(makePlan(config, quotes, assets, now), api.request, { now });
  assert.equal(results[0].status, 'unconfirmed'); assert.equal(puts, 1);
});

export const GRAMS_PER_TROY_OUNCE = 31.1034768;
export const MAX_QUOTE_AGE_MS = 96 * 60 * 60 * 1000;
export const MAX_PREVIEW_AGE_MS = 5 * 60 * 1000;
const validId = /^[a-f\d]{24}$/i;

export function validateQuote(raw, symbol, now = Date.now()) {
  if (!raw || raw.symbol !== symbol || raw.currency !== 'EUR') {
    throw new Error(`${symbol}: the feed returned a different metal or currency.`);
  }
  if (typeof raw.price !== 'number' || !Number.isFinite(raw.price) || raw.price <= 0) {
    throw new Error(`${symbol}: the feed returned an invalid price.`);
  }
  const updated = Date.parse(raw.updatedAt);
  if (!Number.isFinite(updated) || updated > now + 5 * 60000 || now - updated > MAX_QUOTE_AGE_MS) {
    throw new Error(`${symbol}: the quote timestamp is missing, stale or in the future.`);
  }
  return { symbol, currency: 'EUR', price: raw.price, updatedAt: raw.updatedAt };
}

export function calculateValues(config, quotes, now = Date.now()) {
  const gold = validateQuote(quotes.gold, 'XAU', now);
  const silver = validateQuote(quotes.silver, 'XAG', now);
  for (const key of ['goldOz', 'silverGrams']) {
    if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] <= 0) {
      throw new Error('Enter a positive quantity for both metals. Use fine-metal weight.');
    }
  }
  for (const key of ['goldDiscount', 'silverDiscount']) {
    if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] < 0 || config[key] >= 100) {
      throw new Error('Each resale deduction must be between 0% and less than 100%.');
    }
  }
  const values = {
    gold: Math.round(config.goldOz * gold.price * (1 - config.goldDiscount / 100) * 100) / 100,
    silver: Math.round(config.silverGrams / GRAMS_PER_TROY_OUNCE * silver.price * (1 - config.silverDiscount / 100) * 100) / 100,
  };
  if (Object.values(values).some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error('The calculated value is invalid or rounds to zero. Check quantities and prices.');
  }
  return values;
}

export function validateAsset(asset, id) {
  if (!validId.test(id || '') || !asset || asset._id !== id || asset.deleted || asset.currency?.toLowerCase() !== 'eur') {
    throw new Error('Choose two different active EUR assets in your Wealthica account.');
  }
  if (typeof asset.market_value !== 'number' || !Number.isFinite(asset.market_value) || asset.market_value < 0) {
    throw new Error('The selected asset has no valid market value. Check it in Wealthica.');
  }
  return asset;
}

export function makePlan(config, quotes, assets, now = Date.now()) {
  if (!config.goldAsset || config.goldAsset === config.silverAsset) {
    throw new Error('Select a different Wealthica asset for each metal.');
  }
  const values = calculateValues(config, quotes, now);
  const items = ['gold', 'silver'].map(metal => {
    const id = config[`${metal}Asset`];
    const asset = validateAsset(assets.find(a => a._id === id), id);
    return { metal, id, name: asset.name, before: asset.market_value, after: values[metal] };
  });
  return { config: { ...config }, quotes, createdAt: now, items };
}

export async function executePlan(plan, request, { now = Date.now(), allowLargeChange = false } = {}) {
  if (!plan || now - plan.createdAt > MAX_PREVIEW_AGE_MS || plan.createdAt > now) {
    throw new Error('Refresh the preview before updating Wealthica.');
  }
  // Recompute from validated quantities and quotes; never trust a stored write value.
  const values = calculateValues(plan.config, plan.quotes, now);
  if (plan.items.length !== 2 || new Set(plan.items.map(i => i.id)).size !== 2 ||
      new Set(plan.items.map(i => i.metal)).size !== 2 ||
      plan.items.some(i => !['gold', 'silver'].includes(i.metal) ||
        i.id !== plan.config[`${i.metal}Asset`] || i.after !== values[i.metal])) {
    throw new Error('The preview has changed. Refresh it before updating.');
  }
  // Validate BOTH targets before any mutation. Only market_value is written.
  for (const item of plan.items) {
    const current = validateAsset(await request({ method: 'GET', endpoint: `assets/${item.id}` }), item.id);
    if (Math.abs(current.market_value - item.before) > 0.005) {
      throw new Error(`${item.name} changed in Wealthica. Refresh the preview.`);
    }
    if (item.before > 0 && Math.abs(item.after / item.before - 1) > 0.5 && !allowLargeChange) {
      throw new Error(`${item.name} changes by more than 50%. Check the mapping and allow a large change if intended.`);
    }
  }
  const results = [];
  for (const item of plan.items) {
    try {
      await request({ method: 'PUT', endpoint: `assets/${item.id}`, body: { market_value: item.after } });
    } catch (error) {
      results.push({ ...item, status: 'unconfirmed', error: String(error.message || error) });
      break; // An uncertain or failed mutation is never automatically retried.
    }
    try {
      const saved = validateAsset(await request({ method: 'GET', endpoint: `assets/${item.id}` }), item.id);
      if (Math.abs(saved.market_value - item.after) > 0.005) throw new Error('Read-back value differs from the requested value.');
      results.push({ ...item, status: 'verified' });
    } catch (error) {
      results.push({ ...item, status: 'unconfirmed', error: String(error.message || error) });
      break;
    }
  }
  return results;
}

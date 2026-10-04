import { calculateValues, validateQuote, makePlan, executePlan, shouldAutoUpdate } from './core.mjs';

const $ = id => document.getElementById(id);
const money = value => new Intl.NumberFormat('en-AT', { style: 'currency', currency: 'EUR' }).format(value);
let addon = null, connected = false, busy = false, assets = [], quotes = null, plan = null;
let fetchedAt = 0, savedData = {}, refreshPromise = null;
let automaticBlocked = false;
const fields = { goldOz: 'gold-oz', silverGrams: 'silver-grams', goldDiscount: 'gold-discount', silverDiscount: 'silver-discount', goldAsset: 'gold-asset', silverAsset: 'silver-asset' };
function config() {
  return Object.fromEntries(Object.entries(fields).map(([key, id]) => [key, key.endsWith('Asset') ? $(id).value : ($(id).value.trim() === '' ? NaN : Number($(id).value))]));
}
function message(text, style = '') { $('status').textContent = text; $('status').className = `status ${style}`; }
function buttons() {
  $('refresh').disabled = busy;
  $('save').disabled = busy || !connected;
  $('update').disabled = busy || !connected || !plan;
  document.querySelectorAll('input,select').forEach(el => { el.disabled = busy || (el.tagName === 'SELECT' && !connected); });
}
function invalidate() {
  plan = null;
  $('large-change').checked = false;
  $('results').replaceChildren();
  ['gold', 'silver'].forEach(m => { $(`${m}-change`).textContent = ''; });
  buttons();
}
function renderValues() {
  if (!quotes) return;
  try {
    const values = calculateValues(config(), quotes);
    for (const metal of ['gold', 'silver']) $(`${metal}-value`).textContent = money(values[metal]);
    $('total-value').textContent = money(values.gold + values.silver);
  } catch {
    $('gold-value').textContent = $('silver-value').textContent = $('total-value').textContent = '—';
  }
}
function request(args) {
  if (!connected) return Promise.reject(new Error('Open this page inside Wealthica’s Developer Add-on.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Wealthica did not respond within 30 seconds. Check the asset before retrying.')), 30000);
    addon.request(args).then(result => { clearTimeout(timer); resolve(result); }, error => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error?.message || error))); });
  });
}
async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error(`Price service returned HTTP ${response.status}.`);
  return response.json();
}
async function prices(force = false) {
  if (quotes && !force && Date.now() - fetchedAt < 30000) return;
  const [gold, silver] = await Promise.all([
    fetchJson('https://api.gold-api.com/price/XAU/EUR'),
    fetchJson('https://api.gold-api.com/price/XAG/EUR'),
  ]);
  // Only replace the pair if both prices validate.
  const next = { gold: validateQuote(gold, 'XAU'), silver: validateQuote(silver, 'XAG') };
  quotes = next;
  fetchedAt = Date.now();
  for (const metal of ['gold', 'silver']) {
    const q = quotes[metal];
    $(`${metal}-quote`).textContent = `${money(q.price)} / troy oz · Quote ${new Date(q.updatedAt).toLocaleString()}`;
  }
  $('retrieved').textContent = `Retrieved ${new Date(fetchedAt).toLocaleString()}`;
}
async function loadAssets() {
  const response = await request({ method: 'GET', endpoint: 'assets', query: { deleted: false } });
  if (!Array.isArray(response)) throw new Error('Wealthica returned an unexpected asset list.');
  assets = response.filter(a => !a.deleted && a.currency?.toLowerCase() === 'eur');
  for (const metal of ['gold', 'silver']) {
    const select = $(`${metal}-asset`), selected = select.value;
    select.replaceChildren(new Option(assets.length ? 'Choose the matching asset' : 'Create a EUR asset in Wealthica first', ''));
    for (const asset of assets) select.add(new Option(`${asset.name} · EUR`, asset._id));
    if (assets.some(a => a._id === selected)) select.value = selected;
  }
}
function restoreSettings(data) {
  const stored = data?.metalsTrackerV1;
  if (!stored || typeof stored !== 'object') return;
  for (const [key, id] of Object.entries(fields)) {
    if (key.endsWith('Asset')) {
      if (assets.some(a => a._id === stored[key])) $(id).value = stored[key];
    } else if (typeof stored[key] === 'number' && Number.isFinite(stored[key])) $(id).value = stored[key];
  }
}
async function refresh({ initial = false } = {}) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    busy = true; invalidate(); message('Fetching metal prices…');
    try {
      await Promise.all([prices(), ...(connected ? [loadAssets()] : [])]);
      if (initial) restoreSettings(savedData);
      renderValues();
      const settings = config();
      if (!Number.isFinite(settings.goldOz) || !Number.isFinite(settings.silverGrams)) {
        message('Enter your fine-metal quantities, then refresh the preview.');
      } else if (!connected) {
        calculateValues(settings, quotes);
        message('Values calculated. Open this URL in Wealthica’s Developer Add-on to save settings and update assets.');
      } else {
        plan = makePlan(settings, quotes, assets);
        for (const item of plan.items) $(`${item.metal}-change`).textContent = `${item.name}: ${money(item.before)} → ${money(item.after)}`;
        message('Preview ready. Check the selected assets and values, then press Update Wealthica.');
      }
    } catch (error) { message(error.message || String(error), 'error'); }
    finally { busy = false; buttons(); }
  })();
  try { await refreshPromise; } finally { refreshPromise = null; }
  if (connected && shouldAutoUpdate(savedData.metalsTrackerV1, config(), plan, automaticBlocked)) {
    await updateValues({ automatic: true });
  } else if (connected && plan && savedData.metalsTrackerV1 && !automaticBlocked &&
    !plan.items.some(item => Math.abs(item.after - item.before) > 0.005)) {
    message('Metal values are already up to date.', 'success');
  }
}
$('settings').addEventListener('submit', event => event.preventDefault());
for (const id of Object.values(fields)) $(id).addEventListener('input', () => {
  invalidate(); renderValues(); message('Settings changed. Refresh the preview before updating.');
});
$('refresh').addEventListener('click', () => refresh());
$('save').addEventListener('click', async () => {
  busy = true; buttons();
  try {
    const settings = config();
    // Validate selections and quantities without making any asset changes.
    if (!quotes) throw new Error('Refresh prices before saving settings.');
    makePlan(settings, quotes, assets);
    const nextData = { ...savedData, metalsTrackerV1: settings };
    await addon.saveData(nextData);
    savedData = nextData;
    message('Settings saved. Your saved holdings update automatically when this Power-Up opens.', 'success');
  } catch (error) { message(error.message || String(error), 'error'); }
  finally { busy = false; buttons(); }
  await refresh();
});
async function updateValues({ automatic = false } = {}) {
  if (busy || !plan) return;
  const activePlan = plan;
  busy = true; buttons(); $('results').replaceChildren();
  message('Checking the selected assets and updating their market values…');
  try {
    const results = await executePlan(activePlan, request, { allowLargeChange: !automatic && $('large-change').checked });
    for (const item of results) {
      const row = document.createElement('div'); row.className = `result-row ${item.status}`;
      row.textContent = item.status === 'verified' ? `${item.name}: ${money(item.after)} saved and verified.` : `${item.name}: update unconfirmed. ${item.error} Check this asset in Wealthica before retrying.`;
      $('results').append(row);
    }
    if (results.length === 2 && results.every(r => r.status === 'verified')) {
      automaticBlocked = false;
      message('Both metal values updated. Refresh the Wealthica dashboard to see them.', 'success');
    } else {
      automaticBlocked = true;
      const completed = results.filter(r => r.status === 'verified').length;
      message(`${completed} of 2 updates verified. Further updates stopped; check the results below.`, 'error');
    }
  } catch (error) {
    automaticBlocked = true;
    message(`${error.message || String(error)} Automatic updates paused for this session; check your assets before retrying.`, 'error');
  }
  finally {
    plan = null; busy = false; buttons();
    ['gold', 'silver'].forEach(m => { $(`${m}-change`).textContent = 'Refresh the preview before another update.'; });
  }
}
$('update').addEventListener('click', () => updateValues());

if (window.parent !== window && typeof window.Addon === 'function') {
  addon = new window.Addon();
  $('connection').textContent = 'Waiting for the Wealthica connection…';
  addon.on('init', async options => {
    connected = true; savedData = options?.data || {};
    $('connection').textContent = 'Connected to Wealthica. Choose your EUR gold and silver assets below.';
    await refresh({ initial: true });
  });
  addon.on('reload', () => { if (!busy) refresh(); });
  setInterval(() => {
    if (connected && !busy && !automaticBlocked && document.visibilityState === 'visible') refresh();
  }, 60 * 60 * 1000);
  setTimeout(() => {
    if (!connected) {
      $('connection').textContent = 'No Wealthica connection received. Load this URL through Wealthica’s Developer Add-on. You can still preview values here.';
      refresh();
    }
  }, 10000);
} else {
  $('connection').textContent = 'Calculator preview. Load this URL inside Wealthica’s Developer Add-on to update your assets.';
  refresh();
}

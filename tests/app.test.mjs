import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const settings = { goldOz: 1.25, silverGrams: 600, goldDiscount: 0, silverDiscount: 0, goldAsset: 'a'.repeat(24), silverAsset: 'b'.repeat(24) };
async function harness({ saved = settings, embedded = true, failWrite = false, largeChange = false } = {}) {
  const nodes = new Map(), calls = [], timers = [];
  class Element {
    get value() { return this._value; }
    set value(value) { this._value = String(value); }
    constructor(id) { this.id = id; this.value = id.endsWith('discount') ? '0' : ''; this.checked = false; this.events = {}; this.tagName = id.endsWith('asset') ? 'SELECT' : 'INPUT'; }
    addEventListener(event, fn) { this.events[event] = fn; }
    replaceChildren(...items) { this.children = items; if (this.tagName === 'SELECT') this.value = ''; }
    add(item) { (this.children ||= []).push(item); }
    append(item) { (this.children ||= []).push(item); }
  }
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id); };
  const assets = [{ _id: settings.goldAsset, name: 'Gold', currency: 'eur', market_value: largeChange ? 10 : 4600 }, { _id: settings.silverAsset, name: 'Silver', currency: 'eur', market_value: 1000 }];
  let addon;
  class Addon {
    constructor() { addon = this; this.events = {}; }
    on(event, fn) { this.events[event] = fn; }
    async saveData(data) { this.saved = data; }
    async request(args) {
      calls.push(args);
      if (args.endpoint === 'assets') return structuredClone(assets);
      const asset = assets.find(a => args.endpoint === `assets/${a._id}`);
      if (!asset) throw new Error('Missing asset');
      if (args.method === 'PUT') { if (failWrite) throw new Error('Write failed'); asset.market_value = args.body.market_value; }
      return { ...asset };
    }
  }
  const window = { Addon }; window.parent = embedded ? {} : window;
  const context = vm.createContext({ window, document: { getElementById: get, querySelectorAll: () => [...nodes.values()], createElement: () => new Element('div'), visibilityState: 'visible' },
    Option: class { constructor(label, value) { this.label = label; this.value = value; } },
    setTimeout: () => 1, clearTimeout() {}, setInterval: fn => timers.push(fn),
    AbortSignal: { timeout: () => undefined },
    fetch: async url => ({ ok: true, json: async () => ({ symbol: url.includes('XAU') ? 'XAU' : 'XAG', currency: 'EUR', price: url.includes('XAU') ? 3700 : 54, updatedAt: new Date().toISOString() }) }) });
  const core = new vm.SourceTextModule(await readFile(new URL('../core.mjs', import.meta.url), 'utf8'), { context });
  const app = new vm.SourceTextModule(await readFile(new URL('../app.mjs', import.meta.url), 'utf8'), { context });
  await core.link(() => {}); await app.link(() => core); await app.evaluate();
  if (embedded) await addon.events.init({ data: saved ? { metalsTrackerV1: saved } : {} });
  else for (let i = 0; i < 20; i++) await Promise.resolve();
  return { nodes, calls, addon, timers, assets, writes: () => calls.filter(c => c.method === 'PUT') };
}
test('saved settings update both assets on opening without a click and skip an unchanged refresh', async () => {
  const h = await harness();
  assert.equal(h.writes().length, 2);
  assert.equal(h.assets[0].market_value, 4625);
  assert.equal(h.assets[1].market_value, 1041.68);
  await h.nodes.get('refresh').events.click();
  assert.equal(h.writes().length, 2);
});
test('first use and standalone page never write', async () => {
  assert.equal((await harness({ saved: null })).writes().length, 0);
  assert.equal((await harness({ embedded: false })).writes().length, 0);
});
test('unsaved quantity changes are previewed without automatic writes; saving applies them', async () => {
  const h = await harness();
  h.nodes.get('gold-oz').value = '1.3'; h.nodes.get('gold-oz').events.input();
  await h.nodes.get('refresh').events.click();
  assert.equal(h.writes().length, 2);
  await h.nodes.get('save').events.click();
  assert.equal(h.writes().length, 4);
  assert.equal(h.assets[0].market_value, 4810);
});
test('uncertain writes pause automatic retries, and large changes do not write automatically', async () => {
  const h = await harness({ failWrite: true });
  assert.equal(h.writes().length, 1);
  await h.nodes.get('refresh').events.click();
  assert.equal(h.writes().length, 1);
  assert.equal((await harness({ largeChange: true })).writes().length, 0);
});

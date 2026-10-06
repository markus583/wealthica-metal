// All arithmetic uses integer minor units. Wealthica numbers are converted only at the API boundary.
const FIAT = new Set('eur cad chf usd gbp aud nzd jpy cny hkd sgd twd sek nok dkk pln huf ron brl mxn inr krw thb vnd zar aed'.split(' '));
export const clone = value => JSON.parse(JSON.stringify(value));
export const keyOf = (institution, investment) => `${institution}/${investment}`;
export const currencyDigits = currency => new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() }).resolvedOptions().maximumFractionDigits;
export function minor(value, currency) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('The account has no usable balance.');
  const result = Math.round(value * 10 ** currencyDigits(currency));
  if (!Number.isSafeInteger(result) || Math.abs(result) > 1e13) throw new Error('The amount is outside the supported range.');
  return result;
}
export const major = (value, currency) => value / 10 ** currencyDigits(currency);
export function parseAmount(text, currency, { signed = false, zero = false } = {}) {
  const input = String(text).trim().replace(',', '.');
  const digits = currencyDigits(currency);
  const pattern = new RegExp(`^${signed ? '-?' : ''}\\d{1,11}${digits ? `(\\.\\d{1,${digits}})?` : ''}$`);
  if (!pattern.test(input)) throw new Error(`Enter an amount with up to ${digits} decimal places, without thousands separators.`);
  const result = minor(Number(input), currency);
  if (!zero && result <= 0) throw new Error('Enter an amount greater than zero.');
  return result;
}
export function localDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function validDate(date, today = localDate()) {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== date || date > today) throw new Error('Choose a valid date up to today.');
  return date;
}
function currencyOf(account) {
  return (account.currency || account._id?.split(':').at(-1) || '').toLowerCase();
}
export function accountsFrom(institutions) {
  if (!Array.isArray(institutions)) throw new Error('Wealthica returned an unexpected account list.');
  const accounts = [];
  for (const institution of institutions) {
    if (institution.manual !== true || institution.deleted || !/^[a-f0-9]{24}$/.test(institution._id)) continue;
    for (const account of institution.investments || []) {
      const currency = currencyOf(account), type = account.type || account._id?.split(':').at(-2);
      if (account.ignored || account.inactive || !['cash', 'chequing', 'savings'].includes(type) || !FIAT.has(currency)) continue;
      // Manual securities portfolios are not cash ledgers, even if their account type is cash.
      if (account.positions?.some(p => Number(p.quantity) !== 0 || Number(p.market_value) !== 0)) continue;
      try {
        accounts.push({ key: keyOf(institution._id, account._id), institution: institution._id, investment: account._id,
          institutionName: institution.name || 'Manual institution', name: account.name || 'Account', currency,
          balance: minor(account.currency_value, currency), type });
      } catch { /* Unusable accounts remain untouched. */ }
    }
  }
  return accounts;
}
export function metadata(transaction) {
  const match = /^MA1\|([a-f0-9-]{36})\|(expense|income|transfer|external)\|(\d)\|(\d{13})\|(1|2)$/.exec(transaction.note || '');
  return match ? { id: match[1], kind: match[2], leg: Number(match[3]), created: Number(match[4]), count: Number(match[5]) } : null;
}
export function groupActivity(transactions) {
  const groups = new Map();
  for (const transaction of transactions) {
    const meta = metadata(transaction);
    if (!meta || transaction.deleted) continue;
    const group = groups.get(meta.id) || { ...meta, transactions: [], date: transaction.date?.slice(0, 10) };
    group.transactions.push(transaction); groups.set(meta.id, group);
  }
  return [...groups.values()].map(g => ({ ...g, complete: g.transactions.length === g.count && new Set(g.transactions.map(t => metadata(t).leg)).size === g.count && g.transactions.every(t => { const m=metadata(t);return m.kind===g.kind&&m.count===g.count&&m.created===g.created; }) }))
    .sort((a, b) => b.created - a.created);
}
function assertAccount(account, config) {
  if (!account || !config.enabled.includes(account.key) || !config.checkpoints[account.key]) throw new Error('Set a starting balance for this account in Setup first.');
}
function transactionState(t) {
  const state = {};
  for (const field of ['_id', 'institution', 'investment', 'currency', 'type', 'currency_amount', 'description', 'category', 'note']) state[field] = t[field] ?? null;
  state.deleted = Boolean(t.deleted);
  return state;
}
export function sameTransaction(actual, desired) {
  if (!actual) return false;
  return Object.entries(desired).every(([field, value]) => {
    if (field === 'currency_amount') return Math.abs(Number(actual[field]) - value) < 1e-8;
    if (field === 'deleted') return Boolean(actual[field]) === value;
    if (field === 'date') return actual[field]?.slice(0, 10) === value.slice(0, 10);
    return (actual[field] ?? null) === value;
  });
}
function investmentBody(account) {
  const currency = currencyOf(account);
  if (!FIAT.has(currency) || typeof account.currency_value !== 'number' || !Number.isFinite(account.currency_value)) throw new Error('An account in this institution has an unsupported balance. No account was changed.');
  const body = { _id: account._id, name: account.name || 'Account', currency_value: account.currency_value };
  for (const field of ['groups', 'group', 'ignored', 'category']) if (account[field] !== undefined) body[field] = clone(account[field]);
  return body;
}
function balanceSteps(institutions, changes) {
  const steps = [];
  for (const id of new Set(changes.map(c => c.institution))) {
    const institution = institutions.find(i => i._id === id);
    if (!institution || institution.manual !== true || institution.deleted) throw new Error('Only active manual institutions can be updated.');
    const before = institution.investments.map(investmentBody), after = clone(before);
    for (const change of changes.filter(c => c.institution === id)) {
      const row = after.find(a => a._id === change.investment);
      if (!row) throw new Error('The account no longer exists.');
      row.currency_value = major(change.after, change.currency);
    }
    steps.push({ action: 'balance', institution: id, before, after, state: 'pending' });
  }
  return steps;
}
export function makeEntry(input, accounts, institutions, config, { id = crypto.randomUUID(), now = Date.now() } = {}) {
  const source = accounts.find(a => a.key === input.account); assertAccount(source, config);
  const date = validDate(input.date);
  if (date < config.checkpoints[source.key].date) throw new Error('This entry predates your starting balance. Choose a later date.');
  const amount = parseAmount(input.amount, source.currency);
  const description = String(input.description || '').trim();
  if (!description || description.length > 300) throw new Error('Add a description of up to 300 characters.');
  if (input.category && !/^[a-f0-9]{24}$/.test(input.category)) throw new Error('Choose a valid Wealthica category.');
  if (!['expense', 'income', 'transfer', 'external'].includes(input.kind)) throw new Error('Choose an entry type.');
  const changes = [], transactions = [];
  function leg(account, delta, index, count) {
    changes.push({ ...account, before: account.balance, after: account.balance + delta });
    const body = { institution: account.institution, investment: account.investment, type: ['transfer', 'external'].includes(input.kind) ? 'transfer' : delta < 0 ? 'withdrawal' : 'deposit',
      currency_amount: major(delta, account.currency), amounts: [{ currency: account.currency, amount: major(delta, account.currency) }],
      description, note: `MA1|${id}|${input.kind}|${index}|${now}|${count}`, date: `${date}T12:00:00Z` };
    if (input.category && input.kind === 'expense') body.category = input.category;
    transactions.push({ action: 'create', body, state: 'pending' });
  }
  if (input.kind === 'transfer') {
    const target = accounts.find(a => a.key === input.to); assertAccount(target, config);
    if (source.key === target.key) throw new Error('Choose two different accounts.');
    if (date < config.checkpoints[target.key].date) throw new Error('This transfer predates the receiving account’s starting balance.');
    const received = source.currency === target.currency ? amount : parseAmount(input.received, target.currency);
    leg(source, -amount, 0, 2); leg(target, received, 1, 2);
  } else leg(source, input.kind === 'income' || (input.kind === 'external' && input.direction === 'in') ? amount : -amount, 0, 1);
  for (const change of changes) if (!Number.isSafeInteger(change.after) || Math.abs(change.after) > 1e13) throw new Error('The resulting balance is outside the supported range.');
  return { id, created: now, kind: input.kind, date, description, changes, steps: [...transactions, ...balanceSteps(institutions, changes)] };
}
export function makeAmend(group, input, accounts, institutions, config, { remove = false, id = crypto.randomUUID(), now = Date.now() } = {}) {
  if (!group.complete) throw new Error('A transfer leg is missing. Refresh or check Wealthica before editing.');
  const firstAccount = accounts.find(a => a.key === keyOf(group.transactions[0]?.institution, group.transactions[0]?.investment));
  const changes = [], steps = [];
  for (const transaction of [...group.transactions].sort((a, b) => metadata(a).leg - metadata(b).leg)) {
    const meta = metadata(transaction), account = accounts.find(a => a.key === keyOf(transaction.institution, transaction.investment)); assertAccount(account, config);
    if (meta.created < config.checkpoints[account.key].time) throw new Error('This entry was included in a later balance check. It can no longer change the balance from here.');
    const old = minor(transaction.currency_amount, account.currency);
    const amountInput = meta.leg && account.currency !== firstAccount?.currency ? input.received : input.amount;
    const newAmount = remove ? 0 : parseAmount(amountInput, account.currency) * (old < 0 ? -1 : 1);
    const body = { type: transaction.type, currency_amount: remove ? transaction.currency_amount : major(newAmount, account.currency), deleted: remove };
    if (!remove) {
      const description = String(input.description || '').trim();
      if (!description || description.length > 300) throw new Error('Add a description of up to 300 characters.');
      body.description = description;
      body.amounts = [{ currency: account.currency, amount: major(newAmount, account.currency) }];
    }
    steps.push({ action: 'update', transaction: transaction._id, before: transactionState(transaction), body, state: 'pending' });
    changes.push({ ...account, before: account.balance, after: account.balance + newAmount - old });
  }
  // Transfer groups have one leg per account. Reject malformed groups rather than apply duplicate changes.
  if (new Set(changes.map(c => c.key)).size !== changes.length) throw new Error('This entry has duplicated account legs.');
  return { id, created: now, kind: remove ? 'delete' : 'edit', date: group.date, description: remove ? `Delete ${group.transactions[0].description}` : input.description,
    changes, steps: [...steps, ...balanceSteps(institutions, changes)] };
}
export function makeReconcile(account, amount, institutions, { id = crypto.randomUUID(), now = Date.now() } = {}) {
  if (!account) throw new Error('Select a manual cash account.');
  const after = parseAmount(amount, account.currency, { signed: true, zero: true });
  const changes = [{ ...account, before: account.balance, after }];
  return { id, created: now, kind: 'reconcile', date: localDate(new Date(now)), description: 'Balance check', changes,
    checkpoint: { key: account.key, date: localDate(new Date(now)), time: now }, steps: balanceSteps(institutions, changes) };
}
export function sameBalances(institution, rows) {
  if (institution?.manual !== true || institution.deleted || institution.investments?.length !== rows.length) return false;
  return rows.every(row => {
    const account = institution.investments.find(a => a._id === row._id);
    if (!account) return false;
    return Object.entries(row).every(([field, value]) => field === 'currency_value' ? typeof account[field] === 'number' && Math.abs(account[field] - value) < 1e-8 : JSON.stringify(account[field] ?? (field === 'name' ? 'Account' : undefined)) === JSON.stringify(value));
  });
}
export async function assertFresh(operation, api) {
  for (const step of operation.steps.filter(s => s.action === 'balance')) {
    const current = await api.request({ method: 'GET', endpoint: `institutions/${step.institution}` });
    if (!sameBalances(current, step.before)) throw new Error('An account changed since the preview. Refresh and review the new balances.');
    const eligible = accountsFrom([current]);
    for (const change of operation.changes.filter(c => c.institution === step.institution)) if (!eligible.some(a => a.key === change.key && a.currency === change.currency)) throw new Error('The selected account is no longer eligible.');
  }
}
async function findCreated(step, api) {
  const date = step.body.date.slice(0, 10);
  const rows = await api.request({ method: 'GET', endpoint: 'transactions', query: { institutions: step.body.institution, from: date, to: date, deleted: false, skip_reset_new_transactions: true } });
  if (!Array.isArray(rows)) throw new Error('The transaction check returned an unexpected result.');
  const matches = rows.filter(t => t.note === step.body.note);
  if (matches.length > 1) throw new Error('Duplicate entries were found. Check the account in Wealthica before continuing.');
  return matches[0];
}
function desiredTransaction(body) {
  // 'amounts' is supplementary reporting data; the native-currency field is authoritative.
  const desired = { ...body }; delete desired.amounts; return desired;
}
export async function finishOperation(operation, api, persist) {
  // The caller serializes operations; all writes are preceded by a durable journal checkpoint.
  for (const step of operation.steps.filter(s => s.action === 'balance')) {
    const current = await api.request({ method: 'GET', endpoint: `institutions/${step.institution}` });
    const eligible = accountsFrom([current]);
    for (const change of operation.changes.filter(c => c.institution === step.institution)) {
      if (!eligible.some(a => a.key === change.key && a.currency === change.currency)) throw new Error('The account is no longer an eligible manual cash account.');
    }
    if (!sameBalances(current,step.before) && !sameBalances(current,step.after)) throw new Error('A balance changed elsewhere during this save. Check Wealthica before continuing.');
  }
  for (const step of operation.steps) {
    if (step.state === 'done') {
      if (step.action === 'balance') {
        const current=await api.request({method:'GET',endpoint:`institutions/${step.institution}`});
        if(!sameBalances(current,step.after))throw new Error('An already-saved balance changed elsewhere. Check Wealthica before continuing.');
      } else {
        const current=await api.request({method:'GET',endpoint:`transactions/${step.transaction}`});
        if(!sameTransaction(current,desiredTransaction(step.body)))throw new Error('An already-saved transaction changed elsewhere. Check Wealthica before continuing.');
      }
      continue;
    }
    if (step.action === 'create') {
      const found = await findCreated(step, api);
      if (found) {
        if (!sameTransaction(found, desiredTransaction(step.body))) throw new Error('A saved transaction differs from this operation. Check Wealthica.');
        step.transaction = found._id;
      } else {
        if (step.state === 'inflight') throw new Error('The interrupted transaction is not visible yet. Check again later; it will not be posted twice.');
        step.state = 'inflight'; await persist(operation);
        let result;
        try { result = await api.request({ method: 'POST', endpoint: 'transactions', body: step.body }); }
        catch (error) {
          // These HTTP responses are definitive rejections, not an uncertain network timeout.
          if ([400, 401, 403, 404, 422].includes(Number(error.status))) { step.state = 'rejected'; await persist(operation); }
          throw error;
        }
        if (!/^[a-f0-9]{24}$/.test(result?._id)) throw new Error('The transaction response could not be verified. Check & finish the pending save.');
        step.transaction = result._id;
      }
      const saved = await api.request({ method: 'GET', endpoint: `transactions/${step.transaction}` });
      if (!sameTransaction(saved, desiredTransaction(step.body))) throw new Error('The saved transaction could not be verified. Further writes stopped.');
    } else if (step.action === 'update') {
      const current = await api.request({ method: 'GET', endpoint: `transactions/${step.transaction}` });
      if (!sameTransaction(current, desiredTransaction(step.body))) {
        if (!sameTransaction(current, step.before)) throw new Error('The transaction was changed elsewhere. Check Wealthica before continuing.');
        step.state = 'inflight'; await persist(operation);
        await api.request({ method: 'PUT', endpoint: `transactions/${step.transaction}`, body: step.body });
      }
      const saved = await api.request({ method: 'GET', endpoint: `transactions/${step.transaction}` });
      if (!sameTransaction(saved, desiredTransaction(step.body))) throw new Error('The transaction change could not be verified.');
    } else if (step.action === 'balance') {
      const current = await api.request({ method: 'GET', endpoint: `institutions/${step.institution}` });
      if (!sameBalances(current, step.after)) {
        if (!sameBalances(current, step.before)) throw new Error('A balance changed elsewhere during this save. Reconcile it in Wealthica before continuing.');
        step.state = 'inflight'; await persist(operation);
        await api.request({ method: 'PUT', endpoint: `institutions/${step.institution}`, body: { investments: step.after } });
      }
      const saved = await api.request({ method: 'GET', endpoint: `institutions/${step.institution}` });
      if (!sameBalances(saved, step.after)) throw new Error('The account balance did not update as expected. Further writes stopped.');
    } else throw new Error('An unknown operation was blocked.');
    step.state = 'done'; await persist(operation);
  }
  return operation;
}

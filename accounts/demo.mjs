import { clone } from './core.mjs';
// Fictional examples. No personal financial data is shipped with this page.
export function makeDemo() {
  const data = [
    { _id: '000000000000000000000001', name: 'Volksbank', manual: true, investments: [
      { _id: 'demo-current:chequing:eur', name: 'Girokonto', type: 'chequing', currency: 'eur', currency_value: 1240.50, category: 'savings_and_checking', banking: true },
      { _id: 'demo-savings:cash:eur', name: 'Sparkonto', type: 'cash', currency: 'eur', currency_value: 7500, category: 'savings_and_checking', banking: true }] },
    { _id: '000000000000000000000002', name: 'Other accounts', manual: true, investments: [
      { _id: 'demo-ch:cash:chf', name: 'Swiss account', type: 'cash', currency: 'chf', currency_value: 420.35, category: 'savings_and_checking' },
      { _id: 'demo-wallet:cash:eur', name: 'Cash wallet', type: 'cash', currency: 'eur', currency_value: 68.20, category: 'savings_and_checking' },
      { _id: 'demo-test:cash:eur', name: 'Power-Up Test', type: 'cash', currency: 'eur', currency_value: 100, category: 'savings_and_checking' }] }
  ];
  let transactions = [], serial = 0;
  return {
    async request({ method, endpoint, body, query = {} }) {
      if (method === 'GET' && endpoint === 'users/me') return { _id: '000000000000000000000099' };
      if (method === 'GET' && endpoint === 'institutions') return clone(data);
      if (method === 'GET' && endpoint === 'categories') return [
        { _id: '000000000000000000000011', name: 'Groceries' },
        { _id: '000000000000000000000012', name: 'Shopping' },
        { _id: '000000000000000000000013', name: 'Transport' },
        { _id: '000000000000000000000014', name: 'Food & drink' }];
      if (endpoint.startsWith('institutions/')) {
        const item = data.find(i => i._id === endpoint.split('/')[1]);
        if (!item) throw new Error('Account not found.');
        if (method === 'PUT') item.investments = body.investments.map(a => ({ ...item.investments.find(old => old._id === a._id), ...clone(a) }));
        return clone(item);
      }
      if (method === 'POST' && endpoint === 'transactions') {
        const account = data.find(i => i._id === body.institution).investments.find(a => a._id === body.investment);
        const row = { ...clone(body), _id: (++serial).toString(16).padStart(24, '0'), currency: account.currency, user_created: true, deleted: false };
        transactions.push(row); return clone(row);
      }
      if (method === 'GET' && endpoint === 'transactions') return clone(transactions.filter(t => (!query.institutions || query.institutions.split(',').includes(t.institution)) && (!query.from || t.date.slice(0,10) >= query.from) && (!query.to || t.date.slice(0,10) <= query.to) && (query.deleted !== false || !t.deleted)));
      if (endpoint.startsWith('transactions/')) {
        const row = transactions.find(t => t._id === endpoint.split('/')[1]);
        if (!row) throw new Error('Transaction not found.');
        if (method === 'PUT') Object.assign(row, clone(body));
        return clone(row);
      }
      throw new Error(`Unsupported demo action: ${method} ${endpoint}`);
    },
    async save() {},
  };
}

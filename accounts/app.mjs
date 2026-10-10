import { accountsFrom, assertFresh, clone, finishOperation, groupActivity, keyOf, localDate, major, makeAmend, makeEntry, makeReconcile, metadata, minor, parseAmount } from './core.mjs';
import { makeDemo } from './demo.mjs';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cash = (amount, currency) => new Intl.NumberFormat('en-AT', { style:'currency', currency:currency.toUpperCase() }).format(major(amount,currency));
const today = () => localDate();
function icon(name) {
  const paths={home:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',entry:'<path d="M12 5v14M5 12h14"/>',activity:'<path d="M4 6h16M4 12h16M4 18h10"/>',setup:'<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>',refresh:'<path d="M20 7v5h-5M4 17v-5h5M5.5 7a7 7 0 0 1 12-1l2.5 3M4 15l2.5 3a7 7 0 0 0 12-1"/>'};
  return `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.home}</svg>`;
}
const dateLabel = date => date === today() ? 'Today' : new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB',{day:'numeric',month:'short'});
const app = $('app'), review = $('review-dialog'), edit = $('edit-dialog');
let adapter, addon, savedData = {}, profileId = '', initialized = false, toastTimer;
let cfg = { version:1, verified:false, enabled:[], checkpoints:{}, pending:null, probe:null };
const state = { demo:window.parent === window, busy:false, view:'home', kind:'expense', institutions:[], accounts:[], categories:[], transactions:[], groups:[], selected:'', filter:'', error:'', draft:{amount:'',description:'',date:today(),category:'',to:'',received:'',direction:'out'}, reviewOp:null, editing:null, setupAccount:'' };
function toast(text,error=false) { const el=$('toast');el.textContent=text;el.className=`show${error?' error':''}`;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.className='',6500); }
function account(key) { return state.accounts.find(a=>a.key===key); }
function managed() { return state.accounts.filter(a=>cfg.enabled.includes(a.key)&&cfg.checkpoints[a.key] && a.key!==cfg.probe?.key); }
function selected() { return account(state.selected); }
function usable() { return cfg.verified && !cfg.pending && managed().length>0; }
function checkpointLabel(a) { const cp=cfg.checkpoints[a.key];return cp?`Checked ${dateLabel(cp.date)}`:'Set a starting balance'; }
async function saveConfig() {
  const next={...savedData,manualAccountsV1:{...clone(cfg),owner:profileId}};
  if(new TextEncoder().encode(JSON.stringify(next)).length>95000)throw new Error('The recovery record is too large to save. No further writes were made.');
  await adapter.save(next);savedData=next;
}
function timed(promise) {
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Wealthica did not respond. Check & finish the pending save before entering another payment.')),30000);
    promise.then(v=>{clearTimeout(timer);resolve(v)},e=>{clearTimeout(timer);const err=new Error(e?.message||String(e));err.status=e?.status||e?.statusCode||e?.response?.status;reject(err)});
  });
}
async function load() {
  const institutions=await adapter.request({method:'GET',endpoint:'institutions',query:{deleted:false}});
  state.institutions=institutions;state.accounts=accountsFrom(institutions);
  // Balance checks move forward, but must not hide earlier Power-Up activity.
  const earliest=cfg.activityFrom||Object.values(cfg.checkpoints).map(c=>c.date).sort()[0]||today();
  const ids=[...new Set(state.accounts.map(a=>a.institution))];
  if(ids.length){
    const rows=await adapter.request({method:'GET',endpoint:'transactions',query:{institutions:ids.join(','),from:earliest,to:today(),deleted:false,skip_reset_new_transactions:true}});
    if(!Array.isArray(rows))throw new Error('Wealthica returned an unexpected transaction list.');
    state.transactions=rows;state.groups=groupActivity(rows);
  } else {state.transactions=[];state.groups=[];}
  if(!managed().some(a=>a.key===state.selected))state.selected=managed()[0]?.key||'';
}
function nav(view) { state.view=view;state.error='';render();window.scrollTo({top:0,behavior:'instant'});if(view==='entry')setTimeout(()=>$('entry-amount')?.focus({preventScroll:true}),50); }
function navButtons(mobile=false) {
  return [['home','Accounts'],['entry','Add entry'],['activity','Activity'],['setup','Setup']].map(([view,label])=>`<button type="button" data-nav="${view}" class="${state.view===view?'active':''}" aria-current="${state.view===view?'page':'false'}">${mobile?icon(view):''}${label}</button>`).join('');
}
function banners() {
  let result='';
  if(state.demo)result+=`<div class="banner"><span><strong>Interactive demo.</strong> These balances are fictional. Open this URL inside Wealthica’s Developer Add-on to use your accounts.</span><button class="button compact" data-action="install">How to connect</button></div>`;
  if(cfg.pending)result+=`<div class="banner error"><span><strong>A save needs checking.</strong> ${cfg.pending.steps.filter(s=>s.state==='done').length} of ${cfg.pending.steps.length} steps verified. New entries are paused.</span><button class="button compact" data-action="recover">Check & finish</button></div>`;
  else if(!cfg.verified)result+=`<div class="banner warning"><span><strong>One connection test first.</strong> Verify saving, editing and deleting on a temporary manual account.</span><button class="button compact" data-nav="setup">Set up</button></div>`;
  else if(!managed().length)result+=`<div class="banner"><span><strong>Ready to connect your manual accounts.</strong> Set an actual starting balance for each account.</span><button class="button compact" data-nav="setup">Choose accounts</button></div>`;
  if(state.error)result+=`<div class="banner error" role="alert">${esc(state.error)}</div>`;
  return result;
}
function totals() {
  const sums=new Map();for(const a of managed())sums.set(a.currency,(sums.get(a.currency)||0)+a.balance);
  return `<div class="summary">${[...sums].map(([currency,amount])=>`<div class="currency-summary"><span class="eyebrow">${currency.toUpperCase()} · manual total</span><strong>${cash(amount,currency)}</strong></div>`).join('')}</div>`;
}
function cards() {
  if(!managed().length)return `<div class="empty no-accounts"><strong>Your accounts belong here.</strong>Choose the manual accounts you use, then set their starting balances in Setup.</div>`;
  return managed().map(a=>`<button class="account-card ${a.key===state.selected?'selected':''}" data-account="${esc(a.key)}" aria-label="Add an entry to ${esc(a.name)}"><div class="account-top"><span class="account-icon" aria-hidden="true">${esc(a.name.slice(0,1))}</span><span class="account-currency">${a.currency.toUpperCase()}</span></div><div class="account-name">${esc(a.name)}</div><div class="institution-name">${esc(a.institutionName)}</div><div class="account-balance">${cash(a.balance,a.currency)}</div><div class="account-footer"><span class="tiny-dot"></span>${checkpointLabel(a)}</div></button>`).join('');
}
function activity(groups,emptyText='Save your first entry. It will appear here with its balance change.') {
  if(!groups.length)return `<div class="empty"><strong>A clean start.</strong>${emptyText}</div>`;
  return `<div class="activity-list">${groups.map(g=>{
    const sorted=[...g.transactions].sort((a,b)=>metadata(a).leg-metadata(b).leg),tx=sorted[0],a=account(keyOf(tx.institution,tx.investment));
    if(!a)return '';
    const amount=minor(tx.currency_amount,a.currency),locked=g.transactions.some(t=>metadata(t).created<(cfg.checkpoints[keyOf(t.institution,t.investment)]?.time||0));
    const other=sorted.length>1?account(keyOf(sorted[1].institution,sorted[1].investment)):null;
    return `<div class="activity-row"><span class="activity-icon ${g.kind}" aria-hidden="true">${g.kind==='income'?'↙':['transfer','external'].includes(g.kind)?'⇄':'↗'}</span><div class="activity-text"><strong>${esc(tx.description)}</strong><small>${dateLabel(g.date)} · ${esc(a.name)}${other?` → ${esc(other.name)}`:''}${locked?' · Included in balance check':''}</small></div><div class="activity-amount ${amount>0?'positive':''}">${amount>0?'+':''}${cash(amount,a.currency)}</div><button class="activity-edit" data-edit="${g.id}" aria-label="Edit ${esc(tx.description)}" ${locked||!g.complete?'disabled':''}>⋯</button></div>`;
  }).join('')}</div>`;
}
function options(list,value,includeEmpty=false) {return `${includeEmpty?'<option value="">Choose account</option>':''}${list.map(a=>`<option value="${esc(a.key)}" ${a.key===value?'selected':''}>${esc(a.institutionName)} · ${esc(a.name)} (${a.currency.toUpperCase()})</option>`).join('')}`;}
function entryPanel() {
  const a=selected(),d=state.draft;
  const transfer=state.kind==='transfer';
  const target=account(d.to),foreign=transfer&&target&&a&&target.currency!==a.currency;
  return `<section class="entry-panel" aria-label="Add entry"><div class="panel-head"><h2>Add an entry</h2><span>Balance included</span></div><div class="type-tabs" role="group" aria-label="Entry type">${['expense','income','transfer'].map(k=>`<button data-kind="${k}" class="${state.kind===k?'active':''}" aria-pressed="${state.kind===k}">${k[0].toUpperCase()+k.slice(1)}</button>`).join('')}</div><form id="entry-form"><div class="field"><label for="entry-account">${transfer?'From account':'Account'}</label><select id="entry-account" name="account" ${!managed().length?'disabled':''}>${options(managed(),state.selected,true)}</select></div>${transfer?`<div class="field"><label for="entry-to">To account</label><select id="entry-to" name="to"><option value="">Choose receiving account</option>${options(managed().filter(x=>x.key!==state.selected),d.to)}<option value="external" ${d.to==='external'?'selected':''}>External / connected account</option></select></div>${d.to==='external'?`<div class="field"><label for="entry-direction">Direction for this manual account</label><select id="entry-direction" name="direction"><option value="out" ${d.direction==='out'?'selected':''}>Money leaving</option><option value="in" ${d.direction==='in'?'selected':''}>Money arriving</option></select></div><p class="small muted">Only this manual account changes. The connected account updates through its own sync.</p>`:''}`:''}<label class="eyebrow" for="entry-amount">${transfer?'Amount sent':'Amount'}</label><div class="amount-wrap"><span id="entry-currency">${a?a.currency.toUpperCase():'EUR'}</span><input id="entry-amount" name="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(d.amount)}" aria-label="${transfer?'Amount sent':'Amount'}" required></div>${foreign?`<div class="field"><label for="entry-received">Actual amount received · ${target.currency.toUpperCase()}</label><input id="entry-received" name="received" inputmode="decimal" value="${esc(d.received)}" placeholder="Use the bank’s actual credited amount" required></div>`:''}<div class="field"><label for="entry-description">${transfer?'Transfer description':'What was it for?'}</label><input id="entry-description" name="description" maxlength="300" placeholder="${transfer?'e.g. Moving money to savings':'e.g. Groceries'}" value="${esc(d.description)}" required></div>${!transfer?`<div class="chips">${(state.kind==='expense'?['Groceries','Food & drink','Shopping','Transport']:['Interest','Payment received','Refund']).map(text=>`<button type="button" data-description="${esc(text)}">${text}</button>`).join('')}</div>`:''}<div class="row-fields"><div class="field"><label for="entry-date">Date</label><input id="entry-date" name="date" type="date" max="${today()}" min="${cfg.checkpoints[a?.key]?.date||today()}" value="${esc(d.date)}" required></div><div class="field"><label for="entry-category">Category</label><select id="entry-category" name="category" ${state.kind!=='expense'?'disabled':''}><option value="">No category</option>${state.categories.map(c=>`<option value="${esc(c._id)}" ${c._id===d.category?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div></div><div id="balance-preview" class="balance-preview"></div><div id="entry-error" class="inline-error" role="alert"></div><button class="button primary full" type="submit" ${!usable()?'disabled':''}>Review & save <span aria-hidden="true">↗</span></button><p class="entry-note">One entry. Transaction and balance saved together.<br>Nothing runs while this page is closed.</p></form></section>`;
}
function homeView() {
  return `<div class="workspace"><section class="accounts-side">${totals()}<div class="section-head"><h2>Your accounts</h2><button class="button compact soft" data-nav="setup">Manage</button></div><div class="account-grid">${cards()}</div><section class="recent-section"><div class="section-head"><h2>Recent activity</h2><button class="button compact" data-nav="activity">View all</button></div>${activity(state.groups.slice(0,5))}</section><p class="privacy-foot">Totals stay in their own currency. Linked bank and brokerage accounts remain in Wealthica’s main dashboard.</p></section>${entryPanel()}</div>`;
}
function activityView() {
  const list=state.groups.filter(g=>!state.filter||g.transactions.some(t=>keyOf(t.institution,t.investment)===state.filter));
  return `<section class="view-activity"><div class="activity-filter"><select id="activity-filter" aria-label="Filter activity"><option value="">All manual accounts</option>${options(managed(),state.filter)}</select><button class="button compact" data-action="export">Export CSV</button></div>${activity(list)}<p class="privacy-foot">Only entries saved with this Power-Up. Your previous imports remain in Wealthica’s Transactions view. Entries included in a later balance check are locked here.</p></section>`;
}
function setupView() {
  const testAccounts=state.accounts.filter(a=>/test|sandbox/i.test(a.name));
  const needsTest=!cfg.verified || (cfg.probe&&cfg.probe.stage<3);
  const pending=cfg.pending;
  return `<section class="settings-panel">${needsTest?`<section class="settings-section"><div class="section-head"><h2>Check the connection</h2><span class="status-badge off">${cfg.probe?`Step ${cfg.probe.stage+1} of 3`:'First use'}</span></div><p class="small muted">Use a disposable manual bank account named <strong>Power-Up Test</strong>. The test records a 1-unit expense, changes it to 0.50, then deletes it and restores the starting balance.</p><div class="setup-form"><div class="field"><label for="test-account">Temporary test account</label><select id="test-account" ${cfg.probe?'disabled':''}>${options(testAccounts,cfg.probe?.key||'',true)}</select></div><label class="check-label"><input id="test-confirm" type="checkbox" ${cfg.probe?'checked disabled':''}>This is a temporary account, not one of my real bank accounts.</label><div class="action-row"><button class="button primary" data-action="probe" ${pending?'disabled':''}>${cfg.probe?'Continue connection test':'Run connection test'}</button><button class="button" data-action="add-account">Add account in Wealthica</button></div></div><p class="privacy-foot">If an existing account is missing, it may not be a manual cash / chequing account, or it may contain securities. Refresh after creating the test account.</p></section>`:`<section class="settings-section"><div class="section-head"><h2>Connection checked</h2><span class="status-badge">${state.demo?'Demo mode':'Verified'}</span></div><p class="small muted">${state.demo?'The demo runs locally with fictional accounts. Live use still requires its own connection test.':'Saving, editing, deleting and balance updates passed on the test account.'}</p></section>`}
  <section class="settings-section"><h2>Your active accounts</h2><p class="small muted">Start each account with its actual balance today. Old imported transactions are kept as records and won’t be added again.</p>${state.accounts.filter(a=>!/test|sandbox/i.test(a.name)).map(a=>`<div class="setup-row"><div><div class="setup-name">${esc(a.name)} <span class="muted">· ${a.currency.toUpperCase()}</span></div><div class="small muted">${esc(a.institutionName)} · ${cash(a.balance,a.currency)} · ${checkpointLabel(a)}</div></div><button class="button compact ${cfg.enabled.includes(a.key)?'':'soft'}" data-reconcile="${esc(a.key)}" ${!cfg.verified||pending?'disabled':''}>${cfg.enabled.includes(a.key)?'Check balance':'Set balance'}</button></div>`).join('')||'<div class="empty">No eligible manual accounts found.</div>'}<div class="action-row"><button class="button compact" data-action="add-account">Add account in Wealthica</button><button class="button compact" data-action="refresh">Refresh accounts</button></div></section>
  ${pending?`<section class="settings-section"><h2>Pending save</h2><p class="small muted">${esc(pending.description)}. New entries are paused until this is resolved.</p><ol class="pending-steps">${pending.steps.map(s=>`<li>${s.action==='balance'?'Update account balance':s.action==='create'?'Record transaction':'Change transaction'} · ${s.state==='done'?'verified':s.state==='inflight'?'checking needed':s.state}</li>`).join('')}</ol><div class="action-row"><button class="button primary" data-action="recover">Check & finish</button><button class="button" data-action="recovery-export">Download recovery record</button>${pending.steps.every(s=>['pending','rejected'].includes(s.state))?'<button class="button danger" data-action="discard">Discard unstarted save</button>':''}</div></section>`:''}
  <section class="settings-section"><h2>A few useful rules</h2><ul class="hint-list"><li>Enter new activity here so transactions and balances agree.</li><li>Use <strong>Check balance</strong> to match a bank statement or cash count. It changes the balance without inventing income or spending.</li><li>For transfers between currencies, enter the actual debited and credited amounts. Include any fee in the amount leaving the source account.</li><li>External transfers update only the manual side; connected accounts keep their own sync.</li><li>Use one device/tab at a time. Wealthica’s API does not provide an atomic transaction-and-balance save.</li></ul><details><summary>Privacy and account compatibility</summary><p>This page sends account data only to Wealthica through its signed-in dashboard. There are no analytics or third-party price requests. Recovery information is stored in Wealthica’s add-on preferences. Public source contains no personal balances, account identifiers or credentials. Only active manual fiat cash, chequing and savings accounts without securities are eligible. Native app support depends on Wealthica; this page’s interface also works in a phone browser.</p></details><div class="action-row"><button class="button compact" data-action="export">Export entries</button><button class="button compact" data-action="backup">Download settings backup</button></div></section></section>`;
}
function render() {
  const titles={home:['Your money, kept in sync.','A useful home for the accounts you track yourself.'],entry:['One entry. Both updated.','Record activity and keep the account balance right.'],activity:['Every entry, together.','Payments, income and transfers saved here.'],setup:['Make it yours.','A clean starting balance. Your real accounts.']};
  const [title,subtitle]=titles[state.view];
  app.innerHTML=`${state.busy?'<div class="busy-indicator" role="status" aria-label="Saving"></div>':''}<div class="shell view-${state.view}"><header class="topbar"><div class="brand"><span class="brand-mark">m.</span><div><div class="brand-name">Manual accounts</div><div class="brand-sub">A Wealthica Power-Up</div></div></div><div class="top-actions"><span class="pill ${state.demo?'demo':''}"><span class="dot"></span>${state.demo?'Demo':'Wealthica'}</span><button class="icon-button" data-action="refresh" aria-label="Refresh accounts">↻</button></div></header><div class="welcome"><div><h1>${title}</h1><p>${subtitle}</p></div><nav class="desktop-nav" aria-label="Main navigation">${navButtons()}</nav></div>${banners()}${['home','entry'].includes(state.view)?homeView():state.view==='activity'?activityView():setupView()}<nav class="mobile-nav" aria-label="Mobile navigation">${navButtons(true)}</nav></div>`;
  if(state.busy)app.querySelectorAll('button,input,select').forEach(e=>e.disabled=true);
  updatePreview();
}
function collectDraft() {
  const form=$('entry-form');if(!form)return;
  const data=new FormData(form);
  state.selected=data.get('account')||state.selected;
  for(const key of ['amount','description','date','category','to','received','direction'])if(data.has(key))state.draft[key]=data.get(key);
}
function entryInput() {const d=state.draft;return {...d,account:state.selected,kind:state.kind==='transfer'&&d.to==='external'?'external':state.kind};}
function updatePreview() {
  const el=$('balance-preview');if(!el)return;
  const a=selected();
  if(!a){el.innerHTML='<span class="small muted">Choose an account to see its balance.</span>';return;}
  let amount=0;try{amount=parseAmount(state.draft.amount,a.currency);}catch{}
  const positive=state.kind==='income'||(state.kind==='transfer'&&state.draft.to==='external'&&state.draft.direction==='in');
  const after=a.balance+(positive?amount:-amount);
  el.innerHTML=`<div class="line"><span>Current balance</span><strong>${cash(a.balance,a.currency)}</strong></div><div class="line"><span>After this entry</span><strong>${cash(after,a.currency)}</strong></div>${after<0?'<p class="small muted">This will leave a negative balance.</p>':''}`;
}
function presentOperation(op,{confirmed}={}) {
  state.reviewOp=op;
  review.innerHTML=`<div class="dialog-head"><h2 id="review-title">${op.kind==='reconcile'?'Check account balance':op.kind==='delete'?'Delete this entry?':'Ready to save?'}</h2><button class="close" data-close="review-dialog" aria-label="Close">×</button></div><p class="review-type">${dateLabel(op.date)} · ${op.kind==='reconcile'?'Use the actual bank balance':op.kind==='delete'?'Transactions removed; balances corrected':op.kind==='edit'?'Transaction and balance corrected':op.kind==='external'?'Only the manual side changes':op.kind[0].toUpperCase()+op.kind.slice(1)}</p><div class="review-name">${esc(op.description)}</div>${op.changes.map(c=>`<div class="review-balance"><small>${esc(c.institutionName)} · ${esc(c.name)}</small><strong>${cash(c.before,c.currency)} <span class="muted">→</span> ${cash(c.after,c.currency)}</strong></div>`).join('')}<p class="small muted">${op.kind==='reconcile'?'Entries already included in this balance will be locked against later balance edits.':'Each write will be read back and checked.'}</p><div id="review-error" class="inline-error" role="alert"></div><div class="dialog-actions"><button class="button" data-close="review-dialog">Cancel</button><button class="button primary" data-action="confirm-save">${op.kind==='delete'?'Delete & correct balances':op.kind==='reconcile'?'Set verified balance':'Save entry'}</button></div>`;
  review.showModal();state.reviewConfirmed=confirmed;
}
async function runOperation(op,{recover=false}={}) {
  if(cfg.pending&&!recover)throw new Error('Finish the pending save first.');
  if(!recover) {
    await assertFresh(op,adapter);
    cfg.pending=clone(op);await saveConfig();
  }
  const active=cfg.pending;
  await finishOperation(active,adapter,async operation=>{cfg.pending=clone(operation);await saveConfig();});
  const completed=clone(active);
  if(completed.checkpoint){
    cfg.activityFrom ||= Object.values(cfg.checkpoints).map(c=>c.date).sort()[0]||completed.checkpoint.date;
    cfg.checkpoints[completed.checkpoint.key]=completed.checkpoint;if(!cfg.enabled.includes(completed.checkpoint.key))cfg.enabled.push(completed.checkpoint.key);
  }
  if(completed.probeStage!==undefined&&cfg.probe){cfg.probe.stage=completed.probeStage+1;if(completed.probeStage===0)cfg.probe.transaction=completed.steps.find(s=>s.action==='create').transaction;}
  cfg.pending=null;
  try {await saveConfig();} catch(error) {cfg.pending=completed;throw error;}
  await load();return completed;
}
async function exclusive(task) {
  if(state.busy)return;
  state.busy=true;state.error='';render();
  try {
    const run=()=>task();
    if(navigator.locks)await navigator.locks.request('wealthica-manual-accounts',{ifAvailable:true},async lock=>{if(!lock)throw new Error('Another tab is saving an entry. Finish there first.');return run();});
    else await run();
  } catch(error) {state.error=error.message||String(error);toast(state.error,true);}
  finally {state.busy=false;render();}
}
async function runProbe() {
  if(cfg.pending)throw new Error('Check & finish the pending save first.');
  if(!cfg.probe){
    const key=$('test-account')?.value,approved=$('test-confirm')?.checked;
    const a=account(key);
    if(!a||!/test|sandbox/i.test(a.name)||!approved)throw new Error('Choose a temporary account named Power-Up Test and confirm it is disposable.');
    if(!['eur','cad','chf','usd','gbp'].includes(a.currency))throw new Error('Use a EUR, CAD, CHF, USD or GBP test account.');
    cfg.probe={key,before:a.balance,stage:0,started:Date.now(),previousEnabled:[...cfg.enabled]};
    if(!cfg.enabled.includes(key))cfg.enabled.push(key);
    cfg.checkpoints[key]={date:today(),time:Date.now()-1};await saveConfig();
  }
  const probe=cfg.probe;
  if(!['eur','cad','chf','usd','gbp'].includes(account(probe.key)?.currency))throw new Error('Use a EUR, CAD, CHF, USD or GBP test account.');
  for(let phase=probe.stage;phase<3;phase++) {
    await load();const a=account(probe.key);if(!a)throw new Error('The test account disappeared.');
    let op;
    if(phase===0)op=makeEntry({kind:'expense',account:a.key,amount:'1',description:'Power-Up connection test',date:today()},state.accounts,state.institutions,cfg);
    else {
      const tx=await adapter.request({method:'GET',endpoint:`transactions/${probe.transaction}`});
      const group={...metadata(tx),transactions:[tx],date:tx.date.slice(0,10),complete:true};
      op=makeAmend(group,{amount:'0.50',description:'Power-Up connection test'},state.accounts,state.institutions,cfg,{remove:phase===2});
    }
    op.probeStage=phase;await runOperation(op);probe.stage=cfg.probe.stage;
  }
  await load();if(account(probe.key).balance!==probe.before)throw new Error('The test account did not return to its starting balance.');
  const deleted=await adapter.request({method:'GET',endpoint:`transactions/${probe.transaction}`});
  if(!deleted.deleted)throw new Error('The test transaction was not removed.');
  cfg.verified=true;cfg.enabled=probe.previousEnabled.filter(k=>k!==probe.key);cfg.lastProbe={date:today(),account:probe.key};cfg.probe=null;await saveConfig();
  await load();toast('Connection test passed. Choose your real accounts below.');
}
function showReconcile(key) {
  if(!cfg.verified||cfg.pending)return;
  const a=account(key);if(!a)return;
  state.setupAccount=key;
  edit.innerHTML=`<div class="dialog-head"><h2 id="edit-title">${cfg.enabled.includes(key)?'Check balance':'Set starting balance'}</h2><button class="close" data-close="edit-dialog" aria-label="Close">×</button></div><p class="small muted">${esc(a.institutionName)} · ${esc(a.name)}. Enter the actual balance from your bank or cash count.</p><form id="balance-form"><div class="field"><label for="actual-balance">Actual balance · ${a.currency.toUpperCase()}</label><input id="actual-balance" inputmode="decimal" value="${major(a.balance,a.currency)}" required></div><p class="small muted">Old imports won’t be added to this balance. A balance correction is not recorded as income or an expense.</p><div id="balance-error" class="inline-error" role="alert"></div><button class="button primary full" type="submit">Review balance</button></form>`;
  edit.showModal();
}
function showEdit(id) {
  if(state.busy||cfg.pending)return;
  const group=state.groups.find(g=>g.id===id);if(!group?.complete)return;
  state.editing=group;const rows=[...group.transactions].sort((a,b)=>metadata(a).leg-metadata(b).leg),first=rows[0],a=account(keyOf(first.institution,first.investment)),b=rows[1]&&account(keyOf(rows[1].institution,rows[1].investment));
  edit.innerHTML=`<div class="dialog-head"><h2 id="edit-title">Edit entry</h2><button class="close" data-close="edit-dialog" aria-label="Close">×</button></div><p class="small muted">${dateLabel(group.date)} · ${esc(a.name)}${b?` → ${esc(b.name)}`:''}</p><form id="amend-form"><div class="field"><label for="edit-amount">Amount · ${a.currency.toUpperCase()}</label><input id="edit-amount" name="amount" inputmode="decimal" value="${Math.abs(first.currency_amount)}" required></div>${b?`<div class="field"><label for="edit-received">Amount received · ${b.currency.toUpperCase()}</label><input id="edit-received" name="received" inputmode="decimal" value="${Math.abs(rows[1].currency_amount)}" required ${a.currency===b.currency?'readonly':''}></div>`:''}<div class="field"><label for="edit-description">Description</label><input id="edit-description" name="description" maxlength="300" value="${esc(first.description)}" required></div><div id="amend-error" class="inline-error" role="alert"></div><div class="dialog-actions"><button class="button danger" type="button" data-action="delete-entry">Delete entry</button><button class="button primary" type="submit">Review changes</button></div></form>`;
  edit.showModal();
  if(b&&a.currency===b.currency)$('edit-amount').addEventListener('input',()=>$('edit-received').value=$('edit-amount').value);
}
function download(name,content,type='application/json') {
  const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function csvCell(value){const text=String(value??'');return `"${/^[=+@\-]/.test(text)?"'":''}${text.replaceAll('"','""')}"`;}
function exportCsv(){const rows=[['Date','Institution','Account','Currency','Amount','Description','Type','Entry ID']];for(const group of state.groups)for(const tx of group.transactions){const a=account(keyOf(tx.institution,tx.investment));if(a)rows.push([tx.date.slice(0,10),a.institutionName,a.name,a.currency.toUpperCase(),String(tx.currency_amount),tx.description,group.kind,group.id]);}download(`manual-accounts-${today()}.csv`,'\ufeff'+rows.map(row=>row.map((value,index)=>index===4&&row!==rows[0]?String(value):csvCell(value)).join(',')).join('\r\n'),'text/csv;charset=utf-8');}
function installHelp(){
  edit.innerHTML=`<div class="dialog-head"><h2 id="edit-title">Open in Wealthica</h2><button class="close" data-close="edit-dialog" aria-label="Close">×</button></div><ol class="hint-list"><li>Open Wealthica in your browser.</li><li>Install/open the <a href="https://app.wealthica.com/addons/details?id=wealthica/wealthica-dev-addon" target="_blank" rel="noopener noreferrer">Developer Add-on</a>.</li><li>Open Configure and put this page’s URL in Add-on URL.</li><li>Load it, then follow the connection test in Setup.</li></ol><p class="small muted">The public page is a demo. Your real account data loads only through Wealthica.</p>`;edit.showModal();
}
app.addEventListener('input',event=>{if(event.target.closest('#entry-form')){collectDraft();updatePreview();}});
app.addEventListener('change',event=>{
  if(event.target.closest('#entry-form')){collectDraft();if(['entry-account','entry-to','entry-direction'].includes(event.target.id))render();else updatePreview();}
  if(event.target.id==='activity-filter'){state.filter=event.target.value;render();}
});
app.addEventListener('submit',event=>{
  if(event.target.id!=='entry-form')return;event.preventDefault();if(state.busy||!usable())return;
  collectDraft();try{presentOperation(makeEntry(entryInput(),state.accounts,state.institutions,cfg));}catch(error){$('entry-error').textContent=error.message;}
});
document.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button||button.disabled)return;
  if(button.dataset.close){if(!state.busy)$(button.dataset.close).close();return;}
  if(state.busy)return;
  if(button.dataset.nav){collectDraft();nav(button.dataset.nav);return;}
  if(button.dataset.account){collectDraft();state.selected=button.dataset.account;if(state.draft.to===state.selected)state.draft.to='';nav('entry');return;}
  if(button.dataset.kind){collectDraft();state.kind=button.dataset.kind;render();return;}
  if(button.dataset.description){state.draft.description=button.dataset.description;$('entry-description').value=state.draft.description;const c=state.categories.find(c=>c.name===state.draft.description);if(c){state.draft.category=c._id;$('entry-category').value=c._id;}return;}
  if(button.dataset.reconcile){showReconcile(button.dataset.reconcile);return;}
  if(button.dataset.edit){showEdit(button.dataset.edit);return;}
  const action=button.dataset.action;
  if(action==='install'){installHelp();return;}
  if(action==='export'){exportCsv();return;}
  if(action==='backup'){download(`manual-accounts-settings-${today()}.json`,JSON.stringify({config:cfg,exported:new Date().toISOString()},null,2));return;}
  if(action==='recovery-export'){download(`manual-accounts-recovery-${today()}.json`,JSON.stringify(cfg.pending,null,2));return;}
  if(action==='refresh'){collectDraft();exclusive(async()=>{await load();toast('Balances refreshed.');});return;}
  if(action==='add-account'){
    if(state.demo){toast('In Wealthica, add a manual bank account, then refresh this page.');return;}
    exclusive(async()=>{await addon.addInvestment();await load();});return;
  }
  if(action==='probe'){
    // Capture form data before exclusive() renders the busy state.
    const key=$('test-account')?.value,confirmed=$('test-confirm')?.checked;
    if(!cfg.probe){const a=account(key);if(!a||!/test|sandbox/i.test(a.name)||!confirmed){toast('Choose a temporary test account and tick the confirmation.',true);return;}
      cfg.probe={key,before:a.balance,stage:0,started:Date.now(),previousEnabled:[...cfg.enabled]};if(!cfg.enabled.includes(key))cfg.enabled.push(key);cfg.checkpoints[key]={date:today(),time:Date.now()-1};}
    exclusive(async()=>{await saveConfig();await runProbe();});return;
  }
  if(action==='recover'){exclusive(async()=>{await runOperation(cfg.pending,{recover:true});toast('Pending save checked and completed.');});return;}
  if(action==='discard'){
    if(cfg.pending?.steps.every(s=>['pending','rejected'].includes(s.state)))exclusive(async()=>{const pending=cfg.pending;cfg.pending=null;try{await saveConfig();}catch(error){cfg.pending=pending;throw error;}await load();toast('Unstarted save discarded.');});return;
  }
  if(action==='confirm-save'){
    const op=state.reviewOp;if(!op||cfg.pending)return;
    review.close();exclusive(async()=>{await runOperation(op);if(!['edit','delete','reconcile'].includes(op.kind)){state.draft={...state.draft,amount:'',description:'',received:'',date:today()};}state.reviewOp=null;toast(op.kind==='reconcile'?'Balance checked and saved.':op.kind==='delete'?'Entry deleted. Balances corrected.':'Saved. Transaction and balance verified.');});return;
  }
  if(action==='delete-entry'){
    try{const op=makeAmend(state.editing,{},state.accounts,state.institutions,cfg,{remove:true});edit.close();presentOperation(op);}catch(error){$('amend-error').textContent=error.message;}return;
  }
});
edit.addEventListener('submit',event=>{
  event.preventDefault();if(state.busy)return;
  try {
    let op;
    if(event.target.id==='balance-form')op=makeReconcile(account(state.setupAccount),$('actual-balance').value,state.institutions);
    else if(event.target.id==='amend-form')op=makeAmend(state.editing,Object.fromEntries(new FormData(event.target)),state.accounts,state.institutions,cfg);
    else return;
    edit.close();presentOperation(op);
  }catch(error){const el=$(event.target.id==='balance-form'?'balance-error':'amend-error');el.textContent=error.message;}
});
for(const dialog of [review,edit])dialog.addEventListener('cancel',event=>{if(state.busy)event.preventDefault();});
async function initialize(data={}) {
  if(initialized)return;initialized=true;savedData=data;
  try {
    const user=await adapter.request({method:'GET',endpoint:'users/me'});profileId=user._id;
    if(!/^[a-f0-9]{24}$/.test(profileId))throw new Error('The Wealthica user could not be verified.');
    if(data.manualAccountsV1){
      if(data.manualAccountsV1.owner!==profileId)throw new Error('These settings belong to a different Wealthica user. Switch back before continuing.');
      cfg=clone(data.manualAccountsV1);if(cfg.version!==1||!Array.isArray(cfg.enabled)||!cfg.checkpoints)throw new Error('The saved configuration format is not supported.');
      cfg.activityFrom ||= Object.values(cfg.checkpoints).map(c=>c.date).sort()[0]||today();
    }
    if(state.demo){
      const initial=await adapter.request({method:'GET',endpoint:'institutions'});const rows=accountsFrom(initial);
      cfg.verified=true;cfg.enabled=rows.filter(a=>!/test/i.test(a.name)).map(a=>a.key);
      cfg.checkpoints=Object.fromEntries(rows.map(a=>[a.key,{date:today(),time:Date.now()-100000}]));
    }
    try {const cats=await adapter.request({method:'GET',endpoint:'categories'});if(Array.isArray(cats))state.categories=cats.filter(c=>/^[a-f0-9]{24}$/.test(c._id)&&typeof c.name==='string');}catch{/* Categorization is optional; entry saves remain available. */}
    await load();
    if(state.demo){
      const op=makeEntry({kind:'expense',account:cfg.enabled[0],amount:'24.80',description:'Weekly groceries',date:today()},state.accounts,state.institutions,cfg,{now:Date.now()-50000});await runOperation(op);
      const next=makeEntry({kind:'income',account:cfg.enabled[0],amount:'40',description:'Payment received',date:today()},state.accounts,state.institutions,cfg,{now:Date.now()-30000});await runOperation(next);
    }else if(!cfg.verified||!managed().length)state.view='setup';
  }catch(error){state.error=error.message;state.view='setup';}
  render();
}
if(state.demo){adapter=makeDemo();initialize();}
else if(typeof window.Addon==='function'){
  addon=new window.Addon();adapter={request:args=>timed(addon.request(args)),save:data=>timed(addon.saveData(data))};
  addon.on('init',options=>initialize(options?.data||{}));
  addon.on('reload',()=>{if(initialized&&!state.busy&&!review.open&&!edit.open)exclusive(load);});
  setTimeout(()=>{if(!initialized){app.innerHTML='<div class="loading"><h1>Open through Wealthica</h1><p>Load this URL in the Developer Add-on. The Wealthica connection has not responded yet.</p></div>';}},15000);
}else{app.innerHTML='<div class="loading"><h1>Connection unavailable</h1><p>The Wealthica SDK could not load. Refresh this page.</p></div>';}

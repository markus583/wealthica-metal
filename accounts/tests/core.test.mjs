import test from 'node:test';
import assert from 'node:assert/strict';
import { accountsFrom, assertFresh, clone, finishOperation, groupActivity, localDate, major, makeAmend, makeEntry, makeReconcile, parseAmount } from '../core.mjs';
import { makeDemo } from '../demo.mjs';

async function fixture() {
  const api=makeDemo(), institutions=await api.request({method:'GET',endpoint:'institutions'}),accounts=accountsFrom(institutions);
  const cfg={verified:true,enabled:accounts.map(a=>a.key),checkpoints:Object.fromEntries(accounts.map(a=>[a.key,{date:localDate(),time:0}]))};
  const input={kind:'expense',account:accounts[0].key,amount:'10',description:'Test payment',date:localDate()};
  return {api,institutions,accounts,cfg,input};
}
async function fresh(f) {f.institutions=await f.api.request({method:'GET',endpoint:'institutions'});f.accounts=accountsFrom(f.institutions);}
async function groups(f){return groupActivity(await f.api.request({method:'GET',endpoint:'transactions',query:{deleted:false}}));}
const persist=async()=>{};
test('decimal amounts use minor units, including commas, zero and negative reconciliation',()=>{
  assert.equal(parseAmount('0.10','eur')+parseAmount('0,20','eur'),30);
  assert.equal(parseAmount('-12.30','chf',{signed:true,zero:true}),-1230);
  assert.equal(parseAmount('0','cad',{signed:true,zero:true}),0);
  for(const amount of ['1,000.20','1.234','1e3','-1','','NaN','Infinity','0'])assert.throws(()=>parseAmount(amount,'eur'));
  assert.throws(()=>parseAmount('1.1','jpy'));assert.equal(parseAmount('150','jpy'),150);
});
test('only manual cash accounts are eligible; connected, ignored, securities and unsupported currencies are excluded',async()=>{
  const f=await fixture();const rows=clone(f.institutions);rows[0].manual=false;
  rows[1].investments[0].ignored=true;rows[1].investments[1].positions=[{quantity:1,market_value:2}];rows[1].investments[2].currency='btc';
  assert.equal(accountsFrom(rows).length,0);
});
test('expense, edit and delete update the transaction and restore the exact balance',async()=>{
  const f=await fixture(),initial=f.accounts[0].balance;
  const op=makeEntry(f.input,f.accounts,f.institutions,f.cfg);await assertFresh(op,f.api);await finishOperation(op,f.api,persist);await fresh(f);
  assert.equal(f.accounts[0].balance,initial-1000);let group=(await groups(f))[0];assert.equal(group.transactions[0].currency_amount,-10);
  const edited=makeAmend(group,{amount:'5',description:'Corrected payment'},f.accounts,f.institutions,f.cfg);await finishOperation(edited,f.api,persist);await fresh(f);
  assert.equal(f.accounts[0].balance,initial-500);group=(await groups(f))[0];assert.equal(group.transactions[0].description,'Corrected payment');
  const removed=makeAmend(group,{},f.accounts,f.institutions,f.cfg,{remove:true});await finishOperation(removed,f.api,persist);await fresh(f);
  assert.equal(f.accounts[0].balance,initial);assert.equal((await groups(f)).length,0);
});
test('income has a positive balance effect',async()=>{
  const f=await fixture(),initial=f.accounts[0].balance;
  await finishOperation(makeEntry({...f.input,kind:'income',amount:'0.30'},f.accounts,f.institutions,f.cfg),f.api,persist);await fresh(f);
  assert.equal(f.accounts[0].balance,initial+30);
});
test('same-institution transfer is one balance write, conserves money and preserves siblings',async()=>{
  const f=await fixture(),a=f.accounts[0],b=f.accounts[1];
  const op=makeEntry({...f.input,kind:'transfer',to:b.key,amount:'500'},f.accounts,f.institutions,f.cfg);
  assert.equal(op.steps.filter(s=>s.action==='balance').length,1);
  await finishOperation(op,f.api,persist);await fresh(f);
  assert.equal(f.accounts[0].balance,a.balance-50000);assert.equal(f.accounts[1].balance,b.balance+50000);
  assert.equal(f.accounts[0].balance+f.accounts[1].balance,a.balance+b.balance);assert.equal((await groups(f))[0].complete,true);
});
test('editing a same-currency transfer cannot create money from mismatched receiving input',async()=>{
  const f=await fixture(),total=f.accounts[0].balance+f.accounts[1].balance;
  await finishOperation(makeEntry({...f.input,kind:'transfer',to:f.accounts[1].key,amount:'100'},f.accounts,f.institutions,f.cfg),f.api,persist);await fresh(f);
  const group=(await groups(f))[0];
  await finishOperation(makeAmend(group,{amount:'50',received:'999',description:'Corrected transfer'},f.accounts,f.institutions,f.cfg),f.api,persist);await fresh(f);
  assert.equal(f.accounts[0].balance+f.accounts[1].balance,total);
  assert.deepEqual((await groups(f))[0].transactions.map(t=>t.currency_amount),[-50,50]);
});
test('cross-currency transfer uses actual amounts and editing/deleting both legs preserves units',async()=>{
  const f=await fixture(),a=f.accounts[0],b=f.accounts[2];
  await finishOperation(makeEntry({...f.input,kind:'transfer',to:b.key,amount:'100',received:'94.50'},f.accounts,f.institutions,f.cfg),f.api,persist);await fresh(f);
  assert.equal(f.accounts[0].balance,a.balance-10000);assert.equal(f.accounts[2].balance,b.balance+9450);
  const op=makeAmend((await groups(f))[0],{amount:'200',received:'190',description:'Transfer corrected'},f.accounts,f.institutions,f.cfg);await finishOperation(op,f.api,persist);await fresh(f);
  assert.equal(f.accounts[0].balance,a.balance-20000);assert.equal(f.accounts[2].balance,b.balance+19000);
  await finishOperation(makeAmend((await groups(f))[0],{},f.accounts,f.institutions,f.cfg,{remove:true}),f.api,persist);await fresh(f);
  assert.equal(f.accounts[0].balance,a.balance);assert.equal(f.accounts[2].balance,b.balance);
});
test('external transfers touch only the manual side, with correct incoming/outgoing signs',async()=>{
  const f=await fixture();const initial=f.accounts[0].balance;
  for(const direction of ['out','in']){const op=makeEntry({...f.input,kind:'external',direction},f.accounts,f.institutions,f.cfg);assert.equal(op.changes.length,1);assert.equal(op.steps.filter(s=>s.action==='create').length,1);await finishOperation(op,f.api,persist);await fresh(f);}
  assert.equal(f.accounts[0].balance,initial);
});
test('foreign-currency transfer edits use the correct units when the API returns receiving leg first',async()=>{
  const f=await fixture(),source=f.accounts[0],target=f.accounts[2];
  await finishOperation(makeEntry({...f.input,kind:'transfer',to:target.key,amount:'100',received:'94'},f.accounts,f.institutions,f.cfg),f.api,persist);await fresh(f);
  const group=(await groups(f))[0];group.transactions.reverse();
  await finishOperation(makeAmend(group,{amount:'200',received:'185',description:'Corrected FX transfer'},f.accounts,f.institutions,f.cfg),f.api,persist);await fresh(f);
  assert.equal(f.accounts[0].balance,source.balance-20000);
  assert.equal(f.accounts[2].balance,target.balance+18500);
});
test('stale balance or sibling changes block a preview before any transaction is posted',async()=>{
  const f=await fixture(),op=makeEntry(f.input,f.accounts,f.institutions,f.cfg);
  const rows=clone(f.institutions[0].investments);rows[1].currency_value+=10;
  await f.api.request({method:'PUT',endpoint:`institutions/${f.institutions[0]._id}`,body:{investments:rows}});
  await assert.rejects(assertFresh(op,f.api),/changed since/);assert.equal((await groups(f)).length,0);
});
test('failed journal persistence prevents the first financial write',async()=>{
  const f=await fixture(),op=makeEntry(f.input,f.accounts,f.institutions,f.cfg);let writes=0;
  const api={request:async args=>{if(args.method!=='GET')writes++;return f.api.request(args);}};
  await assert.rejects(finishOperation(op,api,async()=>{throw new Error('Storage unavailable')}),/Storage/);assert.equal(writes,0);
});
test('unknown POST outcome is recovered by marker, without posting another transaction',async()=>{
  const f=await fixture(),initial=f.accounts[0].balance,op=makeEntry(f.input,f.accounts,f.institutions,f.cfg);let fail=true,posts=0;
  const api={request:async args=>{if(args.method==='POST'){posts++;const result=await f.api.request(args);if(fail){fail=false;throw new Error('Network timeout')}return result;}return f.api.request(args);}};
  let journal;await assert.rejects(finishOperation(op,api,async o=>journal=clone(o)),/timeout/);
  assert.equal(journal.steps[0].state,'inflight');await finishOperation(journal,api,persist);await fresh(f);
  assert.equal(posts,1);assert.equal((await groups(f)).length,1);assert.equal(f.accounts[0].balance,initial-1000);
});
test('unknown POST with no visible row pauses instead of blindly retrying',async()=>{
  const f=await fixture(),op=makeEntry(f.input,f.accounts,f.institutions,f.cfg);let posts=0;
  const api={request:async args=>{if(args.method==='POST'){posts++;throw new Error('Disconnected')}return f.api.request(args);}};
  await assert.rejects(finishOperation(op,api,persist),/Disconnected/);await assert.rejects(finishOperation(op,api,persist),/not visible yet/);assert.equal(posts,1);
});
test('definitively rejected POST is marked rejected so an untouched operation can be discarded',async()=>{
  const f=await fixture(),op=makeEntry(f.input,f.accounts,f.institutions,f.cfg);
  const api={request:async args=>{if(args.method==='POST'){const error=new Error('Forbidden');error.status=403;throw error;}return f.api.request(args);}};
  await assert.rejects(finishOperation(op,api,persist),/Forbidden/);assert.equal(op.steps[0].state,'rejected');assert.equal((await groups(f)).length,0);
});
test('a balance PUT that commits then times out is verified on recovery without double deduction',async()=>{
  const f=await fixture(),initial=f.accounts[0].balance,op=makeEntry(f.input,f.accounts,f.institutions,f.cfg);let failed=false,puts=0;
  const api={request:async args=>{const r=await f.api.request(args);if(args.method==='PUT'&&args.endpoint.startsWith('institutions/')){puts++;if(!failed){failed=true;throw new Error('Lost acknowledgement')}}return r;}};
  await assert.rejects(finishOperation(op,api,persist),/acknowledgement/);await finishOperation(clone(op),api,persist);await fresh(f);
  assert.equal(puts,1);assert.equal(f.accounts[0].balance,initial-1000);
});
test('partial cross-institution transfer resumes remaining balance write exactly once',async()=>{
  const f=await fixture(),a=f.accounts[0],b=f.accounts[2],op=makeEntry({...f.input,kind:'transfer',to:b.key,amount:'100',received:'94'},f.accounts,f.institutions,f.cfg);let failed=false,firstWrites=0;
  const api={request:async args=>{if(args.method==='PUT'&&args.endpoint===`institutions/${b.institution}`&&!failed){failed=true;throw new Error('Offline before second balance')}if(args.method==='PUT'&&args.endpoint===`institutions/${a.institution}`)firstWrites++;return f.api.request(args);}};
  await assert.rejects(finishOperation(op,api,persist),/Offline/);await finishOperation(clone(op),api,persist);await fresh(f);
  assert.equal(firstWrites,1);assert.equal(f.accounts[0].balance,a.balance-10000);assert.equal(f.accounts[2].balance,b.balance+9400);
});
test('conflicting balance during a pending save stops recovery',async()=>{
  const f=await fixture(),op=makeEntry(f.input,f.accounts,f.institutions,f.cfg);op.steps[0].state='inflight';
  await f.api.request({method:'POST',endpoint:'transactions',body:op.steps[0].body});
  const rows=clone(f.institutions[0].investments);rows[0].currency_value+=1;await f.api.request({method:'PUT',endpoint:`institutions/${f.institutions[0]._id}`,body:{investments:rows}});
  await assert.rejects(finishOperation(op,f.api,persist),/changed elsewhere/);await fresh(f);assert.equal(f.accounts[0].balance,minorOriginal(f)+100);
  function minorOriginal(){return Math.round(1240.50*100)}
});
test('statement reconciliation creates no spending transaction and locks earlier entry balance edits',async()=>{
  const f=await fixture();await finishOperation(makeEntry(f.input,f.accounts,f.institutions,f.cfg),f.api,persist);await fresh(f);
  const group=(await groups(f))[0],op=makeReconcile(f.accounts[0],'2000',f.institutions,{now:Date.now()+1});await finishOperation(op,f.api,persist);await fresh(f);
  assert.equal(f.accounts[0].balance,200000);assert.equal((await groups(f)).length,1);f.cfg.checkpoints[op.checkpoint.key]=op.checkpoint;
  assert.throws(()=>makeAmend(group,{amount:'5',description:'Old expense'},f.accounts,f.institutions,f.cfg),/later balance check/);
});
test('entries before a starting balance, future dates, self transfers and incomplete groups are blocked',async()=>{
  const f=await fixture();assert.throws(()=>makeEntry({...f.input,date:'2020-01-01'},f.accounts,f.institutions,f.cfg),/predates/);
  assert.throws(()=>makeEntry({...f.input,date:'2099-01-01'},f.accounts,f.institutions,f.cfg),/valid date/);
  assert.throws(()=>makeEntry({...f.input,kind:'transfer',to:f.accounts[0].key},f.accounts,f.institutions,f.cfg),/different/);
  assert.throws(()=>makeAmend({complete:false},{},f.accounts,f.institutions,f.cfg),/leg is missing/);
});
test('connected institutions cannot be targeted even through a constructed reconciliation',async()=>{
  const f=await fixture(),op=makeReconcile(f.accounts[0],'100',f.institutions);const rows=clone(f.institutions[0].investments);
  // A wrapper changes the live manual flag while retaining the original financial data.
  const api={request:async args=>{const result=await f.api.request(args);return args.method==='GET'&&args.endpoint.startsWith('institutions/')?{...result,manual:false}:result;}};
  await assert.rejects(finishOperation(op,api,persist),/eligible manual/);
});
test('already-verified transaction edits elsewhere are detected before completing a pending balance',async()=>{
  const f=await fixture(),op=makeEntry(f.input,f.accounts,f.institutions,f.cfg);
  const tx=await f.api.request({method:'POST',endpoint:'transactions',body:op.steps[0].body});op.steps[0].transaction=tx._id;op.steps[0].state='done';
  await f.api.request({method:'PUT',endpoint:`transactions/${tx._id}`,body:{currency_amount:-20}});
  await assert.rejects(finishOperation(op,f.api,persist),/already-saved transaction/);await fresh(f);assert.equal(f.accounts[0].balance,124050);
});
test('a stale balance discovered after journaling blocks posting, not merely the later balance write',async()=>{
  const f=await fixture(),op=makeEntry(f.input,f.accounts,f.institutions,f.cfg);
  const rows=clone(f.institutions[0].investments);rows[0].currency_value+=1;await f.api.request({method:'PUT',endpoint:`institutions/${f.institutions[0]._id}`,body:{investments:rows}});
  await assert.rejects(finishOperation(op,f.api,persist),/changed elsewhere/);assert.equal((await groups(f)).length,0);
});

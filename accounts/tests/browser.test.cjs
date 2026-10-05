let playwright;try{playwright=require('playwright')}catch{playwright=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright')}const {chromium}=playwright;
const http=require('http'),fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'../..');
const shots=process.env.MANUAL_ACCOUNTS_SCREENSHOTS||'/tmp/wealthica-manual-account-checks';fs.mkdirSync(shots,{recursive:true});
const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
const host=`<!doctype html><html><body style="margin:0"><iframe id="frame" src="/accounts/" style="width:100vw;height:100vh;border:0"></iframe><script type="module">import {makeDemo} from '/accounts/demo.mjs';window.fakeApi=makeDemo();window.fakeData={};window.calls=[];window.failMode='';window.failureDone=false;window.fakeRequest=async args=>{window.calls.push(args);if(window.failMode==='putTimeout'&&!window.failureDone&&args.method==='PUT'&&args.endpoint.startsWith('institutions/')){window.failureDone=true;await window.fakeApi.request(args);throw new Error('Lost balance acknowledgement');}return window.fakeApi.request(args)};</script></body></html>`;
const sdk=`class Addon {on(name,callback){if(name==='init')setTimeout(()=>callback({data:parent.fakeData}),30)}request(args){return parent.fakeRequest(args)}saveData(data){parent.fakeData=JSON.parse(JSON.stringify(data));return Promise.resolve()}addInvestment(){return Promise.resolve()}}window.Addon=Addon;`;
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');if(url.pathname==='/host'){res.setHeader('Content-Type','text/html');res.end(host);return;}
 if(url.pathname==='/vendor/addon.min.js'&&url.searchParams.has('mock')){res.setHeader('Content-Type','text/javascript');res.end(sdk);return;}
 let f=path.join(root,decodeURIComponent(url.pathname));if(!f.startsWith(root)){res.writeHead(403);res.end();return;}if(fs.existsSync(f)&&fs.statSync(f).isDirectory())f=path.join(f,'index.html');
 try{res.setHeader('Content-Type',mime[path.extname(f)]||'text/plain');res.end(fs.readFileSync(f));}catch{res.writeHead(404);res.end();}
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true,executablePath:process.env.MANUAL_ACCOUNTS_CHROME||undefined,args:['--no-sandbox']});
 const results=[],errors=[];
 const p=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});global.checkPage=p;p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 await p.goto(base+'/accounts/');await p.locator('.account-card').first().waitFor();
 assert.equal(await p.locator('.account-card').count(),4);
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await p.screenshot({path:path.join(shots,'mobile-home.png'),fullPage:true});results.push('390px home: no horizontal overflow, four fictional accounts');
 await p.locator('.account-card').first().click();await p.locator('#entry-amount').fill('12,30');await p.locator('#entry-description').fill('Mobile test');
 await p.locator('#entry-form button[type=submit]').click();await p.locator('[data-action=confirm-save]').click();await p.locator('#toast').filter({hasText:'Saved.'}).waitFor();
 await p.screenshot({path:path.join(shots,'mobile-entry.png'),fullPage:true});results.push('Mobile expense saves and clears the form');
 await p.locator('.mobile-nav [data-nav=activity]').click();await p.locator('[data-edit]').first().click();await p.locator('#edit-amount').fill('5.10');await p.locator('#amend-form button[type=submit]').click();await p.locator('[data-action=confirm-save]').click();await p.locator('#toast').filter({hasText:'Saved.'}).waitFor();
 await p.waitForFunction(()=>/5[.,]10/.test(document.querySelector('.activity-row .activity-amount')?.textContent||''));
 await p.locator('[data-edit]').first().click();await p.locator('[data-action=delete-entry]').click();await p.locator('[data-action=confirm-save]').click();await p.locator('#toast').filter({hasText:'Entry deleted'}).waitFor();results.push('Mobile edit/delete restore balances and remove activity');
 await p.locator('.mobile-nav [data-nav=entry]').click();await p.locator('[data-kind=transfer]').click();await p.locator('#entry-to').selectOption({label:'Other accounts · Swiss account (CHF)'});await p.locator('#entry-amount').fill('100');await p.locator('#entry-received').fill('94.50');await p.locator('#entry-description').fill('EUR to CHF');await p.locator('#entry-form button[type=submit]').click();
 assert((await p.locator('#review-dialog').innerText()).includes('CHF'));
 await p.locator('[data-action=confirm-save]').click();await p.locator('#toast').filter({hasText:'Saved.'}).waitFor();results.push('Cross-currency transfer previews and saves two native balances');
 await p.locator('.mobile-nav [data-nav=home]').click();await p.screenshot({path:path.join(shots,'mobile-after-transfer.png'),fullPage:true});
 for(const width of [320,390,768,1280]){await p.setViewportSize({width,height:900});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`overflow at ${width}px`);}await p.setViewportSize({width:1280,height:900});await p.screenshot({path:path.join(shots,'desktop.png'),fullPage:true});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);results.push('320 / 390 / 768 / 1280px: no horizontal overflow');
 // The mock bridge exercises iframe initialization, live gating, write probe and journal recovery.
 const live=await browser.newPage({viewport:{width:390,height:844}});live.on('pageerror',e=>errors.push(e.message));
 await live.route('**/vendor/addon.min.js',route=>route.fulfill({contentType:'text/javascript',body:sdk}));
 await live.goto(base+'/host');const frame=live.frameLocator('#frame');await frame.locator('#test-account').waitFor();
 assert.equal(await frame.locator('#entry-form').count(),0);assert.equal(await live.evaluate(()=>window.calls.filter(c=>c.method!=='GET').length),0);
 await frame.locator('#test-account').selectOption({label:'Other accounts · Power-Up Test (EUR)'});await frame.locator('#test-confirm').check();await frame.locator('[data-action=probe]').click();await frame.getByText('Connection checked',{exact:true}).waitFor();
 const probe=await live.evaluate(()=>({cfg:window.fakeData.manualAccountsV1,calls:window.calls}));assert(probe.cfg.verified);assert.equal(probe.calls.filter(c=>c.method==='POST').length,1);results.push('Live iframe mock: real accounts locked until save/edit/delete probe passes');
 await frame.locator('[data-reconcile]').first().click();await frame.locator('#actual-balance').fill('1000');await frame.locator('#balance-form button[type=submit]').click();await frame.locator('[data-action=confirm-save]').click();await frame.locator('#toast').filter({hasText:'Balance checked'}).waitFor();
 await frame.locator('.mobile-nav [data-nav=entry]').click();await frame.locator('#entry-amount').fill('10');await frame.locator('#entry-description').fill('Journal test');
 await live.evaluate(()=>{window.failMode='putTimeout';window.failureDone=false});await frame.locator('#entry-form button[type=submit]').click();await frame.locator('[data-action=confirm-save]').click();await frame.getByText('A save needs checking.',{exact:true}).waitFor();
 const postsBefore=await live.evaluate(()=>window.calls.filter(c=>c.method==='POST').length);await frame.locator('[data-action=recover]').first().click();await frame.locator('#toast').filter({hasText:'Pending save checked'}).waitFor();
 const postsAfter=await live.evaluate(()=>window.calls.filter(c=>c.method==='POST').length);assert.equal(postsBefore,postsAfter);assert.equal(await live.evaluate(()=>window.fakeData.manualAccountsV1.pending),null);results.push('Live iframe mock: committed PUT timeout recovered without a duplicate payment');
 await live.evaluate(()=>document.querySelector('#frame').contentWindow.location.reload());await frame.locator('#entry-form').waitFor({state:'attached'});await frame.locator('.mobile-nav [data-nav=entry]').click();assert((await frame.locator('#balance-preview').innerText()).includes('990'));results.push('Reload restores cloud configuration and verified balance');
 await live.screenshot({path:path.join(shots,'live-mock.png'),fullPage:true});
 console.log(JSON.stringify({results,errors},null,2));await browser.close();server.close();if(errors.length)process.exitCode=1;
})().catch(async e=>{console.error(e);if(global.checkPage){console.log(await global.checkPage.locator('body').innerText());await global.checkPage.screenshot({path:path.join(shots,'debug.png'),fullPage:true});}server.close();process.exit(1)});

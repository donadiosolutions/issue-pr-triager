import test from 'node:test';
import assert from 'node:assert/strict';
import { runEngine } from '../src/engine.js';
import { newState } from '../src/state.js';
const time=Date.parse('2026-11-15T12:00:00Z');
const config={repository:'o/r',projectNumber:1,mode:'process',eventName:'schedule',event:{},batchSize:20,deadlineMs:720000};
const catalog={project:{id:'p',fields:[]},labels:[{name:'bug',id:1,description:'defect'}],types:[{name:'Bug',id:2}],priority:{id:3,options:[{id:4,name:'High'}]},effort:{id:5,options:[{id:6,name:'Small'}]}};
const decision={labels:['bug'],type:'Bug',priority:'High',effort:'Small',parent:{number:null,confidence:1,margin:1,fullyResolves:false,status:'none'},unresolved:[],usage:[{model:'test',input_tokens:1,output_tokens:2}]};
function fixture(overrides={}) {
 const items=new Map([[1,{number:1,id:'i1',kind:'issue',title:'broken',body:'details',state:'open',createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z',labels:[],type:null,priority:null,effort:null,projectValues:{},defaultBranch:'main',baseBranch:null,headSha:null,headBranch:null,associations:[],comments:[],files:[],truncated:false}]]);
 const calls=[]; let classifyCount=0;
 const github={identity:async()=> 'bot',discover:async()=>structuredClone(catalog),getItem:async n=>structuredClone(items.get(n)),ensureProject:async()=>{calls.push('project');return 'pi';},syncPrFields:async c=>c,setTriage:async(n,enabled)=>{calls.push(['triage',enabled]);items.get(n).labels=items.get(n).labels.filter(x=>x!=='triage');if(enabled)items.get(n).labels.push('triage');},writeState:async(n,state,id)=>{calls.push(['state',structuredClone(state)]);const c={id:id??100,author:'bot',body:`<!-- issue-pr-triager:v1 ${JSON.stringify(state)} -->`};items.get(n).comments=items.get(n).comments.filter(x=>x.id!==c.id);items.get(n).comments.push(c);return c.id;},apply:async(i,c,change)=>{calls.push(['apply',change]);if('labels' in change)items.get(i.number).labels=[...new Set([...items.get(i.number).labels,...change.labels])];else if(i.kind==='pr')Object.assign(items.get(i.number).projectValues,change);else Object.assign(items.get(i.number),change);},candidates:async()=>[],link:async()=>({linked:true}),queuePage:async(cursor=null,limit=20)=>{calls.push(['queue',cursor,limit]);const rows=[...items.values()].filter(i=>i.state==='open'&&i.labels.includes('triage')&&i.number>Number(cursor??0)).sort((a,b)=>a.number-b.number).map(i=>({number:i.number}));return {items:rows.slice(0,limit),nextCursor:rows.length>limit?String(rows[limit-1].number):null};},openPage:async()=>({items:[...items.values()],nextPage:null}),...overrides};
 const classify=async args=>{classifyCount++;calls.push(['model',args.stage]);return structuredClone(decision);};
 return {items,calls,github,classify,get classifyCount(){return classifyCount;},run:extra=>runEngine({...config,...extra},{github,classify,now:()=>time})};
}
async function enroll(f,source='manual') {await f.github.writeState(1,newState(config,source));await f.github.setTriage(1,true);f.calls.length=0;}
function lastState(f) {return JSON.parse(f.items.get(1).comments.find(x=>x.author==='bot').body.match(/v1 (.*) -->/)[1]);}
test('schedule ignores legacy labels and unauthorized backfill',async()=>{
 const f=fixture();f.items.get(1).labels=['triage'];const r=await f.run({mode:'backfill'});assert.equal(f.classifyCount,0);assert.equal(r.processed,0);assert.deepEqual(f.calls,[['queue',null,20]]);
});
test('opened enrollment is durable before queueing and never invokes the model',async()=>{
 const f=fixture();const r=await f.run({mode:'enroll',eventName:'issues',event:{action:'opened',issue:{number:1}}});assert.equal(r.deferred,1);assert.equal(lastState(f).enrollmentSource,'creation');assert.equal(f.calls[0][0],'state');assert.equal(f.classifyCount,0);
});
test('manual selection enrolls then applies only catalog values and completes',async()=>{
 const f=fixture();const r=await f.run({eventName:'workflow_dispatch',itemNumber:1});assert.equal(r.processed,1);assert.equal(f.items.get(1).priority,'High');assert.equal(lastState(f).phase,'complete');assert.equal(lastState(f).ownership.type,'Bug');assert.equal(f.classifyCount,1);assert.equal(r.usage.length,1);assert.equal(f.items.get(1).labels.includes('triage'),false);
});
test('semantic second pass runs on next invocation and exhaustion never charges again',async()=>{
 const f=fixture();await enroll(f);f.classify=async()=>{throw new Error('no transport');};const deps={github:f.github,classify:f.classify,now:()=>time};let r=await runEngine(config,deps);assert.equal(r.deferred,1);assert.equal(lastState(f).pass,1);r=await runEngine(config,deps);assert.equal(r.humanReview,1);assert.equal(lastState(f).pass,2);r=await runEngine(config,deps);assert.equal(r.humanReview,1);assert.equal(lastState(f).pass,2);
});
test('human populated fields stay intact and reclassification only changes bot ownership',async()=>{
 const f=fixture();f.items.get(1).type='Feature';f.items.get(1).priority='Human';f.items.get(1).effort='Large';await enroll(f);await f.run();assert.equal(f.items.get(1).type,'Feature');assert.equal(f.items.get(1).priority,'Human');assert.equal(f.items.get(1).effort,'Large');
});
test('preserved issue and PR fields satisfy unresolved model choices',async()=>{
 for(const kind of ['issue','pr']) {
  const f=fixture();const item=f.items.get(1);item.kind=kind;
  const values=kind==='issue'?item:item.projectValues;
  Object.assign(values,{type:'Feature',priority:'Low',effort:'5'});await enroll(f);
  const r=await runEngine(config,{github:f.github,now:()=>time,classify:async()=>({...structuredClone(decision),type:null,priority:null,effort:null,unresolved:['type','priority','effort']})});
  assert.equal(r.processed,1);assert.equal(item.labels.includes('triage'),false);
  assert.equal(lastState(f).phase,'complete');assert.deepEqual(lastState(f).unresolved,[]);
  assert.deepEqual([values.type,values.priority,values.effort],['Feature','Low','5']);
  assert.deepEqual(lastState(f).ownership,{labels:['bug']});
 }
});
test('classification requests and fills only missing issue and PR fields',async()=>{
 for(const kind of ['issue','pr']) {
  const f=fixture();const item=f.items.get(1);item.kind=kind;
  const values=kind==='issue'?item:item.projectValues;
  Object.assign(values,{type:'Feature',effort:'5'});await enroll(f);
  const r=await runEngine(config,{github:f.github,now:()=>time,classify:async({fieldNames})=>{
   assert.deepEqual(fieldNames,['priority']);
   return {...structuredClone(decision),type:null,effort:null};
  }});
  assert.equal(r.processed,1);assert.equal(item.labels.includes('triage'),false);
  assert.deepEqual([values.type,values.priority,values.effort],['Feature','High','5']);
  assert.deepEqual(lastState(f).ownership,{labels:['bug'],priority:'High'});
 }
});
test('classification omits labels already present or removed by humans',async()=>{
 for(const kind of ['issue','pr']) for(const present of [false,true]) {
  const f=fixture();const item=f.items.get(1);item.kind=kind;await enroll(f);
  if(present)item.labels.push('bug');
  else {const state=lastState(f);state.removedLabels=['bug'];await f.github.writeState(1,state,100);}
  const result=await runEngine(config,{github:f.github,now:()=>time,classify:async({catalog:choices})=>{
   assert.deepEqual(choices.labels,[]);
   return {...structuredClone(decision),labels:[],unresolved:['label:bug']};
  }});
  assert.equal(result.processed,1);assert.equal(item.labels.includes('triage'),false);assert.equal(item.labels.includes('bug'),present);
 }
});
test('remaining label and parent work keeps triage while existing PR associations satisfy parent tasks',async()=>{
 for(const associated of [false,true]) {
  let candidates=0;const f=fixture({candidates:async()=>{candidates++;return [];}});const item=f.items.get(1);item.kind='pr';item.associations=associated?[9]:[];await enroll(f);
  const result=await runEngine(config,{github:f.github,now:()=>time,classify:async()=>({...structuredClone(decision),unresolved:['parent']})});
  assert.equal(candidates,1);assert.equal(result.processed,associated?1:0);assert.equal(item.labels.includes('triage'),!associated);
 }
 const f=fixture();await enroll(f);
 const result=await runEngine(config,{github:f.github,now:()=>time,classify:async()=>({...structuredClone(decision),labels:[],unresolved:['label:bug']})});
 assert.equal(result.deferred,1);assert.deepEqual(lastState(f).unresolved,['label:bug']);
});
test('existing reviews for labels already applied complete without another model call',async()=>{
 const f=fixture();await enroll(f);
 const classify=async()=>({...structuredClone(decision),unresolved:['uncertain']});
 const deps={github:f.github,classify,now:()=>time};await runEngine(config,deps);await runEngine(config,deps);
 const state=lastState(f);state.unresolved=['label:bug'];await f.github.writeState(1,state,100);
 assert.equal((await f.run()).processed,1);assert.equal(f.classifyCount,0);assert.equal(f.items.get(1).labels.includes('triage'),false);
});
test('cleared bot-owned issue and PR fields are filled without treating repairs as new evidence',async()=>{
 for(const kind of ['issue','pr']) for(const field of ['type','priority','effort']) {
  const f=fixture();const item=f.items.get(1);item.kind=kind;await enroll(f);await f.run();
  const values=kind==='issue'?item:item.projectValues;values[field]=null;await f.github.setTriage(1,true);
  const result=await f.run();
  assert.equal(result.processed,1);assert.equal(result.deferred,0);assert.equal(f.classifyCount,2);
  assert.equal(values[field],decision[field]);assert.equal(item.labels.includes('triage'),false);
  assert.equal(lastState(f).pass,1);assert.equal(lastState(f).phase,'complete');
 }
});
test('second pass fills remaining fields without requesting completed first pass fields',async()=>{
 for(const kind of ['issue','pr']) {
  const f=fixture();f.items.get(1).kind=kind;await enroll(f);
  const classify=async({stage,fieldNames})=>{
   assert.deepEqual(fieldNames,stage===1?['type','priority','effort']:['priority','effort']);
   return {...structuredClone(decision),...(stage===1?{priority:null,effort:null,unresolved:['priority','effort']}:{type:null})};
  };
  const deps={github:f.github,classify,now:()=>time};
  assert.equal((await runEngine(config,deps)).deferred,1);
  assert.equal((await runEngine(config,deps)).processed,1);
  const item=f.items.get(1);const values=kind==='issue'?item:item.projectValues;
  assert.deepEqual([values.type,values.priority,values.effort],['Bug','High','Small']);assert.equal(item.labels.includes('triage'),false);
 }
});
test('unchanged review with preserved fields completes without another model call',async()=>{
 for(const kind of ['issue','pr']) for(const dryRun of [false,true]) {
  const f=fixture();const item=f.items.get(1);item.kind=kind;
  Object.assign(kind==='issue'?item:item.projectValues,{type:'Feature',priority:'Low',effort:'5'});await enroll(f);
  const classify=async()=>({...structuredClone(decision),unresolved:['uncertain']});
  await runEngine(config,{github:f.github,classify,now:()=>time});await runEngine(config,{github:f.github,classify,now:()=>time});
  const state=lastState(f);state.unresolved=['type','priority','effort'];await f.github.writeState(1,state,100);f.calls.length=0;
  const r=await f.run({dryRun});assert.equal(r.processed,1);assert.equal(f.classifyCount,0);
  assert.equal(item.labels.includes('triage'),dryRun);assert.equal(lastState(f).phase,dryRun?'review':'complete');
  if(dryRun)assert.deepEqual(f.calls.filter(c=>c[0]!=='queue'),[]);
 }
});
test('missing fields and explicit reclassification uncertainty keep triage pending',async()=>{
 for(const kind of ['issue','pr']) for(const reclassify of [false,true]) {
  const f=fixture();const item=f.items.get(1);item.kind=kind;await enroll(f);
  if(reclassify){await f.run();await f.github.setTriage(1,true);}
  const classify=async()=>({...structuredClone(decision),type:null,unresolved:['type']});
  const deps={github:f.github,classify,now:()=>time};const options={...config,reclassify};
  const first=await runEngine(reclassify?{...options,eventName:'workflow_dispatch',itemNumber:1}:options,deps);assert.equal(first.deferred,1);
  const second=await runEngine(options,deps);assert.equal(second.humanReview,1);
  const third=await runEngine(options,deps);assert.equal(third.humanReview,1);
  assert.equal(item.labels.includes('triage'),true);assert.deepEqual(lastState(f).unresolved,['type']);
 }
});
test('dry run manual selection makes no remote writes',async()=>{
 const f=fixture();const r=await f.run({dryRun:true,eventName:'workflow_dispatch',itemNumber:1});assert.equal(r.processed,1);assert.deepEqual(f.calls.filter(c=>c[0]!=='model'),[]);assert.equal(f.items.get(1).comments.length,0);
});
test('partial application failure keeps validated decision and resumes without another charge',async()=>{
 const f=fixture();await enroll(f);const apply=f.github.apply;let fail=true;f.github.apply=async(...args)=>{if(fail&&'priority' in args[2])throw new Error('write unavailable');await apply(...args);};let r=await f.run();assert.equal(r.failed,1);assert.equal(lastState(f).ownership.type,'Bug');fail=false;r=await f.run();assert.equal(r.processed,1);assert.equal(f.classifyCount,1);assert.equal(f.items.get(1).priority,'High');
});
test('fresh evidence edits defer a saved decision instead of applying stale classifications',async()=>{
 const f=fixture();await enroll(f);const classify=f.classify;const r=await runEngine(config,{github:f.github,now:()=>time,classify:async args=>{const d=await classify(args);f.items.get(1).body='changed by human';return d;}});assert.equal(r.deferred,1);assert.equal(f.items.get(1).type,null);
});
test('manual backfill checkpoints advance through closed and post-snapshot items',async()=>{
 const f=fixture();f.items.set(2,{...structuredClone(f.items.get(1)),number:2,state:'closed'});f.items.set(3,{...structuredClone(f.items.get(1)),number:3,createdAt:'2026-11-16T00:00:00Z'});const saved=[];const r=await runEngine({...config,mode:'backfill',eventName:'workflow_dispatch'},{github:f.github,classify:f.classify,now:()=>time,saveCheckpoint:async c=>saved.push(structuredClone(c))});assert.equal(r.processed,1);assert.equal(r.backfillRemaining,false);assert.equal(saved.at(-1).active,false);assert.equal(f.items.get(2).comments.length,0);
});
test('PR links require unique full resolution and strict score and branch gates',async()=>{
 for (const options of [ {},{confidence:.949},{margin:.149},{fullyResolves:false},{baseBranch:'release'},{duplicate:true},{candidateState:'closed'},{truncated:true},{status:'uncertain'},{linkFails:true},{associated:true},{status:'none'} ]) {
  let linked=0;const candidate={number:9,title:'fix',body:'needed',state:options.candidateState??'open'};
  const f=fixture({candidates:async()=>{const rows=options.duplicate?[candidate,candidate]:[candidate];rows.truncated=options.truncated??false;return rows;},link:async()=>{linked++;return {linked:!options.linkFails};}});
  Object.assign(f.items.get(1),{kind:'pr',baseBranch:options.baseBranch??'main',headSha:'abc',associations:options.associated?[8]:[]});
  const apply=f.github.apply;f.github.apply=async(i,c,ch)=>{'labels' in ch ? await apply(i,c,ch) : Object.assign(f.items.get(i.number).projectValues,ch);};
  await enroll(f);
  const classify=async()=>({...structuredClone(decision),parent:{number:9,confidence:options.confidence??.95,margin:options.margin??.15,fullyResolves:options.fullyResolves??true,status:options.status??'match'}});
  const r=await runEngine(config,{github:f.github,classify,now:()=>time});
  const shouldLink=Object.keys(options).length===0||options.linkFails;
  assert.equal(linked,shouldLink?1:0,JSON.stringify(options));
  assert.equal(r.processed,options.associated||options.status==='none'||Object.keys(options).length===0?1:0,JSON.stringify(options));
 }
});
test('invalid classification data is deferred without writing fields',async()=>{
 for(const invalid of [null,{}, {...decision,labels:['unknown']},{...decision,labels:['triage']},{...decision,type:'Fake'},{...decision,priority:'Fake'},{...decision,effort:'Fake'},{...decision,unresolved:[1]},{...decision,parent:null},{...decision,parent:{...decision.parent,status:'other'}},{...decision,parent:{...decision.parent,confidence:'1'}},{...decision,parent:{...decision.parent,margin:'1'}},{...decision,parent:{...decision.parent,fullyResolves:1}},{...decision,parent:{...decision.parent,number:8}},{...decision,usage:null}]){
  const f=fixture();await enroll(f);const r=await runEngine(config,{github:f.github,classify:async()=>invalid,now:()=>time});assert.equal(r.deferred+(invalid?.usage===null?r.processed:0),1);if(invalid?.usage!==null)assert.equal(f.items.get(1).type,null);
 }
});
test('saved write-ahead ownership recovers after remote success and state transport failure',async()=>{
 for(const field of ['labels','type']) {
  const f=fixture();await enroll(f);const write=f.github.writeState;let fail=true;
  f.github.writeState=async(n,s,id)=>{if(fail&&s.ownership[field]?.length&&s.pending===null){fail=false;throw new Error('state unavailable');}return write(n,s,id);};
  const first=await f.run();assert.equal(first.failed,1);const second=await f.run({eventName:'workflow_dispatch',itemNumber:1});assert.equal(second.processed,1);assert.equal(f.classifyCount,1);assert.equal(lastState(f).ownership.type,'Bug');assert.deepEqual(lastState(f).ownership.labels,['bug']);
 }
});
test('PR reclassification changes bot custom fields and preserves human custom values',async()=>{
 const f=fixture();Object.assign(f.items.get(1),{kind:'pr',baseBranch:'main'});
 f.github.apply=async(i,c,ch)=>{if('labels' in ch)f.items.get(i.number).labels=[...new Set([...f.items.get(i.number).labels,...ch.labels])];else Object.assign(f.items.get(i.number).projectValues,ch);};
 await enroll(f);await f.run();const updated=structuredClone(catalog);updated.types.push({id:8,name:'Feature'});f.github.discover=async()=>updated;
 f.items.get(1).projectValues.priority='Human priority';
 const r=await runEngine({...config,reclassify:true,eventName:'workflow_dispatch',itemNumber:1},{github:f.github,classify:async()=>({...decision,type:'Feature'}),now:()=>time});
 assert.equal(r.processed,1);assert.deepEqual(f.items.get(1).projectValues,{type:'Feature',priority:'Human priority',effort:'Small'});assert.equal(lastState(f).ownership.type,'Feature');
});
test('completion does not consume additional passes and human evidence changes reset the budget',async()=>{
 const f=fixture();await enroll(f);await f.run();let r=await f.run({eventName:'issues',event:{action:'edited',issue:{number:1}}});assert.equal(r.processed,1);assert.equal(f.classifyCount,1);f.items.get(1).body='new human evidence';r=await f.run({eventName:'issues',event:{action:'edited',issue:{number:1}}});assert.equal(r.processed,1);assert.equal(f.classifyCount,2);assert.equal(lastState(f).pass,1);
});
test('second semantic pass handles unresolved classifications and enters review',async()=>{
 const f=fixture();await enroll(f);let calls=0;const classify=async({stage})=>{calls++;assert.equal(stage,calls);return {...structuredClone(decision),unresolved:['uncertain scope']};};let r=await runEngine(config,{github:f.github,classify,now:()=>time});assert.equal(r.deferred,1);r=await runEngine(config,{github:f.github,classify,now:()=>time});assert.equal(r.humanReview,1);r=await runEngine(config,{github:f.github,classify,now:()=>time});assert.equal(r.humanReview,1);assert.equal(calls,2);
});
test('enrollment rejects missing numbers, noncreation actions, existing state and closed items',async()=>{
 for(const extra of [{eventName:'schedule',event:{action:'opened'}},{eventName:'issues',event:{action:'edited',issue:{number:1}}},{eventName:'issues',event:{action:'opened'}},{eventName:'issues',event:{action:'opened',issue:{number:-1}}}]){const f=fixture();await f.run({mode:'enroll',...extra});assert.deepEqual(f.calls,[]);}
 const f=fixture();f.items.get(1).state='closed';await f.run({mode:'enroll',eventName:'pull_request_target',event:{action:'opened',pull_request:{number:1}}});assert.deepEqual(f.calls,[]);
 f.items.get(1).state='open';await enroll(f);await f.run({mode:'enroll',eventName:'issues',event:{action:'opened',issue:{number:1}}});assert.equal(f.classifyCount,0);
});
test('closed queue items and API read failures do not block another enrolled item',async()=>{
 const f=fixture();await enroll(f);f.items.set(2,{...structuredClone(f.items.get(1)),number:2,state:'closed'});const get=f.github.getItem;f.github.getItem=async n=>{if(n===3)throw new Error('unavailable');return get(n);};f.github.queuePage=async()=>({items:[{number:2},{number:3},{number:1}],nextCursor:null});const r=await f.run();assert.equal(r.processed,1);assert.equal(r.failed,1);
});
test('batch and deadline bound work while expired checkpoints never discover legacy items',async()=>{
 const f=fixture();await enroll(f);f.items.set(2,{...structuredClone(f.items.get(1)),number:2});let r=await f.run({batchSize:1});assert.equal(r.processed,1);assert.equal(f.classifyCount,1);r=await f.run({deadlineMs:0});assert.equal(r.processed,0);
 const cp={version:1,repository:'o/r',projectNumber:1,authorizedAt:'2020-01-01T00:00:00Z',source:'workflow_dispatch',page:1,offset:0,active:true};r=await runEngine(config,{github:f.github,classify:f.classify,now:()=>time,checkpoint:cp});assert.equal(r.checkpoint.active,false);
});
test('authorized checkpoint resumes and records batch cursor and finite page progress',async()=>{
 const f=fixture({queuePage:async()=>({items:[],nextCursor:null}),openPage:async page=>page===1?{items:[{number:1,state:'open',createdAt:'2026-11-01'}],nextPage:2}:{items:[],nextPage:null}});
 const cp={version:1,repository:'o/r',projectNumber:1,authorizedAt:new Date(time).toISOString(),source:'workflow_dispatch',page:1,offset:0,active:true};
 let r=await runEngine({...config,batchSize:1},{github:f.github,classify:f.classify,now:()=>time,checkpoint:cp});assert.equal(r.backfillRemaining,true);assert.equal(r.checkpoint.page,2);
 r=await runEngine(config,{github:f.github,classify:f.classify,now:()=>time,checkpoint:r.checkpoint});assert.equal(r.backfillRemaining,false);
 const many=fixture({queuePage:async()=>({items:[],nextCursor:null}),openPage:async page=>({items:[],nextPage:page+1})});r=await runEngine(config,{github:many.github,classify:many.classify,now:()=>time,checkpoint:cp});assert.equal(r.checkpoint.page,21);assert.equal(r.backfillRemaining,true);
});
test('manual checkpoint stops within a page at the batch boundary',async()=>{
 const f=fixture({queuePage:async()=>({items:[],nextCursor:null})});f.items.set(2,{...structuredClone(f.items.get(1)),number:2});const r=await f.run({mode:'backfill',eventName:'workflow_dispatch',batchSize:1});assert.equal(r.backfillRemaining,true);assert.equal(r.checkpoint.offset,1);assert.equal(f.items.get(2).comments.length,0);
});
test('explicit reclassification changes only matching bot values and keeps human replacements',async()=>{
 for(const human of [false,true]) {
  const f=fixture();await enroll(f);await f.run();const updated=structuredClone(catalog);updated.types.push({id:8,name:'Feature'});f.github.discover=async()=>updated;
  if(human)f.items.get(1).type='Human choice';
  const r=await runEngine({...config,reclassify:true,eventName:'workflow_dispatch',itemNumber:1,batchSize:undefined,deadlineMs:undefined,botLogin:'bot'},{github:f.github,classify:async()=>({...decision,type:'Feature'}),now:()=>time});assert.equal(r.processed,1);assert.equal(f.items.get(1).type,human?'Human choice':'Feature');
 }
});
test('PR field write-ahead recovery recognizes success and preserves prior values on failures',async()=>{
 const f=fixture();Object.assign(f.items.get(1),{kind:'pr',baseBranch:'main'});f.github.apply=async(i,c,ch)=>{if('labels' in ch)f.items.get(i.number).labels=[...new Set([...f.items.get(i.number).labels,...ch.labels])];else Object.assign(f.items.get(i.number).projectValues,ch);};await enroll(f);
 const write=f.github.writeState;let fail=true;f.github.writeState=async(n,s,id)=>{if(fail&&s.ownership.type==='Bug'){fail=false;throw new Error('state response lost');}return write(n,s,id);};
 assert.equal((await f.run()).failed,1);assert.equal((await f.run()).processed,1);assert.equal(f.classifyCount,1);assert.equal(lastState(f).ownership.type,'Bug');assert.equal(f.items.get(1).projectValues.type,'Bug');
});
test('triage observes human edits between individual field writes',async()=>{
 const f=fixture();await enroll(f);const apply=f.github.apply;f.github.apply=async(i,c,ch)=>{await apply(i,c,ch);if('labels' in ch)f.items.get(1).priority='Human picked';};const r=await f.run();assert.equal(f.items.get(1).priority,'Human picked');assert.equal(r.deferred,1);
});
test('existing trusted creation state restores its interrupted triage label',async()=>{
 const f=fixture();await enroll(f,'creation');f.items.get(1).labels=[];const r=await f.run({mode:'enroll',eventName:'issues',event:{action:'opened',issue:{number:1}}});assert.equal(f.items.get(1).labels.includes('triage'),true);assert.equal(r.deferred,1);
});
test('out of range parent scores never authorize automatic association',async()=>{
 for(const parent of [{...decision.parent,status:'match',number:9,confidence:2,margin:1,fullyResolves:true},{...decision.parent,status:'match',number:9,confidence:1,margin:2,fullyResolves:true}]){
  let linked=false;const f=fixture({candidates:async()=>[{number:9,state:'open',title:'fix',body:'fix'}],link:async()=>{linked=true;return {linked:true};}});Object.assign(f.items.get(1),{kind:'pr',baseBranch:'main'});await enroll(f);const r=await runEngine(config,{github:f.github,classify:async()=>({...decision,parent}),now:()=>time});assert.equal(linked,false);assert.equal(r.deferred,1);
 }
});
test('bot closing links do not reset semantic passes, including interrupted ownership persistence',async()=>{
 for(const interrupt of [false,true]) {
  let links=0;const f=fixture({candidates:async()=>[{number:9,state:'open',title:'fix',body:'needed'}]});Object.assign(f.items.get(1),{kind:'pr',baseBranch:'main'});f.github.apply=async(i,c,ch)=>{if('labels' in ch)f.items.get(1).labels=[...new Set([...f.items.get(1).labels,...ch.labels])];else Object.assign(f.items.get(1).projectValues,ch);};
  f.github.link=async()=>{links++;f.items.get(1).associations=[9];f.items.get(1).body+='\n<!-- issue-pr-triager:link -->\nCloses #9\n<!-- /issue-pr-triager:link -->';return {linked:true};};await enroll(f);
  const write=f.github.writeState;let fail=interrupt;f.github.writeState=async(n,s,id)=>{if(fail&&s.ownership.parent===9){fail=false;throw new Error('state unavailable');}return write(n,s,id);};
  let models=0;const classify=async()=>{models++;return {...structuredClone(decision),parent:{number:9,confidence:1,margin:1,fullyResolves:true,status:'match'}};};const deps={github:f.github,classify,now:()=>time};
  assert.equal((await runEngine(config,deps))[interrupt?'failed':'processed'],1);assert.equal((await runEngine({...config,eventName:'pull_request_target',event:{action:'edited',pull_request:{number:1}}},deps)).processed,1);assert.equal(models,1);assert.equal(links,1);assert.equal(lastState(f).ownership.parent,9);
 }
});
test('saving a successful model decision failing does not replace it with model failure',async()=>{
 const f=fixture();await enroll(f);const write=f.github.writeState;let fail=true;f.github.writeState=async(n,s,id)=>{const result=await write(n,s,id);if(fail&&s.decision){fail=false;throw new Error('response lost');}return result;};const r=await f.run();assert.equal(r.failed,1);assert.ok(lastState(f).decision);assert.equal((await f.run()).processed,1);assert.equal(f.classifyCount,1);
});
test('label application sends only additive decisions and preserves existing labels',async()=>{
 const f=fixture();f.items.get(1).labels=['human'];await enroll(f);await f.run();assert.deepEqual(f.calls.find(c=>c[0]==='apply')[1],{labels:['bug']});assert.ok(f.items.get(1).labels.includes('human'));
});
test('creation enrolls into project before provider access and retries interrupted membership',async()=>{
 const f=fixture();let fail=true;f.github.ensureProject=async()=>{f.calls.push('project');if(fail)throw new Error('secret membership error');};let r=await f.run({mode:'enroll',eventName:'issues',event:{action:'opened',issue:{number:1}}});assert.equal(r.failed,1);assert.ok(lastState(f));assert.equal(f.calls[0][0],'state');assert.equal(f.classifyCount,0);fail=false;r=await f.run({mode:'enroll',eventName:'issues',event:{action:'opened',issue:{number:1}}});assert.equal(r.deferred,1);assert.equal(f.calls.filter(c=>c==='project').length,2);assert.equal(r.diagnostics.length,0);
});
test('completed trusted events process new evidence while legacy event targets never enroll',async()=>{
 for(const action of ['edited','reopened','synchronize','labeled']){
  const f=fixture();Object.assign(f.items.get(1),{kind:'pr',baseBranch:'main'});await enroll(f);await f.run();assert.equal(f.items.get(1).labels.includes('triage'),false);f.items.get(1).headSha='new';const r=await f.run({eventName:'pull_request_target',event:{action,pull_request:{number:1}}});assert.equal(r.processed,1);assert.equal(f.classifyCount,2);
  const legacy=fixture();assert.equal((await legacy.run({eventName:'issues',event:{action,issue:{number:1}}})).processed,0);assert.equal(legacy.items.get(1).comments.length,0);
 }
});
test('dry run never saves backfill authorization or queue progression',async()=>{
 const f=fixture();const saved=[];const r=await runEngine({...config,mode:'backfill',eventName:'workflow_dispatch',dryRun:true},{github:f.github,classify:f.classify,now:()=>time,saveCheckpoint:async cp=>saved.push(cp)});assert.equal(r.processed,1);assert.deepEqual(saved,[]);
});
test('human removal of bot labels stays removed across new and saved decisions',async()=>{
 for(const saved of [false,true]){
  const f=fixture();await enroll(f);
  if(saved){const apply=f.github.apply;let fail=true;f.github.apply=async(...args)=>{if(fail&&'priority'in args[2])throw new Error('retry');return apply(...args);};assert.equal((await f.run()).failed,1);fail=false;}
  else await f.run();
  f.items.get(1).labels=f.items.get(1).labels.filter(x=>x!=='bug');f.items.get(1).body+=' human clarification';
  const r=await f.run({eventName:'issues',event:{action:'edited',issue:{number:1}}});assert.equal(r.processed,1);assert.equal(f.items.get(1).labels.includes('bug'),false);assert.deepEqual(lastState(f).removedLabels,['bug']);
 }
});
test('queue cursor advances past legacy entries without exceeding visit budget',async()=>{
 const f=fixture();const base=structuredClone(f.items.get(1));f.items.clear();for(let i=1;i<=41;i++)f.items.set(i,{...structuredClone(base),number:i,labels:['triage']});
 for(let i=21;i<=41;i++)await f.github.writeState(i,newState(config,'manual'));
 let r=await f.run();assert.equal(r.processed,0);assert.equal(r.checkpoint.queueCursor,'20');assert.equal(f.classifyCount,0);
 r=await runEngine(config,{github:f.github,classify:f.classify,now:()=>time,checkpoint:r.checkpoint});assert.equal(r.processed,20);assert.equal(r.checkpoint.queueCursor,'40');
 r=await runEngine(config,{github:f.github,classify:f.classify,now:()=>time,checkpoint:r.checkpoint});assert.equal(r.processed,1);
});
test('failed item reads consume visit budget and diagnostics contain no exception text',async()=>{
 let reads=0;const f=fixture({getItem:async()=>{reads++;throw new Error('secret payload');},queuePage:async(c,limit)=>({items:Array.from({length:limit},(_,i)=>({number:i+1})),nextCursor:'next'})});const r=await f.run();assert.equal(reads,20);assert.equal(r.failed,20);assert.equal(r.diagnostics.length,20);assert.deepEqual(r.diagnostics[0],{number:1,stage:'read',reason:'Operation failed'});assert.equal(JSON.stringify(r).includes('secret'),false);
});
test('unchanged review avoids writes and candidate reads and cannot starve backfill',async()=>{
 const f=fixture();Object.assign(f.items.get(1),{kind:'pr',baseBranch:'main'});await enroll(f);const classify=async()=>({...decision,unresolved:['uncertain']});await runEngine(config,{github:f.github,classify,now:()=>time});await runEngine(config,{github:f.github,classify,now:()=>time});f.calls.length=0;let candidates=0;f.github.candidates=async()=>{candidates++;return [];};const r=await f.run();assert.equal(r.humanReview,1);assert.equal(candidates,0);assert.deepEqual(f.calls.filter(c=>c[0]!=='queue'),[]);
 const base=structuredClone(f.items.get(1));for(let i=2;i<=30;i++)f.items.set(i,{...structuredClone(base),number:i});f.items.set(100,{...structuredClone(base),kind:'issue',number:100,comments:[],labels:[]});const cp={version:1,repository:'o/r',projectNumber:1,active:true,source:'workflow_dispatch',authorizedAt:new Date(time).toISOString(),page:1,offset:0};f.github.openPage=async()=>({items:[{number:100,state:'open',createdAt:'2026-11-01'}],nextPage:null});const next=await runEngine(config,{github:f.github,classify:f.classify,now:()=>time,checkpoint:cp});assert.equal(next.humanReview,10);assert.equal(next.processed,1);assert.equal(next.checkpoint.active,false);
});
test('deadline expiration miditem stops writes and preserves pending queue numbers',async()=>{
 const f=fixture();await enroll(f);f.items.set(2,{...structuredClone(f.items.get(1)),number:2});let clock=time;f.github.setDeadline=deadline=>assert.equal(deadline,time+100);const classify=async args=>{assert.equal(args.deadline,time+100);clock=time+100;return structuredClone(decision);};const r=await runEngine({...config,concurrency:1,deadlineMs:100},{github:f.github,classify,now:()=>clock});assert.equal(r.deferred,1);assert.equal(r.failed,0);assert.equal(f.items.get(1).type,null);assert.deepEqual(r.checkpoint.queuePending,[2]);assert.equal(lastState(f).pass,1);
});
test('semantic catalogs and model evidence ignore bot bookkeeping and transport metadata',async()=>{
 const f=fixture();Object.assign(f.items.get(1),{kind:'pr',baseBranch:'main',body:'details\n<!-- issue-pr-triager:link -->\nCloses #9\n<!-- /issue-pr-triager:link -->'});await enroll(f);f.items.get(1).comments.push({id:200,author:'human',body:'<!-- issue-pr-triager:v1 quoted --> human evidence'});let calls=0;f.github.discover=async()=>({...structuredClone(catalog),updatedAt:String(calls++),project:{id:'p',fields:[{id:'custom',dataType:calls?'SINGLE_SELECT':undefined}]}});const r=await runEngine(config,{github:f.github,now:()=>time,classify:async({item})=>{assert.equal(item.comments.length,1);assert.equal(item.comments[0].author,'human');assert.equal(item.body,'details');return structuredClone(decision);}});assert.equal(r.processed,1);
});
test('queue pending work resumes without skipping fetched numbers and preserves backfill snapshot',async()=>{
 const f=fixture();await enroll(f);f.items.set(2,{...structuredClone(f.items.get(1)),number:2});const cp={version:1,repository:'o/r',projectNumber:1,active:true,source:'workflow_dispatch',authorizedAt:new Date(time).toISOString(),page:4,offset:9,queueCursor:'2',queuePending:[1]};
 f.github.queuePage=async(cursor,limit)=>{assert.equal(cursor,'2');assert.equal(limit,9);return {items:[],nextCursor:null};};f.github.openPage=async page=>{assert.equal(page,4);return {items:Array.from({length:10},()=>({number:500,state:'closed',createdAt:'2026-11-01'})),nextPage:null};};
 const r=await runEngine(config,{github:f.github,classify:f.classify,now:()=>time,checkpoint:cp});assert.equal(r.processed,1);assert.equal(r.checkpoint.authorizedAt,cp.authorizedAt);assert.equal(r.checkpoint.source,'workflow_dispatch');assert.equal(r.checkpoint.offset,10);assert.deepEqual(r.checkpoint.queuePending,[]);
 const pending=fixture();await enroll(pending);let pages=0;pending.github.queuePage=async()=>{pages++;throw new Error('must not refetch end page');};const result=await runEngine(config,{github:pending.github,classify:pending.classify,now:()=>time,checkpoint:{version:1,repository:'o/r',projectNumber:1,active:false,queueCursor:null,queuePending:[1]}});assert.equal(result.processed,1);assert.equal(pages,0);
});
test('deadline expiration during authentication and before classifier starts stops all mutations',async()=>{
 let clock=time;const f=fixture({identity:async()=>{clock=time+10;return 'bot';}});const r=await runEngine({...config,deadlineMs:10},{github:f.github,classify:f.classify,now:()=>clock});assert.equal(r.processed,0);assert.deepEqual(f.calls,[]);
 const g=fixture();await enroll(g);clock=time;const write=g.github.writeState;g.github.writeState=async(n,state,id)=>{const result=await write(n,state,id);if(state.unresolved[0]==='model pending')clock=time+10;return result;};const stopped=await runEngine({...config,deadlineMs:10},{github:g.github,classify:g.classify,now:()=>clock});assert.equal(stopped.deferred,1);assert.equal(g.classifyCount,0);assert.equal(stopped.diagnostics[0].stage,'classify');
});
test('crash after the last paid pass becomes review once without fetching candidate evidence',async()=>{
 const f=fixture();await enroll(f);const classify=async()=>({...decision,unresolved:['uncertain']});await runEngine(config,{github:f.github,classify,now:()=>time});await runEngine(config,{github:f.github,classify,now:()=>time});const state=lastState(f);state.phase='pending';await f.github.writeState(1,state,100);let candidates=0;f.github.candidates=async()=>{candidates++;return [];};const r=await f.run();assert.equal(r.humanReview,1);assert.equal(lastState(f).phase,'review');assert.equal(candidates,0);
});
test('matching complete state removes a stale triage label without reclassifying',async()=>{
 const f=fixture();await enroll(f);await f.run();await f.github.setTriage(1,true);const r=await f.run();assert.equal(r.processed,1);assert.equal(f.classifyCount,1);assert.equal(f.items.get(1).labels.includes('triage'),false);
});
test('queue continuation reaches pending work after more than twenty terminal reviews',async()=>{
 const f=fixture();await enroll(f);const classify=async()=>({...decision,unresolved:['uncertain']});await runEngine(config,{github:f.github,classify,now:()=>time});await runEngine(config,{github:f.github,classify,now:()=>time});const reviewed=structuredClone(f.items.get(1));for(let i=2;i<=22;i++)f.items.set(i,{...structuredClone(reviewed),number:i});f.items.set(23,{...structuredClone(reviewed),number:23,comments:[]});await f.github.writeState(23,newState(config,'manual'));
 let r=await f.run();assert.equal(r.humanReview,20);assert.equal(r.processed,0);assert.equal(r.checkpoint.queueCursor,'20');r=await runEngine(config,{github:f.github,classify:f.classify,now:()=>time,checkpoint:r.checkpoint});assert.equal(r.humanReview,2);assert.equal(r.processed,1);assert.equal(f.classifyCount,1);
});
test('explicit manual reclassification renews exhausted review and completed pass budgets',async()=>{
 for(const complete of [false,true]) {
  const f=fixture();await enroll(f);f.items.get(1).type='Bug';f.items.get(1).priority='Human priority';const enrolled=lastState(f);enrolled.ownership.type='Bug';enrolled.removedLabels=['bug'];await f.github.writeState(1,enrolled,100);
  const stages=[];const classify=async({stage})=>{stages.push(stage);return {...structuredClone(decision),unresolved:stage===1||!complete?['uncertain']:[]};};const deps={github:f.github,classify,now:()=>time};
  assert.equal((await runEngine(config,deps)).deferred,1);assert.equal((await runEngine(config,deps))[complete?'processed':'humanReview'],1);assert.deepEqual(stages,[1,2]);assert.equal(lastState(f).pass,2);
  await runEngine(config,deps);assert.deepEqual(stages,[1,2]);
  const before=lastState(f);const retry=await runEngine({...config,eventName:'workflow_dispatch',itemNumber:1,reclassify:true},deps);
  assert.equal(retry.deferred,1);assert.deepEqual(stages,[1,2,1]);assert.equal(lastState(f).pass,1);assert.deepEqual(lastState(f).ownership,before.ownership);assert.deepEqual(lastState(f).removedLabels,['bug']);assert.equal(f.items.get(1).priority,'Human priority');assert.equal(f.items.get(1).labels.includes('bug'),false);
 }
});
test('automatic reclassify flag cannot renew unchanged exhausted review passes',async()=>{
 const f=fixture();await enroll(f);let calls=0;const classify=async()=>{calls++;return {...structuredClone(decision),unresolved:['uncertain']};};const deps={github:f.github,classify,now:()=>time};await runEngine(config,deps);await runEngine(config,deps);const r=await runEngine({...config,reclassify:true},deps);assert.equal(r.humanReview,1);assert.equal(calls,2);assert.equal(lastState(f).pass,2);
});
function manyItems(count,kind='issue') {
 const f=fixture();const base=structuredClone(f.items.get(1));
 for(let number=1;number<=count;number++)f.items.set(number,{...structuredClone(base),number,id:`i${number}`,kind,baseBranch:kind==='pr'?'main':null,labels:['triage'],comments:[{id:100,author:'bot',body:`<!-- issue-pr-triager:v1 ${JSON.stringify(newState(config,'manual'))} -->`}]});
 return f;
}
test('item workers default to four and honor configured concurrency and the twenty-item cap',async()=>{
 for(const concurrency of [undefined,2,20]) {
  const f=manyItems(26);const gate=Promise.withResolvers();const ready=Promise.withResolvers();
  const expected=concurrency??4;let active=0,maximum=0;const started=new Set();
  const classify=async({item})=>{
   assert.equal(started.has(item.number),false);started.add(item.number);
   active++;maximum=Math.max(maximum,active);if(active===expected)ready.resolve();
   await gate.promise;active--;return structuredClone(decision);
  };
  const pending=runEngine({...config,concurrency,batchSize:99},{github:f.github,classify,now:()=>time});
  await ready.promise;assert.equal(started.size,expected);assert.equal(active,expected);gate.resolve();
  const result=await pending;assert.equal(maximum,expected);assert.equal(active,0);assert.equal(result.processed,20);assert.equal(started.size,20);
 }
});
test('duplicate queue entries and overlapping backfill items have a single owner per run',async()=>{
 for(const concurrency of [1,4]) {
  const f=manyItems(3);f.github.queuePage=async()=>({items:[{number:1},{number:1},{number:2}],nextCursor:null});
  const calls=[];const result=await runEngine({...config,concurrency,eventName:'workflow_dispatch',mode:'backfill'},{github:f.github,now:()=>time,classify:async({item})=>{calls.push(item.number);return structuredClone(decision);}});
  assert.equal(result.processed,3);assert.deepEqual(calls.sort(),[1,2,3]);assert.equal(result.backfillRemaining,false);
 }
});
test('queue checkpoint saves serialize and retain unfinished earlier items until they complete',async()=>{
 const f=manyItems(4);const gate=Promise.withResolvers();const savedOutOfOrder=Promise.withResolvers();const saved=[];let activeSaves=0;
 const pending=runEngine({...config,concurrency:2},{github:f.github,now:()=>time,classify:async({item})=>{if(item.number===1)await gate.promise;return structuredClone(decision);},saveCheckpoint:async cp=>{
  assert.equal(activeSaves++,0);await Promise.resolve();saved.push(cp);activeSaves--;
  if(f.items.get(2).type==='Bug'&&cp.queuePending.includes(1))savedOutOfOrder.resolve();
 }});
 await savedOutOfOrder.promise;assert.deepEqual(saved.at(-1).queuePending,[1,2,3,4]);assert.equal(f.items.get(1).type,null);
 gate.resolve();const result=await pending;assert.equal(result.processed,4);assert.deepEqual(result.checkpoint.queuePending,[]);assert.equal(activeSaves,0);
 for(const cp of saved)if(cp.queuePending.includes(1))assert.deepEqual(cp.queuePending,[1,2,3,4]);
});
test('backfill checkpoint offsets stay behind unfinished items and preserve authorization',async()=>{
 const f=manyItems(4);f.github.queuePage=async()=>({items:[],nextCursor:null});
 const gate=Promise.withResolvers();const savedOutOfOrder=Promise.withResolvers();const saved=[];
 const pending=runEngine({...config,concurrency:2,eventName:'workflow_dispatch',mode:'backfill'},{github:f.github,now:()=>time,classify:async({item})=>{if(item.number===1)await gate.promise;return structuredClone(decision);},saveCheckpoint:async cp=>{
  saved.push(cp);if(f.items.get(2).type==='Bug'&&cp.offset===0)savedOutOfOrder.resolve();
 }});
 await savedOutOfOrder.promise;assert.equal(saved.at(-1).offset,0);assert.equal(saved.at(-1).active,true);
 gate.resolve();const result=await pending;assert.equal(result.processed,4);assert.equal(result.checkpoint.offset,4);assert.equal(result.backfillRemaining,false);
 for(const cp of saved){assert.equal(cp.source,'workflow_dispatch');assert.equal(cp.authorizedAt,new Date(time).toISOString());}
});
test('checkpoint failures stop dispatch and wait for every in-flight worker before rejecting',async()=>{
 const f=manyItems(5);const gate=Promise.withResolvers();const failure=Promise.withResolvers();let settled=false;const started=[];
 const pending=runEngine({...config,concurrency:2},{github:f.github,now:()=>time,classify:async({item})=>{started.push(item.number);if(item.number===1)await gate.promise;return structuredClone(decision);},saveCheckpoint:async cp=>{
  if(f.items.get(2).type==='Bug'){failure.resolve();throw new Error('checkpoint unavailable');}
 }});
 const rejected=assert.rejects(pending,/checkpoint unavailable/).then(()=>{settled=true;});
 await failure.promise;assert.equal(settled,false);assert.deepEqual(started,[1,2]);
 gate.resolve();await rejected;assert.equal(f.items.get(1).type,'Bug');assert.deepEqual(started,[1,2]);
});
test('concurrent operation failures retain saved decisions and do not block independent items',async()=>{
 const f=manyItems(4);const apply=f.github.apply;
 f.github.apply=async(...args)=>{if(args[0].number===1&&'priority' in args[2])throw new Error('partial write');return apply(...args);};
 const result=await f.run();assert.equal(result.failed,1);assert.equal(result.processed,3);assert.deepEqual(result.checkpoint.queuePending,[]);
 const state=lastState(f);assert.ok(state.decision);assert.deepEqual(state.pending,{field:'priority',value:'High'});
 f.github.apply=apply;assert.equal((await f.run()).processed,1);assert.equal(f.classifyCount,4);
});
test('concurrent deadline exhaustion starts no more items and retains undispatched queue work',async()=>{
 const f=manyItems(6);let clock=time;const entered=Promise.withResolvers();const release=Promise.withResolvers();let active=0;
 const pending=runEngine({...config,concurrency:2,deadlineMs:100},{github:f.github,now:()=>clock,classify:async()=>{
  active++;if(active===2)entered.resolve();await release.promise;return structuredClone(decision);
 }});
 await entered.promise;clock=time+100;release.resolve();const result=await pending;
 assert.equal(active,2);assert.equal(result.deferred,2);assert.equal(result.failed,0);assert.deepEqual(result.checkpoint.queuePending,[3,4,5,6]);assert.equal(f.items.get(3).type,null);
});
test('PR field setup rediscovers after competing synchronization and item catalogs stay private',async()=>{
 const f=manyItems(4,'pr');let stored=structuredClone(catalog),syncing=0,created=0;const catalogs=[];
 f.github.discover=async()=>structuredClone(stored);
 f.github.syncPrFields=async c=>{
  assert.equal(syncing++,0);await Promise.resolve();
  for(const key of ['type','priority','effort']) {
   const name=`PR ${key}`;
   if(!c.project.fields.some(field=>field.name===name)) {
    assert.equal(stored.project.fields.some(field=>field.name===name),false,'stale competing catalog');
    c.project.fields.push({id:name,name});created++;
   }
  }
  stored=structuredClone(c);syncing--;return c;
 };
 const result=await runEngine(config,{github:f.github,now:()=>time,classify:async({item,catalog:c})=>{
  assert.equal(catalogs.includes(c),false);c.owner=item.number;catalogs.push(c);await Promise.resolve();return structuredClone(decision);
 }});
 assert.equal(result.processed,4);assert.equal(created,3);assert.equal(syncing,0);assert.equal(catalogs.length,4);assert.deepEqual(catalogs.map(c=>c.owner).sort(),[1,2,3,4]);
});
test('a rejected PR field synchronization releases the coordinator for other workers',async()=>{
 const f=manyItems(2,'pr');let failed=false;
 f.github.syncPrFields=async c=>{if(!failed){failed=true;throw new Error('fields unavailable');}return c;};
 const result=await f.run();assert.equal(result.failed,1);assert.equal(result.processed,1);assert.equal(f.classifyCount,1);
});
test('authorized backfill enrolls a legacy triage item skipped by duplicate queue workers',async()=>{
 for(const eventName of ['workflow_dispatch','schedule']) {
  const f=fixture();f.items.get(1).labels=['triage'];let activeReads=0,models=0,enrollments=0;
  const get=f.github.getItem;f.github.getItem=async number=>{assert.equal(activeReads++,0);await Promise.resolve();const item=await get(number);activeReads--;return item;};
  f.github.queuePage=async()=>({items:Array.from({length:8},()=>({number:1})),nextCursor:null});
  const write=f.github.writeState;f.github.writeState=async(number,state,id)=>{if(id==null)enrollments++;return write(number,state,id);};
  const checkpoint={version:1,repository:'o/r',projectNumber:1,active:true,source:'workflow_dispatch',authorizedAt:new Date(time).toISOString(),page:1,offset:0};
  const result=await runEngine({...config,mode:'backfill',eventName},{github:f.github,now:()=>time,checkpoint:eventName==='schedule'?checkpoint:null,classify:async()=>{models++;return structuredClone(decision);}});
  assert.equal(result.processed,1);assert.equal(models,1);assert.equal(enrollments,1);assert.equal(lastState(f).enrollmentSource,'manual');assert.equal(lastState(f).phase,'complete');assert.equal(result.backfillRemaining,false);assert.equal(activeReads,0);
 }
});

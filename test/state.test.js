import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, readState, fingerprint, validCheckpoint, validQueueCheckpoint } from '../src/state.js';
const config = {repository:'o/r',projectNumber:1};
const marker = state => `<!-- issue-pr-triager:v1 ${JSON.stringify(state)} -->`;
const comment = (state, author='bot', id=1) => ({id,author,body:marker(state)});
const catalog = {labels:[{name:'bug',description:'defect'}]};
const item = {title:'Broken',body:'Details',comments:[],labels:[],type:null,priority:null,effort:null,projectValues:{},files:[],associations:[],kind:'issue'};
test('trusted state requires bot identity, shape, repository and project binding', () => {
 const state = newState(config,'manual');
 assert.equal(readState([comment(state)],'bot',config).commentId,1);
 assert.equal(readState([comment(state,'human')],'bot',config),null);
 for (const bad of [null,{}, {...state,version:2},{...state,repository:'evil/r'},{...state,projectNumber:2},{...state,enrollmentSource:'label'},{...state,phase:'evil'},{...state,pass:3},{...state,fingerprint:2},{...state,ownership:[]},{...state,unresolved:[1]},{...state,attempts:-1}]) assert.equal(readState([comment(bad)],'bot',config),null);
 assert.equal(readState([{id:1,author:'bot',body:'no marker'},{id:2,author:'bot',body:'<!-- issue-pr-triager:v1 {bad} -->'}],'bot',config),null);
 assert.equal(readState([comment(state),comment({...state,pass:1},'bot',2)],'bot',config).state.pass,1);
});
test('semantic fingerprint tracks human evidence and catalogs without bot feedback', () => {
 const first = fingerprint(item,catalog,{},'bot');
 const owned={labels:['bug'],type:'Bug',priority:'High',effort:'Small'};
 const changed={...item,body:'Details\n<!-- issue-pr-triager:link -->\nCloses #3\n<!-- /issue-pr-triager:link -->',labels:['triage','bug'],type:'Bug',priority:'High',effort:'Small',comments:[comment(newState(config,'creation'))],updatedAt:'later'};
 assert.equal(fingerprint(changed,catalog,owned,'bot'),first);
 assert.notEqual(fingerprint({...item,title:'Other'},catalog,{},'bot'),first);
 assert.notEqual(fingerprint({...item,comments:[{author:'human',body:'more',id:1}]},catalog,{},'bot'),first);
 assert.notEqual(fingerprint(item,{labels:[]},{},'bot'),first);
 assert.notEqual(fingerprint({...item,labels:['human']},catalog,{},'bot'),first);
 assert.equal(fingerprint({...item,kind:'pr',projectValues:{type:'Bug',priority:'High',effort:'Small'}},catalog,owned,'bot'),fingerprint({...item,kind:'pr'},catalog,{},'bot'));
 assert.notEqual(fingerprint({...item,comments:[{author:'bot',body:'ordinary bot note'}]},catalog,{},'bot'),first);
});
test('manual checkpoints bind authorization, owner, project and bounded age', () => {
 const now=Date.parse('2026-11-15T12:00:00Z');
 const cp={version:1,repository:'o/r',projectNumber:1,source:'workflow_dispatch',authorizedAt:new Date(now).toISOString(),page:1,offset:0,active:true};
 assert.equal(validCheckpoint(cp,config,now),true);
 for(const bad of [null,{}, {...cp,version:2},{...cp,repository:'x/y'},{...cp,projectNumber:2},{...cp,source:'schedule'},{...cp,authorizedAt:'bad'},{...cp,authorizedAt:new Date(now+1).toISOString()},{...cp,authorizedAt:new Date(now-30*86400000-1).toISOString()},{...cp,page:0},{...cp,offset:-1},{...cp,active:false}]) assert.equal(validCheckpoint(bad,config,now),false);
});
test('state rejects malformed ownership and write-ahead fields before trusting them',()=>{
 const state=newState(config,'manual');
 for(const bad of [{...state,ownership:{labels:[1]}},{...state,ownership:{labels:[],priority:4}},{...state,ownership:{labels:[],parent:-1}},{...state,pending:{}},{...state,pending:{field:'type',value:3}},{...state,pending:{field:'labels',value:['bug',1]}},{...state,pending:{field:'parent',value:0}},{...state,pending:{field:'unknown',value:'x'}}]) assert.equal(readState([comment(bad)],'bot',config),null);
 for(const pending of [{field:'labels',value:['bug']},{field:'type',value:'Bug'},{field:'parent',value:9}])assert.ok(readState([comment({...state,pending})],'bot',config));
 const before=fingerprint({...item,kind:'pr'},catalog,{labels:[]},'bot');assert.equal(fingerprint({...item,kind:'pr',associations:[9]},catalog,{labels:[],parent:9},'bot'),before);
});
test('label removal tombstones are validated and form semantic evidence',()=>{
 const state=newState(config,'manual');assert.deepEqual(state.removedLabels,[]);
 const legacy={...state};delete legacy.removedLabels;assert.deepEqual(readState([comment(legacy)],'bot',config).state.removedLabels,[]);
 assert.equal(readState([comment({...state,removedLabels:[1]})],'bot',config),null);
 assert.notEqual(fingerprint(item,catalog,{labels:['bug']},'bot',[]),fingerprint(item,catalog,{labels:['bug']},'bot',['bug']));
});
test('queue continuation validates its binding and bounded shape separately from manual authority',()=>{
 const cp={version:1,repository:'o/r',projectNumber:1,active:false,queueCursor:'opaque',queuePending:[1,2]};
 assert.equal(validQueueCheckpoint(cp,config),true);assert.equal(validCheckpoint(cp,config,Date.now()),false);
 for(const bad of [null,{}, {...cp,repository:'other/repo'},{...cp,projectNumber:2},{...cp,version:2},{...cp,queueCursor:42},{...cp,queueCursor:'x'.repeat(1025)},{...cp,queuePending:null},{...cp,queuePending:'1'},{...cp,queuePending:Array.from({length:21},(_,i)=>i+1)},{...cp,queuePending:[0]},{...cp,queuePending:[1.5]},{...cp,queuePending:['1']}])assert.equal(validQueueCheckpoint(bad,config),false);
});
test('catalog descriptions matter while native transport fields and project mirrors do not',()=>{
 const source={labels:[{name:'bug',description:'defect'}],types:[{name:'Bug',description:'broken'}],priority:{name:'Priority',description:'urgency',options:[{name:'High',description:'soon'}]},effort:{name:'Effort',description:'work',options:[{name:'Small',description:'hours'}]}};
 const first=fingerprint(item,source,{},'bot');assert.notEqual(fingerprint(item,{...source,priority:{...source.priority,options:[{name:'High',description:'within a day'}]}},{},'bot'),first);
 assert.equal(fingerprint(item,{...source,updatedAt:'later',project:{fields:[{dataType:'SINGLE_SELECT'}]},prFields:{type:{id:'new'}}},{},'bot'),first);
});

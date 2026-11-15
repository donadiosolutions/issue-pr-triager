import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../src/github.js';
import { newState, readState } from '../src/state.js';

const repository = 'sample/widget';
const error = status => Object.assign(new Error('safe failure'), {status});
const field = (id, name, options = []) => ({id, name, options});
const option = (id, name) => ({id, name, description: 'Synthetic description'});
const catalog = () => ({project:{id:'P',fields:[]},labels:[{id:1,name:'bug',description:'Synthetic'}],types:[{id:2,name:'Bug',description:'Synthetic'}],priority:field(3,'Priority',[option(4,'High')]),effort:field(5,'Effort',[option(6,'Small')])});
function mock(handler, options = {}) {
  const calls=[];
  const github=new GitHub({repository,request:async(method,path,body)=>{calls.push({method,path,body});return handler(method,path,body,calls);},...options});
  return {github,calls};
}
const page = (nodes, more=false, cursor=null) => ({nodes,pageInfo:{hasNextPage:more,endCursor:cursor}});

test('identity trusts GraphQL viewer and rejects partial GraphQL errors', async()=>{
  const {github}=mock(()=>({data:{viewer:{login:'triager[bot]'}}}));
  assert.equal(await github.identity(),'triager[bot]');
  const bad=mock(()=>({data:{viewer:{login:'attacker'}},errors:[{message:'secret'}]})).github;
  await assert.rejects(()=>bad.identity(),e=>e.message==='GitHub GraphQL request failed');
});

test('discover paginates every live catalog and resolves only organization native descriptors', async()=>{
  const c=catalog(); let projects=0;
  const {github,calls}=mock((method,path,body)=>{
    if(path==='/graphql') {projects++;return {data:{organization:{projectV2:{id:'P',fields:page(projects===1?[{id:'mirror',name:'Priority',isIssueField:true}]:[{id:'x',name:'Other'}],projects===1,'next')}}}};}
    if(path.startsWith('/repos/sample/widget/labels')) return path.endsWith('page=1')?Array.from({length:100},(_,i)=>({id:i,name:`label${i}`})):[{id:101,name:'last',description:'Last'}];
    if(path.startsWith('/orgs/sample/issue-types')) return [...c.types,{id:99,name:'Disabled',is_enabled:false}];
    if(path.startsWith('/orgs/sample/issue-fields')) return [c.priority,c.effort];
    throw new Error(path);
  });
  const result=await github.discover(7);
  assert.equal(result.labels.length,101); assert.equal(result.project.fields.length,2);
  assert.deepEqual(result.priority,c.priority); assert.deepEqual(result.effort,c.effort);
  assert.deepEqual(result.types,c.types);
  assert.equal(calls.filter(x=>x.path.startsWith('/repos/sample/widget/labels')).length,2);
  assert.equal(calls.filter(x=>x.path==='/graphql')[1].body.variables.after,'next');
});

test('apply writes native values additively, validates every choice before writes', async()=>{
  const {github,calls}=mock(()=>({}));const c=catalog();const item={number:1,id:'I',kind:'issue'};
  await github.apply(item,c,{labels:['bug'],type:'Bug',priority:'High',effort:'Small'});
  assert.deepEqual(calls.map(x=>[x.method,x.body]),[['POST',{labels:['bug']}],['PATCH',{type:'Bug'}],['POST',{issue_field_values:[{field_id:3,value:'High'}]}],['POST',{issue_field_values:[{field_id:5,value:'Small'}]}]]);
  for(const changes of [{labels:['unknown']},{type:'Unknown'},{priority:'Unknown'},{effort:'Unknown'},{other:'x'}]) await assert.rejects(()=>github.apply(item,c,changes),/Invalid classification/);
  assert.equal(calls.length,4);
});

test('syncPrFields creates classic fields, preserves historical IDs/options and supports dry-run', async()=>{
  const c=catalog();c.project.fields=[{id:'T',name:'PR Type',isIssueField:false,options:[{id:'old',name:'Historical',color:'RED',description:'Keep'}]}];
  const {github,calls}=mock((m,p,b)=>{
    const input=b.variables.input;
    if(b.query.includes('updateProjectV2Field')) return {data:{updateProjectV2Field:{projectV2Field:{...c.project.fields[0],dataType:'SINGLE_SELECT',options:input.singleSelectOptions.map((x,i)=>({...x,id:x.id??`opt${i}`}))}}}};
    return {data:{createProjectV2Field:{projectV2Field:{id:input.name,name:input.name,dataType:'SINGLE_SELECT',isIssueField:false,options:input.singleSelectOptions.map((x,i)=>({...x,id:`opt${i}`}))}}}};
  });
  const result=await github.syncPrFields(c);
  assert.equal(result.prFields.type.options[0].id,'old');
  assert.deepEqual(calls[0].body.variables.input.singleSelectOptions[0],{id:'old',name:'Historical',color:'RED',description:'Keep'});
  assert.equal(calls.length,3);
  assert.ok(calls.every(call=>call.body.query.includes('id name dataType isIssueField')));
  await github.syncPrFields(result);assert.equal(calls.length,3);
  const dry=mock(()=>assert.fail('write'),{dryRun:true}).github;
  const planned=await dry.syncPrFields(catalog());assert.equal(planned.prFields.effort.name,'PR Effort');
});

test('ensureProject and apply PR choices use classic field option IDs',async()=>{
  const {github,calls}=mock((m,p,b)=>b.query.includes('addProjectV2ItemById')?{data:{addProjectV2ItemById:{item:{id:'ITEM'}}}}:{data:{updateProjectV2ItemFieldValue:{projectV2Item:{id:'ITEM'}}}});
  const c=catalog();c.prFields={type:field('F','PR Type',[option('O','Bug')])};const item={number:2,id:'PR',kind:'pr'};
  assert.equal(await github.ensureProject(item,c),'ITEM');
  await github.apply(item,c,{type:'Bug'});
  assert.deepEqual(calls.at(-1).body.variables.input,{projectId:'P',itemId:'ITEM',fieldId:'F',value:{singleSelectOptionId:'O'}});
});

function itemMock(overrides={}) {
  return (m,p,b)=>{
    if(p==='/repos/sample/widget') return {default_branch:'main'};
    if(p==='/repos/sample/widget/issues/2') return {number:2,node_id:'PR',title:'Synthetic fix',body:'Body',state:'open',created_at:'2026-01-01',updated_at:'2026-01-02',pull_request:{},...overrides.issue};
    if(p==='/repos/sample/widget/pulls/2') return {base:{ref:'main'},head:{ref:'fix',sha:'sha'}};
    if(p.startsWith('/repos/sample/widget/issues/2/comments')) return [{id:9,body:'state',user:{login:'triager[bot]'}},{id:10,body:'human',user:null}];
    if(p.startsWith('/repos/sample/widget/issues/2/labels')) return [{name:'bug'}];
    if(p.startsWith('/repos/sample/widget/pulls/2/files')) return [{filename:'a.js',patch:'@@ Synthetic'}];
    if(p==='/graphql'&&b.query.includes('closingIssuesReferences')) return {data:{repository:{pullRequest:{closingIssuesReferences:page([{number:5,repository:{nameWithOwner:repository}},{number:99,repository:{nameWithOwner:'other/repo'}}])}}}};
    if(p==='/graphql') return {data:{node:{projectItems:page([{id:'ITEM',project:{id:'P'},type:{name:'Bug'},priority:null,effort:{name:'Small'}}])}}};
    throw new Error(p);
  };
}

test('getItem loads full comments, evidence, all existing associations and current-project values',async()=>{
  const {github}=mock(itemMock());github.catalog=catalog();
  const item=await github.getItem(2);
  assert.deepEqual(item,{number:2,id:'PR',kind:'pr',title:'Synthetic fix',body:'Body',state:'open',createdAt:'2026-01-01',updatedAt:'2026-01-02',labels:['bug'],type:null,priority:null,effort:null,projectValues:{type:'Bug',effort:'Small'},defaultBranch:'main',baseBranch:'main',headSha:'sha',headBranch:'fix',associations:[5,99],comments:[{id:9,body:'state',author:'triager[bot]'},{id:10,body:'human',author:null}],files:[{filename:'a.js',patch:'@@ Synthetic'}],truncated:false});
});

test('getItem reads native issue fields and nullable evidence',async()=>{
  const {github}=mock((m,p)=>{
    if(p==='/repos/sample/widget') return {default_branch:'main'};
    if(p==='/repos/sample/widget/issues/1') return {number:1,node_id:'I',title:'Synthetic',body:null,state:'closed',created_at:'date',updated_at:'date',type:{name:'Bug'}};
    if(p.includes('issue-field-values')) return [{issue_field_id:3,single_select_option:{name:'High'}},{issue_field_id:5,single_select_option:{name:'Small'}}];
    return [];
  });github.catalog=catalog();
  const item=await github.getItem(1);assert.equal(item.body,'');assert.equal(item.priority,'High');assert.equal(item.effort,'Small');assert.equal(item.type,'Bug');assert.equal(item.kind,'issue');assert.deepEqual(item.files,[]);
});

test('triage label lifecycle and state writes use exact marker',async()=>{
  let exists=false;const {github,calls}=mock((m,p,b)=>{
    if(m==='GET'&&p.endsWith('/labels/triage')&&!exists) throw error(404);
    if(m==='POST'&&p==='/repos/sample/widget/labels') {exists=true;return {};}
    if(p.includes('/comments')) return {id:77};
    return {};
  });
  await github.setTriage(2,true);await github.setTriage(2,false);
  const state={phase:'pending',unresolved:['priority']};
  assert.equal(await github.writeState(2,state),77);assert.equal(await github.writeState(2,state,77),77);
  assert.ok(calls.at(-1).body.body.includes(`<!-- issue-pr-triager:v1 ${JSON.stringify(state)} -->`));
  assert.equal(calls.at(-1).method,'PATCH');
});

test('candidate selection validates explicit refs and repo-scoped top20 search',async()=>{
  const {github,calls}=mock((m,p)=>{
    if(p.includes('/search/issues')) return {total_count:30,items:[{number:8},{number:9},{number:7}]};
    const n=Number(p.split('/').at(-1));
    if(n===4) throw error(404);
    return {number:n,title:'Synthetic issue',body:'Evidence',state:'open',...(n===9?{pull_request:{}}:{})};
  });
  const result=await github.candidates({number:10,title:'Fix synthetic parser',body:'Refs #7 #4 other/repo#44 https://example.com/#55'});
  assert.deepEqual(result.map(x=>x.number),[7,8]);assert.equal(result.truncated,true);
  const query=decodeURIComponent(calls.find(x=>x.path.includes('/search/issues')).path);
  assert.ok(query.includes('repo:sample/widget'));assert.ok(query.includes('per_page=20'));
  assert.ok(!calls.some(x=>/\/(44|55)$/u.test(x.path)));
});

test('link rereads PR and target, appends a single marked block then verifies body',async()=>{
  let body='Existing body';const {github,calls}=mock((m,p,b)=>{
    if(p.endsWith('/issues/6')) return {number:6,title:'Target',state:'open'};
    if(m==='PATCH') {body=b.body;return {};}
    throw new Error(p);
  });
  github.getItem=async()=>({number:2,id:'PR',kind:'pr',title:'Synthetic fix',headSha:'sha',baseBranch:'main',defaultBranch:'main',associations:[],body});
  assert.deepEqual(await github.link(await github.getItem(2),6),{linked:true});
  assert.equal(body,'Existing body\n\n<!-- issue-pr-triager:link -->\nCloses #6\n<!-- /issue-pr-triager:link -->');
  assert.deepEqual(await github.link(await github.getItem(2),6),{linked:true});assert.equal(calls.filter(x=>x.method==='PATCH').length,1);
});

test('backfill uses all states in immutable creation order',async()=>{
  const {github,calls}=mock(()=>Array.from({length:100},(_,i)=>({number:i,state:i%2?'open':'closed',created_at:'date'})));
  const first=await github.openPage(1);assert.equal(first.nextPage,2);assert.deepEqual(first.items[0],{number:0,state:'closed',createdAt:'date'});
  assert.ok(calls.at(-1).path.includes('state=all&sort=created&direction=asc'));
});

test('constructor fixes the API origin and rejects malformed repositories',async()=>{
  assert.throws(()=>new GitHub({repository:'sample/widget/../other'}),/Invalid repository/);
  const github=new GitHub({repository,token:'synthetic',fetch:async(url,init)=>{assert.equal(url,'https://api.github.com/graphql');assert.equal(init.headers['X-GitHub-Api-Version'],'2026-03-10');return {ok:true,status:200,json:async()=>({data:{viewer:{login:'app[bot]'}}})};}});
  assert.equal(await github.identity(),'app[bot]');
  await assert.rejects(()=>mock(()=>({data:null})).github.identity(),/GitHub GraphQL request failed/);
});

test('pagination rejects malformed lists and broken cursors and enforces finite limits',async()=>{
  await assert.rejects(()=>mock(()=>({})).github.pages('/list'),/Invalid GitHub list response/);
  await assert.rejects(()=>mock(()=>Array(100).fill({})).github.pages('/list',1),/pagination limit exceeded/);
  for(const cursor of [null,'same']) {
    const github=mock(()=>({data:{items:page([],true,cursor)}})).github;
    await assert.rejects(()=>github.connection('query',{},d=>d.items),/pagination cursor/);
  }
  let cursor=0;const github=mock(()=>({data:{items:page([],true,String(++cursor))}})).github;
  await assert.rejects(()=>github.connection('query',{},d=>d.items),/pagination limit exceeded/);
});

test('discovery fails closed for missing project and absent/ambiguous native fields',async()=>{
  await assert.rejects(()=>mock(()=>({data:{organization:null}})).github.discover(7),/Organization project not found/);
  for(const fields of [[],[{name:'Priority'}],[field(1,'Priority',[])],[catalog().priority,catalog().priority]]) {
    const github=mock((m,p)=>p==='/graphql'?{data:{organization:{projectV2:{id:'P',fields:page([])}}}}:p.includes('issue-fields')?fields:[]).github;
    await assert.rejects(()=>github.discover(7),/Native issue field unavailable/);
  }
});

test('PR schema refuses native mirror/collision fields and retains option defaults',async()=>{
  for(const fields of [[{name:'PR Type',isIssueField:true,options:[]}],[{name:'PR Type'}],[{name:'PR Type',options:[]},{name:'PR Type',options:[]}]]) {
    const c=catalog();c.project.fields=fields;
    await assert.rejects(()=>mock(()=>assert.fail('write')).github.syncPrFields(c),/unique classic/);
  }
  const c=catalog();c.types=[{name:'Bug'}];c.project.fields=[{id:'T',name:'PR Type',options:[{id:'H',name:'Historical'}]}];
  const github=mock(()=>assert.fail('dry-run write'),{dryRun:true}).github;
  const result=await github.syncPrFields(c);
  assert.deepEqual(result.prFields.type.options,[{id:'H',name:'Historical',color:'GRAY',description:''},{name:'Bug',color:'GRAY',description:''}]);
  assert.equal(result.prFields.type.id,'T');
});

test('dry-run prevents every write and apply rejects non-array labels',async()=>{
  const {github,calls}=mock(()=>assert.fail('write'),{dryRun:true});
  const item={number:1,id:'I',kind:'issue'};
  await github.apply(item,catalog(),{priority:'High'});
  await github.setTriage(1,true);await github.setTriage(1,false);
  assert.equal(await github.writeState(1,{phase:'pending',unresolved:[]}),null);
  assert.equal(await github.ensureProject(item,catalog()),'dry-run:project-item');
  await assert.rejects(()=>github.apply(item,catalog(),{labels:'bug'}),/Invalid classification/);
  await assert.rejects(()=>github.apply(item,catalog(),{labels:['triage']}),/Invalid classification/);
  assert.equal(calls.length,0);
});

test('PR writes refuse mirrored fields and unavailable options',async()=>{
  for(const f of [{isIssueField:true},field('T','PR Type',[])]) {
    const c=catalog();c.prFields={type:f};
    await assert.rejects(()=>mock(()=>assert.fail('write')).github.apply({kind:'pr'},c,{type:'Bug'}),/PR field/);
  }
});

test('getItem supports no discovery, missing native values and absent selected project',async()=>{
  const underlying=itemMock();
  const github=mock((m,p,b)=>p.includes('projectItems')?{data:{node:{projectItems:page([])}}}:underlying(m,p,b)).github;
  assert.deepEqual((await github.getItem(2)).projectValues,{});
  github.catalog=catalog();
  const previous=github.request;
  github.request=async(m,p,b)=>p==='/graphql'&&b.query.includes('projectItems')?{data:{node:{projectItems:page([{project:{id:'OTHER'}}])}}}:previous(m,p,b);
  assert.deepEqual((await github.getItem(2)).projectValues,{});
  const issue=mock((m,p)=>p==='/repos/sample/widget/issues/1'?{number:1}:p==='/repos/sample/widget'?{default_branch:'main'}:p.includes('issue-field-values')?[{issue_field_id:3}]:[]).github;
  assert.equal((await issue.getItem(1)).priority,null);
  issue.catalog=catalog();assert.equal((await issue.getItem(1)).priority,null);
});

test('PR evidence bounds patch volume and file pages, flagging missing patches',async()=>{
  const underlying=itemMock();const github=mock((m,p,b)=>p.includes('/pulls/2/files')?Array.from({length:100},(_,i)=>({filename:`${i}.js`,...(i?{patch:'x'.repeat(3000)}:{})})):underlying(m,p,b)).github;
  const item=await github.getItem(2);assert.equal(item.truncated,true);assert.equal(item.files.length,300);assert.equal(item.files.reduce((n,f)=>n+f.patch.length,0),200000);
});

test('triage tolerates races and missing removal but propagates other failures',async()=>{
  const {github}=mock((m,p)=>{if(m==='GET') {if(p.endsWith('/labels/triage')) return {};return [];}if(m==='DELETE') throw error(404);return {};});
  await github.setTriage(1,true);await github.setTriage(1,false);
  for(const status of [403,500]) {
    await assert.rejects(()=>mock(()=>{throw error(status);}).github.setTriage(1,true),{status});
    await assert.rejects(()=>mock(()=>{throw error(status);}).github.setTriage(1,false),{status});
  }
  for(const status of [422,403]) {
    let gets=0;const github=mock(m=>{if(m==='GET'&&gets++===0) throw error(404);if(m==='POST'&&gets===1) {gets++;throw error(status);}return {};}).github;
    if(status===422) await github.setTriage(1,true);
    else await assert.rejects(()=>github.setTriage(1,true),{status});
  }
});

test('candidate bounds account for incomplete search, too many references and null bodies',async()=>{
  const {github}=mock((m,p)=>p.startsWith('/search')?{incomplete_results:true,total_count:20,items:Array.from({length:20},(_,i)=>({number:i+30}))}:{number:Number(p.split('/').at(-1)),title:'Synthetic',body:null,state:'closed'});
  const result=await github.candidates({number:500,title:'Synthetic evidence',body:Array.from({length:21},(_,i)=>`#${i+1}`).join(' ')});
  assert.equal(result.length,20);assert.equal(result.truncated,true);assert.equal(result[0].body,'');
  assert.deepEqual(await mock(()=>assert.fail('no words or refs')).github.candidates({number:1,title:'123',body:''}),Object.assign([],{truncated:false}));
  const empty=await mock(()=>({total_count:0,items:[]})).github.candidates({number:1,title:'This request',body:''});assert.equal(empty.truncated,false);
  await assert.rejects(()=>mock(()=>{throw error(403);}).github.candidates({number:1,title:'',body:'#4'}),{status:403});
});

test('link conservatively skips existing associations, nondefault PRs, conflicting blocks and PR targets',async()=>{
  const item={number:2,id:'PR',kind:'pr',title:'Synthetic fix',headSha:'sha',baseBranch:'main',defaultBranch:'main',associations:[],body:''};
  for(const [overrides,reason] of [[{kind:'issue'},'non-default branch'],[{baseBranch:'dev'},'non-default branch'],[{body:'<!-- issue-pr-triager:link --> existing'},'existing link block']]) {
    const github=mock(()=>assert.fail('write')).github;github.getItem=async()=>({...item,...overrides});
    assert.deepEqual(await github.link({...item,...overrides},6),{linked:false,reason});
  }
  const associated=mock(()=>assert.fail('write')).github;associated.getItem=async()=>({...item,associations:[7]});assert.deepEqual(await associated.link(item,6),{linked:true});
  const targetPr=mock(()=>({pull_request:{}})).github;targetPr.getItem=async()=>item;assert.equal((await targetPr.link(item,6)).reason,'target is not an issue');
  const dry=mock(()=>({state:'open'}),{dryRun:true}).github;dry.getItem=async()=>item;assert.equal((await dry.link(item,6)).reason,'dry-run');
  const {github,calls}=mock(()=>({state:'open'}));github.getItem=async()=>item;
  assert.equal((await github.link(item,6)).reason,'body verification failed');assert.equal(calls.find(x=>x.method==='PATCH').body.body,'<!-- issue-pr-triager:link -->\nCloses #6\n<!-- /issue-pr-triager:link -->');
});

test('backfill ends after a short page',async()=>{
  assert.deepEqual(await mock(()=>[]).github.openPage(3),{items:[],nextPage:null});
});

test('PR field synchronization updates current descriptions without losing IDs or historical choices',async()=>{
  const c=catalog();c.project.fields=[
    {id:'T',name:'PR Type',dataType:'SINGLE_SELECT',isIssueField:false,options:[{id:'B',name:'Bug',color:'BLUE',description:'Old description'},{id:'H',name:'Historical',color:'RED',description:'Keep history'}]},
    {id:'P',name:'PR Priority',dataType:'SINGLE_SELECT',isIssueField:false,options:[{id:'P1',name:'High',color:'GRAY',description:'Synthetic description'}]},
    {id:'E',name:'PR Effort',dataType:'SINGLE_SELECT',isIssueField:false,options:[{id:'E1',name:'Small',color:'GRAY',description:'Synthetic description'}]},
  ];
  const {github,calls}=mock((m,p,b)=>({data:{updateProjectV2Field:{projectV2Field:{...c.project.fields.find(f=>f.id===b.variables.input.fieldId),options:b.variables.input.singleSelectOptions}}}}));
  const result=await github.syncPrFields(c);
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].body.variables.input.singleSelectOptions,[{id:'B',name:'Bug',color:'BLUE',description:'Synthetic'},{id:'H',name:'Historical',color:'RED',description:'Keep history'}]);
  await github.syncPrFields(result);assert.equal(calls.length,1);
  c.types[0].description=null;
  await github.syncPrFields(result);assert.equal(calls.length,2);
  assert.equal(calls[1].body.variables.input.singleSelectOptions[0].description,'');
});

test('queuePage reads exactly one bounded GraphQL search page and preserves cursor',async()=>{
  const {github,calls}=mock((m,p,b)=>({data:{search:page([{number:b.variables.after?2:1}],!b.variables.after,'cursor-1')}}));
  assert.deepEqual(await github.queuePage(),{items:[{number:1}],nextCursor:'cursor-1'});
  assert.deepEqual(await github.queuePage('cursor-1',5),{items:[{number:2}],nextCursor:null});
  assert.equal(calls.length,2);
  assert.deepEqual(calls[0].body.variables,{query:'repo:sample/widget is:open label:triage sort:created-asc',first:20,after:null});
  assert.ok(calls[0].body.query.includes('type:ISSUE'));
  assert.ok(calls[0].body.query.includes('... on Issue'));
  assert.ok(calls[0].body.query.includes('... on PullRequest'));
  assert.equal(calls[1].body.variables.first,5);
});

test('queuePage fails closed for invalid inputs, null results, duplicate nodes and nonadvancing cursors',async()=>{
  const good=mock(()=>({data:{search:page([])}})).github;
  for(const [cursor,limit] of [['',20],[42,20],[null,0],[null,101],[null,1.5]]) await assert.rejects(()=>good.queuePage(cursor,limit),/Invalid GitHub queue/);
  assert.deepEqual(await good.queuePage(null,1),{items:[],nextCursor:null});
  for(const search of [null,{},page([null]),page([{number:1},{number:1}]),page([{number:0}]),page([{number:1}],true,null),page([{number:1}],true,'same'),{nodes:[],pageInfo:{hasNextPage:null}},page([{number:1},{number:2}])]) {
    const github=mock(()=>({data:{search}})).github;
    await assert.rejects(()=>github.queuePage('same',1),/Invalid GitHub queue/);
  }
  for(const search of [page([{number:1},{number:1}]),page([{}]),page([{number:1}],true,'')]) await assert.rejects(()=>mock(()=>({data:{search}})).github.queuePage(null,2),/Invalid GitHub queue/);
});

test('setDeadline updates the transport deadline callback and retains injected request support',async()=>{
  const {github}=mock(()=>({data:{viewer:{login:'synthetic[bot]'}}}));
  assert.equal(github.deadline,Infinity);github.setDeadline(123);assert.equal(github.deadline,123);
  assert.equal(await github.identity(),'synthetic[bot]');
  let calls=0;
  const actual=new GitHub({repository,token:'synthetic',now:()=>100,fetch:async()=>{calls++;return {ok:true,status:200,json:async()=>({data:{viewer:{login:'synthetic[bot]'}}})};}});
  assert.equal(await actual.identity(),'synthetic[bot]');
  actual.setDeadline(99);
  await assert.rejects(()=>actual.identity(),/deadline/i);
  assert.equal(calls,1);
});

test('state marker safely roundtrips comment delimiters and bounds neutral plaintext reasons',async()=>{
  const config={repository,projectNumber:7};
  const state=newState(config,'manual');
  state.unresolved=['--> @team [click](https://example.invalid) **bold** <script>', 'x'.repeat(2000)];
  const {github,calls}=mock(()=>({id:88}));
  await github.writeState(1,state);
  const body=calls[0].body.body;
  const [marker,visible]=body.split('\n');
  assert.ok(marker.includes('\\u003e'));assert.ok(marker.includes('\\u003c'));
  assert.equal(marker.indexOf('-->'),marker.length-3);
  assert.deepEqual(readState([{id:88,body,author:'synthetic[bot]'}],'synthetic[bot]',config).state,state);
  assert.ok(visible.length<=800);assert.doesNotMatch(visible,/[@\[\]<>*`]/u);
});

test('REST pagination appends page parameters after an existing query',async()=>{
  const {github,calls}=mock(()=>[]);
  assert.deepEqual(await github.pages('/synthetic?state=all'),[]);
  assert.equal(calls[0].path,'/synthetic?state=all&per_page=100&page=1');
});

test('link defers without any write when classifier evidence changes before its fresh read',async()=>{
  const item={number:2,id:'PR',kind:'pr',title:'Synthetic fix',body:'Original evidence',headSha:'original-sha',baseBranch:'main',defaultBranch:'main',associations:[]};
  for(const changed of [{headSha:'new-sha'},{title:'Different scope'},{body:'Changed evidence'},{body:'<!-- issue-pr-triager:link -->\nCloses #6\n<!-- /issue-pr-triager:link -->'}]) {
    const {github,calls}=mock(()=>assert.fail('must defer before target read or body write'));
    github.getItem=async()=>({...item,...changed});
    assert.deepEqual(await github.link(item,6),{linked:false,reason:'PR evidence changed'});
    assert.equal(calls.length,0);
  }
});

test('link defers when a previously proposed target has closed',async()=>{
  const item={number:2,id:'PR',kind:'pr',title:'Synthetic fix',body:'Original evidence',headSha:'original-sha',baseBranch:'main',defaultBranch:'main',associations:[]};
  const {github,calls}=mock((m)=>{assert.equal(m,'GET');return {number:6,state:'closed'};});
  github.getItem=async()=>item;
  assert.deepEqual(await github.link(item,6),{linked:false,reason:'target is not open'});
  assert.equal(calls.length,1);
});

test('link verification requires the entire expected body and unchanged available head SHA',async()=>{
  const base={number:2,id:'PR',kind:'pr',title:'Synthetic fix',body:'Original evidence',headSha:'original-sha',baseBranch:'main',defaultBranch:'main',associations:[]};
  for(const mode of ['body','head','no-head']) {
    const item={...base,...(mode==='no-head'?{headSha:null}:{})};
    let reads=0,expectedBody;
    const {github,calls}=mock((m,p,b)=>{if(m==='PATCH') expectedBody=b.body;return {number:6,state:'open'};});
    github.getItem=async()=>++reads===1?item:{...item,body:expectedBody+(mode==='body'?'\nConcurrent edit':''),headSha:mode==='head'?'new-sha':item.headSha};
    const result=await github.link(item,6);
    assert.deepEqual(result,mode==='no-head'?{linked:true}:{linked:false,reason:'body verification failed'});
    assert.equal(calls.filter(call=>call.method==='PATCH').length,1);
  }
});

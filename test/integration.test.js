import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../src/github.js';
import { createClassifier } from '../src/models.js';
import { runEngine } from '../src/engine.js';
import { readState } from '../src/state.js';

const repository='example/widget';
const bot='triager[bot]';
const now=()=>Date.parse('2026-11-15T12:00:00Z');
const cfg={repository,projectNumber:7,mode:'process',eventName:'schedule',event:{}};
const page=nodes=>({nodes,pageInfo:{hasNextPage:false,endCursor:null}});

function system(kind='issue') {
  const labels=[{id:1,name:'triage',description:'Managed queue'},{id:2,name:'bug',description:'Unexpected behavior'}];
  const types=[{id:3,name:'Bug',description:'A defect',is_enabled:true},{id:99,name:'Disabled',is_enabled:false}];
  const fields=[{id:4,name:'Priority',description:'Impact',options:[{id:5,name:'High',description:'Blocks work'}]},{id:6,name:'Effort',description:'Relative story effort',options:[{id:7,name:'1',description:'Small change'}]}];
  const issue={number:1,node_id:'I_1',title:'Synthetic change',body:'Illustrative data. A scoped correction.',state:'open',created_at:'2026-11-01T00:00:00Z',updated_at:'2026-11-01T00:00:00Z',...(kind==='pr'?{pull_request:{}}:{})};
  const comments=[];
  const currentLabels=[];
  const values=[];
  const projectFields=[];
  const memberships=new Set();
  const projectValues={};
  const writes=[];
  const modelCalls=[];
  let revision='first';
  const request=async(method,path,body)=>{
    const url=new URL(path,'https://api.github.com');
    const route=url.pathname;
    if(method!=='GET'&&!(route==='/graphql'&&body.query.startsWith('query')))writes.push({method,path,body:structuredClone(body)});
    if(route==='/graphql') {
      if(body.query.includes('viewer'))return {data:{viewer:{login:bot}}};
      if(body.query.includes('search('))return {data:{search:page(issue.state==='open'&&currentLabels.includes('triage')?[{number:1}]:[])}};
      if(body.query.includes('organization(login'))return {data:{organization:{projectV2:{id:'P',fields:page(structuredClone(projectFields))}}}};
      if(body.query.includes('addProjectV2ItemById')){memberships.add(body.variables.input.contentId);return {data:{addProjectV2ItemById:{item:{id:'PI'}}}};}
      if(body.query.includes('createProjectV2Field')){
        const input=body.variables.input;
        const field={id:`F_${projectFields.length}`,name:input.name,dataType:'SINGLE_SELECT',isIssueField:false,options:input.singleSelectOptions.map((o,n)=>({...o,id:`O_${projectFields.length}_${n}`}))};
        projectFields.push(field);return {data:{createProjectV2Field:{projectV2Field:structuredClone(field)}}};
      }
      if(body.query.includes('updateProjectV2ItemFieldValue')){
        const input=body.variables.input;const field=projectFields.find(f=>f.id===input.fieldId);
        projectValues[field.name]=field.options.find(o=>o.id===input.value.singleSelectOptionId).name;
        return {data:{updateProjectV2ItemFieldValue:{projectV2Item:{id:'PI'}}}};
      }
      if(body.query.includes('closingIssuesReferences'))return {data:{repository:{pullRequest:{closingIssuesReferences:page([])}}}};
      if(body.query.includes('projectItems'))return {data:{node:{projectItems:page(memberships.has(issue.node_id)?[{id:'PI',project:{id:'P'},type:projectValues['PR Type']?{name:projectValues['PR Type']}:null,priority:projectValues['PR Priority']?{name:projectValues['PR Priority']}:null,effort:projectValues['PR Effort']?{name:projectValues['PR Effort']}:null}]:[])}}};
      throw new Error(`Unexpected GraphQL operation: ${body.query.slice(0,45)}`);
    }
    if(route==='/orgs/example/issue-types')return structuredClone(types);
    if(route==='/orgs/example/issue-fields')return structuredClone(fields);
    if(route==='/repos/example/widget')return {default_branch:'main'};
    if(route==='/repos/example/widget/labels')return structuredClone(labels);
    if(route==='/repos/example/widget/labels/triage')return labels[0];
    if(route==='/repos/example/widget/issues/1'){
      if(method==='PATCH')Object.assign(issue,body.type?{type:{name:body.type}}:body);
      return structuredClone(issue);
    }
    if(route==='/repos/example/widget/issues/1/labels'){
      if(method==='POST')currentLabels.push(...body.labels.filter(n=>!currentLabels.includes(n)));
      return currentLabels.map(name=>({name}));
    }
    if(route==='/repos/example/widget/issues/1/labels/triage'){currentLabels.splice(currentLabels.indexOf('triage'),1);return null;}
    if(route==='/repos/example/widget/issues/1/comments'){
      if(method==='POST'){const c={id:100,body:body.body,user:{login:bot}};comments.push(c);return c;}
      return structuredClone(comments);
    }
    if(route==='/repos/example/widget/issues/comments/100'){comments[0].body=body.body;return {id:100};}
    if(route==='/repos/example/widget/issues/1/issue-field-values'){
      if(method==='POST')for(const v of body.issue_field_values){const descriptor=fields.find(f=>f.id===v.field_id);const option=descriptor.options.find(o=>o.name===v.value);const old=values.find(x=>x.issue_field_id===v.field_id);const record={issue_field_id:v.field_id,single_select_option:{name:option.name}};if(old)Object.assign(old,record);else values.push(record);}
      return structuredClone(values);
    }
    if(route==='/repos/example/widget/pulls/1')return {base:{ref:'main'},head:{ref:'synthetic',sha:revision}};
    if(route==='/repos/example/widget/pulls/1/files')return [{filename:'a.js',patch:'@@ scoped fix'}];
    if(route==='/search/issues')return {total_count:0,items:[]};
    throw new Error(`Unexpected route: ${method} ${path}`);
  };
  const github=new GitHub({repository,request});
  const classify=createClassifier({token:'synthetic',request:async(_method,path,body)=>{
    modelCalls.push({path,body});
    assert.equal(body.model,'gpt-6-luna');
    assert.ok(body.questions.every(q=>q.name!=='label:triage'));
    assert.ok(!JSON.stringify(body.input).includes('issue-pr-triager:v1'));
    return {model:'gpt-6-luna',answers:body.questions.map(q=>q.type==='predicate'?{name:q.name,type:'predicate',probability:q.name==='label:bug'?.99:.01}:{name:q.name,type:'choice',choice:q.choices[0].value,confidence:.99}),usage:{input_tokens:2,output_tokens:0}};
  }});
  const run=async(extra={},checkpoint=null)=>runEngine({...cfg,...extra},{github,classify,now,checkpoint});
  const state=()=>readState(comments.map(c=>({id:c.id,body:c.body,author:c.user.login})),bot,cfg).state;
  return {github,run,state,issue,currentLabels,projectValues,memberships,modelCalls,writes,revise:()=>{revision='second'}};
}

test('real adapters enroll project membership before any model and add labels without the queue label',async()=>{
  const s=system();
  await s.run({mode:'enroll',eventName:'issues',event:{action:'opened',issue:{number:1}}});
  assert.ok(s.memberships.has('I_1'));
  assert.equal(s.modelCalls.length,0);
  const r=await s.run();
  assert.equal(r.failed,0,JSON.stringify(r.diagnostics));
  assert.equal(r.processed,1);
  assert.equal(s.state().phase,'complete');
  assert.deepEqual(s.currentLabels,['bug']);
  assert.ok(s.writes.some(w=>w.body?.labels?.length===1&&w.body.labels[0]==='bug'));
  assert.equal(s.issue.type.name,'Bug');
});

test('real PR project field creation stays semantically stable and synchronize revisits a completed PR',async()=>{
  const s=system('pr');
  await s.run({mode:'enroll',eventName:'pull_request_target',event:{action:'opened',pull_request:{number:1}}});
  let r=await s.run();
  assert.equal(r.failed,0,JSON.stringify(r.diagnostics));
  assert.equal(r.processed,1);
  assert.deepEqual(s.projectValues,{'PR Type':'Bug','PR Priority':'High','PR Effort':'1'});
  assert.equal(s.modelCalls.length,1);
  s.revise();
  r=await s.run({eventName:'pull_request_target',event:{action:'synchronize',pull_request:{number:1}}});
  assert.equal(r.processed,1);
  assert.equal(s.modelCalls.length,2);
});

test('real filtered queue skips legacy items and human-removed bot labels remain removed after edits',async()=>{
  const s=system();s.currentLabels.push('triage');
  let r=await s.run();
  assert.equal(r.processed,0);
  assert.equal(s.modelCalls.length,0);
  await s.run({mode:'enroll',eventName:'issues',event:{action:'opened',issue:{number:1}}});
  await s.run();
  s.currentLabels.splice(s.currentLabels.indexOf('bug'),1);
  s.issue.body+=' Human clarification.';
  r=await s.run({eventName:'issues',event:{action:'edited',issue:{number:1}}});
  assert.equal(r.processed,1);
  assert.deepEqual(s.currentLabels,[]);
  assert.deepEqual(s.state().removedLabels,['bug']);
});

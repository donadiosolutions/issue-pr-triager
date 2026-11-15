import { createHttp } from './http.js';

const FIELD_SELECTION = `... on ProjectV2Field { id name dataType isIssueField }
  ... on ProjectV2SingleSelectField { id name dataType isIssueField options { id name color description } }`;
const FIELD_RESULT = '... on ProjectV2SingleSelectField { id name dataType isIssueField options { id name color description } }';
const LINK_START = '<!-- issue-pr-triager:link -->';
const LINK_END = '<!-- /issue-pr-triager:link -->';

export class GitHub {
  constructor({token,repository,dryRun=false,fetch,sleep,now,request}) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error('Invalid repository');
    this.repository=repository;
    [this.owner,this.repo]=repository.split('/');
    this.root=`/repos/${repository}`;
    this.dryRun=dryRun;
    this.deadline=Infinity;
    this.request=request ?? createHttp({token,origin:'https://api.github.com',fetch,sleep,now,deadline:()=>this.deadline});
  }

  setDeadline(deadline) {
    this.deadline=deadline;
  }

  async graphql(query, variables={}) {
    const result=await this.request('POST','/graphql',{query,variables});
    if (result.errors?.length || !result.data) throw new Error('GitHub GraphQL request failed');
    return result.data;
  }

  async pages(path, limit=1000) {
    const items=[];
    for(let p=1;p<=limit;p++) {
      const rows=await this.request('GET',`${path}${path.includes('?')?'&':'?'}per_page=100&page=${p}`);
      if (!Array.isArray(rows)) throw new Error('Invalid GitHub list response');
      items.push(...rows);
      if(rows.length<100) return items;
    }
    throw new Error('GitHub pagination limit exceeded');
  }

  async connection(query, variables, select) {
    const nodes=[];let after=null;
    for(let p=0;p<1000;p++) {
      const data=await this.graphql(query,{...variables,after});
      const connection=select(data);
      nodes.push(...connection.nodes);
      if(!connection.pageInfo.hasNextPage) return nodes;
      if(!connection.pageInfo.endCursor || connection.pageInfo.endCursor===after) throw new Error('Invalid GitHub pagination cursor');
      after=connection.pageInfo.endCursor;
    }
    throw new Error('GitHub pagination limit exceeded');
  }

  async identity() {
    const data=await this.graphql('query { viewer { login } }');
    return data.viewer.login;
  }

  async discover(projectNumber,priorityName='Priority',effortName='Effort') {
    let projectId;
    const fields=await this.connection(`query($owner:String!,$number:Int!,$after:String) { organization(login:$owner) { projectV2(number:$number) { id fields(first:100,after:$after) { nodes { ${FIELD_SELECTION} } pageInfo {hasNextPage endCursor} } } } }`,{owner:this.owner,number:projectNumber},data=>{
      const project=data.organization?.projectV2;
      if(!project) throw new Error('Organization project not found');
      projectId=project.id;return project.fields;
    });
    const labels=await this.pages(`${this.root}/labels`);
    const types=(await this.pages(`/orgs/${this.owner}/issue-types`)).filter(type=>type.is_enabled!==false);
    const native=await this.pages(`/orgs/${this.owner}/issue-fields`);
    const descriptor=name=>{
      const matches=native.filter(f=>f.name===name);
      if(matches.length!==1 || !Array.isArray(matches[0].options) || matches[0].options.length===0) throw new Error('Native issue field unavailable');
      return matches[0];
    };
    this.catalog={project:{id:projectId,fields},labels,types,priority:descriptor(priorityName),effort:descriptor(effortName)};
    return this.catalog;
  }

  async syncPrFields(catalog) {
    const prFields={};
    for(const [key,choices] of Object.entries({type:catalog.types,priority:catalog.priority.options,effort:catalog.effort.options})) {
      const name=`PR ${key[0].toUpperCase()}${key.slice(1)}`;
      const matches=catalog.project.fields.filter(f=>f.name===name);
      if(matches.length>1 || (matches.length===1 && (matches[0].isIssueField || !Array.isArray(matches[0].options)))) throw new Error('PR field must be a unique classic single-select field');
      let field=matches[0];
      const existing=field?.options ?? [];
      const additions=choices.filter(c=>!existing.some(o=>o.name===c.name));
      const options=[...existing.map(o=>{
        const current=choices.find(c=>c.name===o.name);
        return {id:o.id,name:o.name,color:o.color ?? 'GRAY',description:(current?current.description:o.description) ?? ''};
      }),...additions.map(c=>({name:c.name,color:'GRAY',description:c.description ?? ''}))];
      const descriptionChanged=existing.some((o,i)=>(o.description ?? '')!==options[i].description);
      if(!field || additions.length || descriptionChanged) {
        if(this.dryRun) field={id:field?.id ?? `dry-run:${name}`,name,dataType:'SINGLE_SELECT',isIssueField:false,options};
        else if(field) {
          const data=await this.graphql(`mutation($input:UpdateProjectV2FieldInput!) { updateProjectV2Field(input:$input) { projectV2Field { ${FIELD_RESULT} } } }`,{input:{fieldId:field.id,singleSelectOptions:options}});
          field=data.updateProjectV2Field.projectV2Field;
        } else {
          const data=await this.graphql(`mutation($input:CreateProjectV2FieldInput!) { createProjectV2Field(input:$input) { projectV2Field { ${FIELD_RESULT} } } }`,{input:{projectId:catalog.project.id,name,dataType:'SINGLE_SELECT',singleSelectOptions:options}});
          field=data.createProjectV2Field.projectV2Field;
        }
        catalog.project.fields=catalog.project.fields.filter(f=>f.name!==name).concat(field);
      }
      prFields[key]=field;
    }
    catalog.prFields=prFields;
    this.catalog=catalog;
    return catalog;
  }

  async getItem(number) {
    const issue=await this.request('GET',`${this.root}/issues/${number}`);
    const repo=await this.request('GET',this.root);
    const labels=await this.pages(`${this.root}/issues/${number}/labels`);
    const comments=await this.pages(`${this.root}/issues/${number}/comments`);
    const item={number:issue.number,id:issue.node_id,kind:issue.pull_request?'pr':'issue',title:issue.title,body:issue.body ?? '',state:issue.state,createdAt:issue.created_at,updatedAt:issue.updated_at,labels:labels.map(l=>l.name),type:issue.type?.name ?? null,priority:null,effort:null,projectValues:{},defaultBranch:repo.default_branch,baseBranch:null,headSha:null,headBranch:null,associations:[],comments:comments.map(c=>({id:c.id,body:c.body,author:c.user?.login ?? null})),files:[],truncated:false};
    if(item.kind==='issue') {
      const values=await this.pages(`${this.root}/issues/${number}/issue-field-values`);
      for(const key of ['priority','effort']) {
        const value=values.find(v=>v.issue_field_id===this.catalog?.[key].id);
        item[key]=value?.single_select_option?.name ?? null;
      }
    } else {
      const pr=await this.request('GET',`${this.root}/pulls/${number}`);
      item.baseBranch=pr.base.ref;item.headBranch=pr.head.ref;item.headSha=pr.head.sha;
      const associations=await this.connection('query($owner:String!,$repo:String!,$number:Int!,$after:String) { repository(owner:$owner,name:$repo) { pullRequest(number:$number) { closingIssuesReferences(first:100,after:$after) {nodes {number repository {nameWithOwner}} pageInfo {hasNextPage endCursor}} } } }',{owner:this.owner,repo:this.repo,number},d=>d.repository.pullRequest.closingIssuesReferences);
      item.associations=associations.map(i=>i.number);
      if(this.catalog) {
        const projects=await this.connection('query($id:ID!,$after:String) { node(id:$id) { ... on PullRequest {projectItems(first:100,after:$after) {nodes {id project {id} type:fieldValueByName(name:"PR Type") {... on ProjectV2ItemFieldSingleSelectValue {name}} priority:fieldValueByName(name:"PR Priority") {... on ProjectV2ItemFieldSingleSelectValue {name}} effort:fieldValueByName(name:"PR Effort") {... on ProjectV2ItemFieldSingleSelectValue {name}}} pageInfo {hasNextPage endCursor}}} } }',{id:item.id},d=>d.node.projectItems);
        const project=projects.find(p=>p.project.id===this.catalog.project.id);
        if(project) for(const key of ['type','priority','effort']) if(project[key]) item.projectValues[key]=project[key].name;
      }
      let bytes=0;
      for(let p=1;p<=3;p++) {
        const files=await this.request('GET',`${this.root}/pulls/${number}/files?per_page=100&page=${p}`);
        for(const file of files) {
          const patch=file.patch ?? '';
          if(!file.patch || bytes+patch.length>200000) item.truncated=true;
          const bounded=patch.slice(0,Math.max(0,200000-bytes));
          bytes+=bounded.length;
          item.files.push({filename:file.filename,patch:bounded});
        }
        if(files.length<100) break;
        if(p===3) item.truncated=true;
      }
    }
    return item;
  }

  async ensureProject(item,catalog) {
    if(this.dryRun) return 'dry-run:project-item';
    const data=await this.graphql('mutation($input:AddProjectV2ItemByIdInput!) { addProjectV2ItemById(input:$input) { item {id} } }',{input:{projectId:catalog.project.id,contentId:item.id}});
    return data.addProjectV2ItemById.item.id;
  }

  async setTriage(number,enabled) {
    if(this.dryRun) return;
    if(enabled) {
      try {await this.request('GET',`${this.root}/labels/triage`);}
      catch(error) {
        if(error.status!==404) throw error;
        try {await this.request('POST',`${this.root}/labels`,{name:'triage',color:'D4C5F9',description:'Automated triage pending human or model review'});}
        catch(createError) {
          if(createError.status!==422) throw createError;
          await this.request('GET',`${this.root}/labels/triage`);
        }
      }
      await this.request('POST',`${this.root}/issues/${number}/labels`,{labels:['triage']});
    } else {
      try {await this.request('DELETE',`${this.root}/issues/${number}/labels/triage`);}
      catch(error) {if(error.status!==404) throw error;}
    }
  }

  async writeState(number,state,commentId=null) {
    if(this.dryRun) return commentId;
    const encoded=JSON.stringify(state).replaceAll('<','\\u003c').replaceAll('>','\\u003e');
    const visible=`Triage status: ${state.phase}. ${state.unresolved.join('; ')}`.slice(0,800).replace(/[^\p{L}\p{N} .,;:()/+-]/gu,' ').replace(/\s+/gu,' ');
    const body=`<!-- issue-pr-triager:v1 ${encoded} -->\n${visible}`;
    const comment=await this.request(commentId===null?'POST':'PATCH',commentId===null?`${this.root}/issues/${number}/comments`:`${this.root}/issues/comments/${commentId}`,{body});
    return comment.id;
  }

  async candidates(item) {
    const result=[];result.truncated=false;
    const text=`${item.title}\n${item.body}`.replace(/https?:\/\/\S+/giu,'');
    const refs=[...new Set([...text.matchAll(/(?<![\w/#])#([1-9]\d*)\b/gu)].map(m=>Number(m[1])))];
    const seen=new Set([item.number]);
    const add=async number=>{
      if(seen.has(number)) return;
      seen.add(number);
      let candidate;
      try {candidate=await this.request('GET',`${this.root}/issues/${number}`);}
      catch(error) {if(error.status===404) return;throw error;}
      if(!candidate.pull_request) result.push({number:candidate.number,title:candidate.title,body:candidate.body ?? '',state:candidate.state});
    };
    for(const number of refs.slice(0,20)) await add(number);
    if(refs.length>20) result.truncated=true;
    const words=[...new Set(item.title.toLowerCase().match(/[a-z]{4,}/gu) ?? [])].filter(w=>!['this','that','with','from','into','when','then','have','does','should','would','could','issue','pull','request'].includes(w)).slice(0,5);
    if(words.length) {
      const query=`repo:${this.repository} is:issue ${words.join(' ')}`;
      const search=await this.request('GET',`/search/issues?q=${encodeURIComponent(query)}&per_page=20&page=1`);
      if(search.incomplete_results || search.total_count>search.items.length) result.truncated=true;
      for(const hit of search.items) {
        if(result.length===20) {result.truncated=true;break;}
        await add(hit.number);
      }
    }
    return result;
  }

  async link(item,number) {
    const fresh=await this.getItem(item.number);
    if(fresh.kind!=='pr' || fresh.baseBranch!==fresh.defaultBranch) return {linked:false,reason:'non-default branch'};
    if(['headSha','title','body'].some(key=>fresh[key]!==item[key])) return {linked:false,reason:'PR evidence changed'};
    if(fresh.associations.length) return {linked:true};
    const block=`${LINK_START}\nCloses #${number}\n${LINK_END}`;
    if(fresh.body.includes(block)) return {linked:true};
    if(fresh.body.includes(LINK_START)) return {linked:false,reason:'existing link block'};
    const target=await this.request('GET',`${this.root}/issues/${number}`);
    if(target.pull_request) return {linked:false,reason:'target is not an issue'};
    if(target.state!=='open') return {linked:false,reason:'target is not open'};
    if(this.dryRun) return {linked:false,reason:'dry-run'};
    const body=`${fresh.body}${fresh.body?'\n\n':''}${block}`;
    await this.request('PATCH',`${this.root}/pulls/${item.number}`,{body});
    const verified=await this.getItem(item.number);
    return verified.body===body && (fresh.headSha==null || verified.headSha===fresh.headSha)?{linked:true}:{linked:false,reason:'body verification failed'};
  }

  async queuePage(cursor=null,limit=20) {
    if((cursor!==null && (typeof cursor!=='string' || cursor.length===0)) || !Number.isInteger(limit) || limit<1 || limit>100) throw new Error('Invalid GitHub queue page');
    const data=await this.graphql('query($query:String!,$first:Int!,$after:String) { search(query:$query,type:ISSUE,first:$first,after:$after) {nodes {... on Issue {number} ... on PullRequest {number}} pageInfo {hasNextPage endCursor}} }',{query:`repo:${this.repository} is:open label:triage sort:created-asc`,first:limit,after:cursor});
    const page=data.search;
    if(!Array.isArray(page?.nodes) || page.nodes.length>limit || typeof page.pageInfo?.hasNextPage!=='boolean') throw new Error('Invalid GitHub queue response');
    const seen=new Set();
    for(const node of page.nodes) {
      if(!Number.isSafeInteger(node?.number) || node.number<1 || seen.has(node.number)) throw new Error('Invalid GitHub queue response');
      seen.add(node.number);
    }
    const next=page.pageInfo.endCursor;
    if(page.pageInfo.hasNextPage && (typeof next!=='string' || !next || next===cursor)) throw new Error('Invalid GitHub queue cursor');
    return {items:page.nodes.map(node=>({number:node.number})),nextCursor:page.pageInfo.hasNextPage?next:null};
  }

  async openPage(pageNumber) {
    const rows=await this.request('GET',`${this.root}/issues?state=all&sort=created&direction=asc&per_page=100&page=${pageNumber}`);
    return {items:rows.map(row=>({number:row.number,state:row.state,createdAt:row.created_at})),nextPage:rows.length===100?pageNumber+1:null};
  }

  async apply(item,catalog,changes) {
    const lists={labels:catalog.labels,type:catalog.types,priority:catalog.priority.options,effort:catalog.effort.options};
    for(const [key,value] of Object.entries(changes)) {
      const values=key==='labels'?value:[value];
      if(!lists[key] || !Array.isArray(values) || values.some(v=>v==='triage' || !lists[key].some(x=>x.name===v))) throw new Error('Invalid classification');
    }
    if(this.dryRun) return;
    for(const [key,value] of Object.entries(changes)) {
      if(key==='labels') await this.request('POST',`${this.root}/issues/${item.number}/labels`,{labels:value});
      else if(item.kind==='issue') {
        if(key==='type') await this.request('PATCH',`${this.root}/issues/${item.number}`,{type:value});
        else await this.request('POST',`${this.root}/issues/${item.number}/issue-field-values`,{issue_field_values:[{field_id:catalog[key].id,value}]});
      } else {
        const field=catalog.prFields[key];
        if(field.isIssueField) throw new Error('PR field must be a classic project field');
        const option=field.options.find(x=>x.name===value);
        if(!option) throw new Error('PR field option unavailable');
        const itemId=await this.ensureProject(item,catalog);
        await this.graphql('mutation($input:UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input:$input) { projectV2Item { id } } }',{input:{projectId:catalog.project.id,itemId,fieldId:field.id,value:{singleSelectOptionId:option.id}}});
      }
    }
  }
}

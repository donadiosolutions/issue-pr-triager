import { newState, readState, fingerprint, modelEvidence, validCheckpoint, validQueueCheckpoint } from './state.js';

const fields = ['labels','type','priority','effort'];
function validateDecision(decision, catalog, candidates) {
  if (!decision || !Array.isArray(decision.labels) || !Array.isArray(decision.unresolved) || decision.unresolved.some(x => typeof x !== 'string')) throw new Error('Invalid decision');
  const allow = {labels:catalog.labels.map(x=>x.name),type:catalog.types.map(x=>x.name),priority:catalog.priority.options.map(x=>x.name),effort:catalog.effort.options.map(x=>x.name)};
  if (decision.labels.some(x => x === 'triage' || !allow.labels.includes(x))) throw new Error('Invalid label decision');
  for (const key of fields.slice(1)) if (decision[key] !== null && !allow[key].includes(decision[key])) throw new Error('Invalid field decision');
  const p = decision.parent;
  if (!p || !['none','uncertain','match'].includes(p.status) || typeof p.confidence !== 'number' || (!Number.isFinite(p.confidence) || p.confidence < 0 || p.confidence > 1) || typeof p.margin !== 'number' || (!Number.isFinite(p.margin) || p.margin < 0 || p.margin > 1) || typeof p.fullyResolves !== 'boolean' || (p.number !== null && !candidates.some(x => x.number === p.number))) throw new Error('Invalid parent decision');
  return decision;
}
function recordRemovals(state, item) {
  const pending = state.pending?.field === 'labels' ? state.pending.value : [];
  const missing = state.ownership.labels.filter(label => !item.labels.includes(label) && !pending.includes(label));
  state.removedLabels = [...new Set([...state.removedLabels,...missing])];
}

export async function runEngine(config, {github,classify,now=Date.now,checkpoint=null,saveCheckpoint=async()=>{}}) {
  const result = {processed:0,deferred:0,failed:0,humanReview:0,backfillRemaining:false,checkpoint:null,usage:[],diagnostics:[]};
  const started = now();
  const limit = Math.min(config.batchSize ?? 20,20);
  const deadline = started + (config.deadlineMs ?? 720000);
  const expired = new Error('Deadline reached');
  const check = () => {if (now() >= deadline) throw expired;};
  github.setDeadline?.(deadline);
  const manual = config.eventName === 'workflow_dispatch';
  const restoredQueue = validQueueCheckpoint(checkpoint,config) ? checkpoint : {};
  let cp = validCheckpoint(checkpoint,config,started) ? structuredClone(checkpoint) : {version:1,repository:config.repository,projectNumber:config.projectNumber,active:false};
  cp.queueCursor = restoredQueue.queueCursor ?? null;
  cp.queuePending = [...(restoredQueue.queuePending ?? [])];
  if (config.mode === 'backfill' && manual && !cp.active) Object.assign(cp,{authorizedAt:new Date(started).toISOString(),source:'workflow_dispatch',page:1,offset:0,active:true});
  const save = async () => {
    if (!config.dryRun && now() < deadline) await saveCheckpoint(structuredClone(cp));
  };
  const finish = () => {result.checkpoint=cp;result.backfillRemaining=cp.active;return result;};
  if (now() >= deadline) return finish();
  const bot = config.botLogin ?? await github.identity();
  if (now() >= deadline) return finish();
  let catalog = await github.discover(config.projectNumber,config.priorityFieldName,config.effortFieldName);
  let visited=0;
  const seen = new Set();
  const processItem = async (number,source=null,enrollOnly=false) => {
    let stage='read';
    const phase = async (name,operation) => {stage=name;check();return await operation();};
    visited++;
    try {
      let item = await phase('read',()=>github.getItem(number));
      if (item.state !== 'open') return;
      let entry = readState(item.comments,bot,config);
      const persist = async () => {
        await phase('state',async()=>{if (!config.dryRun) entry.commentId=await github.writeState(number,entry.state,entry.commentId);});
      };
      if (!entry && source) {entry={state:newState(config,source),commentId:null};await persist();}
      if (!entry) return;
      seen.add(number);
      const state=entry.state;
      if (enrollOnly) {
        if (!config.dryRun) {
          await phase('queue',()=>github.setTriage(number,true));
          await phase('project',()=>github.ensureProject(item,catalog));
        }
        result.deferred++;
        return;
      }
      recordRemovals(state,item);
      if (state.pending) {
        const {field,value}=state.pending;
        const current=field==='labels'||item.kind==='issue'?item[field]:item.projectValues[field];
        if (field==='parent') {if(item.associations.includes(value))state.ownership.parent=value;}
        else if(field==='labels')state.ownership.labels=[...new Set([...state.ownership.labels,...value.filter(x=>current.includes(x))])];
        else if(current===value)state.ownership[field]=value;
        state.pending=null;
      }
      const hash=fingerprint(item,catalog,state.ownership,bot,state.removedLabels);
      if (hash!==state.fingerprint) Object.assign(state,{fingerprint:hash,pass:0,phase:'pending',decision:null,unresolved:[]});
      else if (state.phase==='review') {result.humanReview++;return;}
      else if (state.phase==='complete'&&!config.reclassify) {
        if(!config.dryRun&&item.labels.includes('triage'))await phase('queue',()=>github.setTriage(number,false));
        result.processed++;return;
      }
      if (!state.decision&&state.pass>=2) {state.phase='review';await persist();result.humanReview++;return;}
      if (!config.dryRun) {
        await phase('queue',()=>github.setTriage(number,true));
        await phase('project',()=>github.ensureProject(item,catalog));
      }
      if(item.kind==='pr')catalog=await phase('fields',()=>github.syncPrFields(catalog));
      const candidates=item.kind==='pr'?await phase('candidates',()=>github.candidates(item)):[];
      if(!state.decision) {
        state.pass++;state.attempts++;state.phase='pending';state.unresolved=['model pending'];
        await persist();
        try {
          state.decision=validateDecision(await phase('classify',()=>classify({item:modelEvidence(item,bot),catalog,candidates,stage:state.pass,deadline})),catalog,candidates);
          if(Array.isArray(state.decision.usage))result.usage.push(...state.decision.usage);
          state.unresolved=[...state.decision.unresolved];
        } catch (error) {
          if(error===expired)throw error;
          state.decision=null;state.unresolved=['classification unavailable or invalid'];state.phase=state.pass===2?'review':'pending';
          await persist();result[state.pass===2?'humanReview':'deferred']++;return;
        }
        await persist();
      }
      const decision=validateDecision(state.decision,catalog,candidates);
      const fresh=async()=>{
        item=await phase('refresh',()=>github.getItem(number));
        catalog=await phase('catalog',()=>github.discover(config.projectNumber,config.priorityFieldName,config.effortFieldName));
        if(item.kind==='pr')catalog=await phase('fields',()=>github.syncPrFields(catalog));
        if(!config.dryRun)recordRemovals(state,item);
        return item.state==='open'&&fingerprint(item,catalog,state.ownership,bot,state.removedLabels)===hash;
      };
      const defer=async()=>{state.decision=null;state.pending=null;state.unresolved=['evidence or catalog changed'];await persist();result.deferred++;};
      if(!await fresh()){await defer();return;}
      for(const field of fields) {
        if(!await fresh()){await defer();return;}
        const current=field==='labels'||item.kind==='issue'?item[field]:item.projectValues[field];
        const value=decision[field];
        let change;
        if(field==='labels') {
          change=[...new Set(value.filter(x=>!current.includes(x)&&!state.removedLabels.includes(x)))];
          if(!change.length)continue;
          state.pending={field,value:change};
        } else {
          if(value===null||value===current||(current&&!(config.reclassify&&state.ownership[field]===current)))continue;
          change=value;state.pending={field,value};
        }
        await persist();
        if(!config.dryRun)await phase('apply',()=>github.apply(item,catalog,{[field]:change}));
        if(field==='labels')state.ownership.labels=[...new Set([...state.ownership.labels,...state.pending.value])];
        else state.ownership[field]=value;
        state.pending=null;await persist();
      }
      const unresolved=[...state.unresolved];
      const parent=decision.parent;
      if(item.kind==='pr'&&!item.associations.length) {
        if(parent.status==='uncertain'||candidates.truncated||item.truncated)unresolved.push('parent evidence incomplete');
        else if(parent.status==='match') {
          const valid=candidates.filter(x=>x.number===parent.number&&x.state==='open').length===1&&parent.confidence>=.95&&parent.margin>=.15&&parent.fullyResolves&&item.baseBranch===item.defaultBranch;
          if(!valid)unresolved.push('parent requires human review');
          else if(!config.dryRun) {
            state.pending={field:'parent',value:parent.number};await persist();
            const linked=await phase('link',()=>github.link(item,parent.number));
            if(!linked.linked)unresolved.push('parent link deferred');else state.ownership.parent=parent.number;
            state.pending=null;await persist();
          }
        }
      }
      state.unresolved=[...new Set(unresolved)];state.pending=null;state.decision=null;
      state.phase=state.unresolved.length?(state.pass===2?'review':'pending'):'complete';
      await persist();
      if(state.phase==='complete') {
        if(!config.dryRun)await phase('queue',()=>github.setTriage(number,false));
        result.processed++;
      } else result[state.phase==='review'?'humanReview':'deferred']++;
    } catch(error) {
      if(error===expired){result.deferred++;result.diagnostics.push({number,stage,reason:'Deadline reached'});}
      else {result.failed++;result.diagnostics.push({number,stage,reason:'Operation failed'});}
    }
  };
  const event=config.event;
  const eventNumber=event.issue?.number??event.pull_request?.number;
  const eventTarget=['issues','pull_request_target'].includes(config.eventName)&&['opened','edited','reopened','synchronize','labeled'].includes(event.action)&&Number.isInteger(eventNumber)&&eventNumber>0;
  const selected=manual&&Number.isInteger(config.itemNumber)&&config.itemNumber>0;
  if(config.mode==='enroll') {
    if(eventTarget&&event.action==='opened'&&now()<deadline)await processItem(eventNumber,'creation',true);
    return finish();
  }
  if((selected||eventTarget)&&now()<deadline)await processItem(selected?config.itemNumber:eventNumber,selected?'manual':null);
  if(!selected&&!eventTarget&&now()<deadline) {
    const budget=cp.active?Math.floor((limit-visited)/2):limit-visited;
    let remaining=budget;
    const hadPending=cp.queuePending.length>0;
    while(cp.queuePending.length&&remaining>0&&now()<deadline) {
      const number=cp.queuePending.shift();remaining--;await processItem(number);await save();
    }
    if(remaining>0&&now()<deadline&&(!hadPending||cp.queueCursor!==null)) {
      const page=await github.queuePage(cp.queueCursor,remaining);
      cp.queueCursor=page.nextCursor;cp.queuePending=page.items.map(x=>x.number);await save();
      while(cp.queuePending.length&&remaining>0&&now()<deadline) {
        const number=cp.queuePending.shift();remaining--;await processItem(number);await save();
      }
    }
  }
  if(cp.active) {
    await save();let pages=0;
    while(cp.active&&visited<limit&&now()<deadline&&pages<20) {
      const page=await github.openPage(cp.page);pages++;
      while(cp.offset<page.items.length&&visited<limit&&now()<deadline) {
        const item=page.items[cp.offset];
        if(item.state==='open'&&Date.parse(item.createdAt)<=Date.parse(cp.authorizedAt)&&!seen.has(item.number))await processItem(item.number,'manual');
        cp.offset++;await save();
      }
      if(cp.offset<page.items.length)break;
      if(page.nextPage===null)cp.active=false;else {cp.page=page.nextPage;cp.offset=0;}
      await save();
    }
  }
  return finish();
}

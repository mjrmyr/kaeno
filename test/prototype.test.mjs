import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createService } from '../src/service.ts';
import { Ledger } from '../src/ledger.ts';
import { sandboxPolicy } from '../src/sandbox.ts';
const root = resolve(import.meta.dirname, '..');
const wait = async (fn) => {
  for (let attempt=0;attempt<90;attempt++) {
    const value = await fn(); if (value) return value;
    await new Promise(done => setTimeout(done,90));
  }
  throw new Error('Timed out waiting for worker');
};

test('authenticated multi-client API persists an isolated Pi Durable assignment across reconnect and restart', async () => {
  const dir = await mkdtemp(join(tmpdir(),'kaeno-next-test-'));
  let service;
  try {
    service = await createService({dir,port:0,mode:'faux'});
    const token = (await readFile(service.tokenFile,'utf8')).trim();
    const call = async (path, method='GET', value, bearer=token) => {
      const response=await fetch(service.url+path,{method,headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},body:value?JSON.stringify(value):undefined});
      return [response.status,await response.json()];
    };
    assert.equal((await call('/api/agents','GET',undefined,'invalid'))[0],401);
    assert.equal((await call('/api/agents'))[1].length,2);
    const input={requestId:'same-request-0001',agent:'researcher',objective:'read note.txt'};
    const [status,first]=await call('/api/assignments','POST',input);
    assert.equal(status,202);
    await mkdir(join(dir,'cells',first.id,'workspace'),{recursive:true});
    await writeFile(join(dir,'cells',first.id,'workspace','note.txt'),'evidence from private workspace');
    assert.equal((await call('/api/assignments','POST',input))[1].id,first.id);
    assert.equal((await call('/api/assignments','POST',{...input,objective:'changed'}))[0],400);
    const otherClient=async()=> (await call('/api/assignments/'+first.id))[1];
    const finished=await wait(async()=>{const job=await otherClient();return ['completed','blocked'].includes(job.state)?job:null});
    assert.equal(finished.state,'completed',JSON.stringify(finished));
    assert.match(finished.result,/evidence from private workspace/);
    const events=(await call('/api/events?after=0'))[1];
    assert.deepEqual(events.map(e=>e.kind),['queued','starting','running','completed']);
    assert.equal((await call('/api/events?after='+events.at(-1).seq))[1].length,0);
    await service.close(); service=undefined;
    service=await createService({dir,port:0,mode:'faux'});
    const again=await fetch(service.url+'/api/assignments/'+first.id,{headers:{Authorization:`Bearer ${token}`}});
    assert.equal((await again.json()).result,finished.result);
  } finally { await service?.close(); await rm(dir,{recursive:true,force:true}); }
});

test('durably queued steering reaches the same Pi conversation and dedupes retries', async () => {
  const dir=await mkdtemp(join(tmpdir(),'kaeno-steer-test-'));
  const service=await createService({dir,port:0,mode:'faux'});
  try {
    const token=(await readFile(service.tokenFile,'utf8')).trim();
    const api=async (path,method='GET',body) => {
      const response=await fetch(service.url+path,{method,headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
      return [response.status,await response.json()];
    };
    const job=(await api('/api/assignments','POST',{requestId:'steer-job-001',agent:'planner',objective:'SLOW_TEST: prepare first pass'}))[1];
    await wait(async()=> (await api('/api/assignments/'+job.id))[1].state==='running');
    const steering={requestId:'steer-request-001',text:'Focus on budget'};
    assert.equal((await api(`/api/assignments/${job.id}/steer`,'POST',steering))[0],202);
    assert.equal((await api(`/api/assignments/${job.id}/steer`,'POST',steering))[0],202);
    assert.equal((await api(`/api/assignments/${job.id}/steer`,'POST',{...steering,text:'changed'}))[0],400);
    const finished=await wait(async()=>{const j=(await api('/api/assignments/'+job.id))[1];return ['completed','blocked'].includes(j.state)?j:null});
    assert.equal(finished.state,'completed',JSON.stringify(finished));
    assert.match(finished.result,/Supervisor steering: Focus on budget/);
    assert.equal((finished.result.match(/Supervisor steering: Focus on budget/g)??[]).length,1);
  } finally {await service.close();await rm(dir,{recursive:true,force:true});}
});

test('interrupted running worker stays blocked after service restart; no duplicate dispatch', async () => {
  const dir=await mkdtemp(join(tmpdir(),'kaeno-restart-test-'));
  let service;
  try {
    service=await createService({dir,port:0,mode:'faux'});
    const token=(await readFile(service.tokenFile,'utf8')).trim();
    const post=await fetch(service.url+'/api/assignments',{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({requestId:'slow-request-001',agent:'planner',objective:'SLOW_TEST: first turn'})});
    const job=await post.json();
    await wait(async()=>{const response=await fetch(service.url+'/api/assignments/'+job.id,{headers:{Authorization:`Bearer ${token}`}});return (await response.json()).state==='running'});
    await service.close(); service=undefined;
    service=await createService({dir,port:0,mode:'faux'});
    const read=await fetch(service.url+'/api/assignments/'+job.id,{headers:{Authorization:`Bearer ${token}`}});
    assert.equal((await read.json()).state,'blocked');
    const events=await (await fetch(service.url+'/api/events?after=0',{headers:{Authorization:`Bearer ${token}`}})).json();
    assert.deepEqual(events.map(e=>e.kind),['queued','starting','running','blocked']);
  } finally {await service?.close(); await rm(dir,{recursive:true,force:true});}
});

test('ledger pins agent revision, dedupes commands and blocks uncertain running work on restart', async () => {
  const dir=await mkdtemp(join(tmpdir(),'kaeno-ledger-'));
  try {
    const file=join(dir,'ledger.sqlite');
    const agent={name:'planner',instructions:'Plan',skills:[],knowledge:[],tools:[]};
    const db=new Ledger(file);
    const job=db.accept('request-0001',agent,'Plan work');
    db.transition(job.id,'starting','preparing worker');
    db.transition(job.id,'running','worker started');
    assert.equal(db.command(job.id,'steer-0001','Consider cost'),true);
    assert.equal(db.command(job.id,'steer-0001','Consider cost'),false);
    assert.throws(()=>db.command(job.id,'steer-0001','Different'),/reused/);
    assert.equal(db.commands(job.id).length,1);
    db.close();
    const restarted=new Ledger(file);
    assert.equal(restarted.accept('request-0001',{...agent,instructions:'Changed'},'Plan work').revision,job.revision);
    assert.equal(restarted.get(job.id).state,'running');
    restarted.transition(job.id,'blocked','Exclusive worker shutdown not proven');
    assert.equal(restarted.get(job.id).state,'blocked');
    assert.equal(restarted.command(job.id,'steer-0001','Consider cost'),false);
    restarted.close();
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('macOS worker policy denies a sibling home file and permits its own cell', {skip:process.platform!=='darwin'}, async () => {
  const secret=join(root,`.sandbox-fixture-${randomUUID()}`);
  const cell=await mkdtemp(join(tmpdir(),'kaeno-sandbox-cell-'));
  try {
    await writeFile(secret,'private fixture');
    await writeFile(join(cell,'allowed.txt'),'cell fixture');
    const profile=await sandboxPolicy(cell,'faux');
    const run=path=>spawnSync('/usr/bin/sandbox-exec',['-p',profile,process.execPath,'-e',`process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(path)},'utf8'))`],{encoding:'utf8'});
    assert.notEqual(run(secret).status,0);
    assert.doesNotMatch(run(secret).stdout,/private fixture/);
    const own=run(join(cell,'allowed.txt'));
    assert.equal(own.status,0,own.stderr);
    assert.equal(own.stdout,'cell fixture');
    const write=spawnSync('/usr/bin/sandbox-exec',['-p',profile,process.execPath,'-e',`require('node:fs').appendFileSync(${JSON.stringify(secret)},'intrusion')`],{encoding:'utf8'});
    assert.notEqual(write.status,0);
    assert.equal(await readFile(secret,'utf8'),'private fixture');
  } finally { await rm(secret,{force:true}); await rm(cell,{recursive:true,force:true}); }
});

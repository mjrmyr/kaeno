import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { openContact } from '../src/contact.ts';
import { loadKey, saveKey } from '../src/credentials.ts';

const wait = async (check) => {
  for (let i = 0; i < 120; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for committed state');
};
const testCatalog = (secretPath, workerGate) => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const text = (content) => typeof content === 'string' ? content : content?.filter(p => p.type === 'text').map(p => p.text).join('') || '';
  const route = (request) => {
    const last = request.messages.findLast(m => m.role !== 'system');
    const body = text(last?.content);
    if (last?.role === 'toolResult') return fauxAssistantMessage(body.includes('Read refused:') ? 'Private state access was refused.' : `Job admitted: ${body}`);
    if (body.includes('delegate-test') || body.includes('delegate-private')) return fauxAssistantMessage([
      fauxToolCall('delegate', { agent: 'reader', objective: body.includes('delegate-private') ? 'Read protected state' : 'Summarize the test objective', brief: 'Find a concise answer' })
    ], { stopReason: 'toolUse' });
    if (body.startsWith('Objective: Read protected state') && secretPath) return fauxAssistantMessage([
      fauxToolCall('read', { path: secretPath })
    ], { stopReason: 'toolUse' });
    if (body.startsWith('Objective: ') && workerGate) return workerGate.then(() => fauxAssistantMessage('Finding after cancellation'));
    if (body.startsWith('Objective: ')) return fauxAssistantMessage('Finding: verified source');
    if (body.startsWith('[Specialist ')) return fauxAssistantMessage('Specialist finding received.');
    return fauxAssistantMessage(`Reply: ${body}`);
  };
  faux.setResponses(Array.from({ length: 100 }, () => route));
  return { models, model: { provider: 'faux', modelId: 'faux-1' } };
};

test('one Durable contact: dedup, native background job, result card and restart', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kaeno-tui-'));
  const testing = testCatalog();
  try {
    let contact = await openContact({ stateDir, testing });
    const id = 'cb42d81b-3cf6-42e5-9ba0-abd4cd1f0052';
    try {
      await assert.rejects(openContact({ stateDir, testing }), /Another Kaeno instance/);
      const first = await contact.send('delegate-test', id);
      assert.equal(await contact.send('delegate-test', id), first);
      const state = await wait(async () => {
        const state = await contact.state();
        return state.jobs[0]?.result?.type === 'completed' && state.jobs[0].notice ? state : null;
      });
      assert.equal(state.jobs.length, 1);
      assert.match(state.jobs[0].result.text, /verified source/);
      assert.ok(state.messages.some(m => m.role === 'job' && m.text.includes('Specialist reader')));
      const another = await contact.send('while working', 'another');
      assert.ok(another);
      await wait(async () => (await contact.state()).messages.some(m => m.text.includes('Reply: while working')));
    } finally { await contact.close(); }
    contact = await openContact({ stateDir, testing });
    try {
      const state = await contact.state();
      assert.equal(state.jobs.length, 1);
      assert.equal(state.jobs[0].result.type, 'completed');
      assert.equal(state.jobs[0].nativeStatus, 'terminal');
      assert.ok(state.messages.some(({ text }) => text === 'delegate-test'));
      await assert.rejects(contact.send('', 'new-id'), /Message must be/);
      await assert.rejects(contact.cancelJob(999999), /Unknown job/);
    } finally { await contact.close(); }
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('aborting a contact answer surfaces its unanswered input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kaeno-abort-'));
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 1 });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('This is a deliberately long answer that will be stopped before completion.')]);
  const contact = await openContact({ stateDir: dir, testing: { models, model: { provider: 'faux', modelId: 'faux-1' } } });
  try {
    await contact.send('hello', 'aborted-input');
    await wait(async () => (await contact.state()).busy);
    await contact.cancelContact();
    const state = await wait(async () => { const state = await contact.state(); return state.error ? state : null; });
    assert.match(state.error, /unanswered: aborted/);
  } finally { await contact.close(); await rm(dir, { recursive: true, force: true }); }
});

test('contact stays responsive during a background job; cancelling retains a card', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kaeno-cancel-'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const contact = await openContact({ stateDir: dir, testing: testCatalog(undefined, gate) });
  try {
    await contact.send('delegate-test', 'cancel-delegation');
    const job = await wait(async () => (await contact.state()).jobs[0]);
    await contact.send('while working', 'parallel-question');
    await wait(async () => (await contact.state()).messages.some(m => m.text === 'Reply: while working'));
    const cancelled = contact.cancelJob(job.id);
    release();
    await cancelled;
    const card = await wait(async () => (await contact.state()).jobs[0]?.result);
    assert.ok(['cancelled', 'outcome_unknown'].includes(card.type));
    assert.equal((await contact.state()).jobs[0].nativeStatus, 'terminal');
  } finally { release(); await contact.close(); await rm(dir, { recursive: true, force: true }); }
});

test('specialist read tool refuses private Kaeno state even when asked for the key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kaeno-private-'));
  const secretPath = join(dir, 'credentials.json');
  try {
    await saveKey(dir, 'sk-private-key-not-real');
    await mkdir(join(dir, 'agents'));
    await writeFile(join(dir, 'agents', 'reader.json'), JSON.stringify({
      name: 'reader', description: 'Test protected read', instructions: 'Read only.',
      modelId: 'faux-1', workspace: dirname(dir), tools: ['read']
    }));
    const contact = await openContact({ stateDir: dir, testing: testCatalog(secretPath) });
    try {
      await contact.send('delegate-private', 'private');
      const card = await wait(async () => (await contact.state()).jobs[0]?.result);
      assert.equal(card.type, 'completed');
      assert.match(card.text, /Private state access was refused/);
      assert.doesNotMatch(card.text, /sk-private-key/);
    } finally { await contact.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('configured key is private on disk and replaceable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kaeno-key-'));
  try {
    assert.equal(await loadKey(dir), undefined);
    await assert.rejects(saveKey(dir, 'invalid'), /OpenAI API key/);
    await saveKey(dir, 'sk-test-key-not-a-real-key');
    assert.equal(await loadKey(dir), 'sk-test-key-not-a-real-key');
    assert.equal((await stat(join(dir, 'credentials.json'))).mode & 0o077, 0);
    await saveKey(dir, 'sk-replaced-not-a-real-key');
    assert.equal(await loadKey(dir), 'sk-replaced-not-a-real-key');
    assert.equal(JSON.parse(await readFile(join(dir, 'credentials.json'), 'utf8')).openai, 'sk-replaced-not-a-real-key');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('TUI requires an interactive terminal', () => {
  const entry = fileURLToPath(new URL('../src/tui.ts', import.meta.url));
  const run = spawnSync(process.execPath, ['--experimental-strip-types', entry], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /interactive terminal/);
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT, awaitWithContext } from '@earendil-works/chord/context';
import { createModels, Type } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTask, defineTool, defineDoc } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

// Native primitive probes, NOT a Kaeno implementation or exhaustive crash tests.
const ctx = BACKGROUND_CONTEXT;
const model = { provider: 'faux', modelId: 'faux-1' };
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'probe condition timed out');
    await new Promise(r => setTimeout(r, 5));
  }
}
const Jobs = defineDoc({
  kind: 'probe.jobs', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ byOrigin: {} }),
});
function setup({ gate, interrupt = false }) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('delegate', { objective: 'review module' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Delegated.'),
    fauxAssistantMessage('Still present.'),
  ]);
  let executions = 0;
  let shouldInterrupt = interrupt;
  const Job = defineTask({
    name: 'probe.job', version: 1, initial: () => ({ phase: 'work' }),
    phases: {
      work: async (_task, runtime, context) => {
        await awaitWithContext(gate.promise, context);
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: 'done' } }), context);
      },
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });
  const delegate = defineTool({
    name: 'delegate', description: 'Create a background probe job.',
    parameters: Type.Object({ objective: Type.String() }), replay: 'safe',
    execute: async (args, api, context) => {
      executions++;
      const receipt = await api.commit(async tx => {
        const state = await tx.doc(Jobs, api.conversationId);
        const existing = state.byOrigin[api.taskId];
        if (existing) {
          assert.equal(existing.objective, args.objective);
          return existing;
        }
        const jobId = await tx.createTask(Job, null, { ownership: { kind: 'conversation' }, background: true });
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: jobId } });
        const created = { jobId, childId: child.id, objective: args.objective };
        state.byOrigin[api.taskId] = created;
        return created;
      }, context);
      if (shouldInterrupt) {
        shouldInterrupt = false;
        await awaitWithContext(new Promise(() => {}), context);
      }
      return { content: [{ type: 'text', text: `Job ${receipt.jobId} admitted.` }] };
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'probe', tools: [delegate], tasks: [Job] }));
  return { models, registry, executions: () => executions };
}

test('background ownership permits contact answer and normal abort leaves job alive', async () => {
  const gate = deferred();
  const config = setup({ gate });
  const harness = await Harness.open(new MemoryStorage(), config, ctx);
  try {
    const root = await harness.root(ctx, { agent: { model } });
    const first = await (await root.submit({ type: 'input', content: 'delegate', requestId: 'first' }, ctx)).wait(ctx);
    assert.equal(first.status, 'done');
    const records = (await harness.snapshot(Jobs, root.id, ctx)).byOrigin;
    const [receipt] = Object.values(records);
    assert.equal(Object.keys(records).length, 1);
    assert.notEqual((await harness.getTask(receipt.jobId, ctx)).state.status, 'terminal');
    const next = await (await root.submit({ type: 'input', content: 'while working', requestId: 'next' }, ctx)).wait(ctx);
    assert.equal(next.status, 'done');
    await root.abort(ctx);
    assert.equal((await harness.getTask(receipt.jobId, ctx)).abortRequested, false);
    gate.resolve();
    assert.equal((await harness.waitForTask(receipt.jobId, ctx)).state.outcome.status, 'completed');
  } finally {
    await harness.close(ctx);
  }
});

test('safe creation-only delegate reexecutes after close before tool result without duplicate job', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kaeno-native-probe-'));
  const path = join(directory, 'state.sqlite');
  const gate = deferred();
  const config = setup({ gate, interrupt: true });
  const open = () => openNodeSqliteStorage(path).then(storage => Harness.open(storage, config, ctx));
  let harness = await open();
  try {
    let root = await harness.root(ctx, { agent: { model } });
    const accepted = await root.submit({ type: 'input', content: 'delegate', requestId: 'original' }, ctx);
    await until(async () => Object.keys((await harness.snapshot(Jobs, root.id, ctx))?.byOrigin ?? {}).length === 1);
    const [before] = Object.values((await harness.snapshot(Jobs, root.id, ctx)).byOrigin);
    await harness.close(ctx);
    harness = await open();
    root = await harness.root(ctx);
    gate.resolve();
    const settled = await (await harness.submission(accepted.id, ctx)).wait(ctx);
    assert.equal(settled.status, 'done');
    assert.equal(config.executions(), 2);
    const records = Object.values((await harness.snapshot(Jobs, root.id, ctx)).byOrigin);
    assert.deepEqual(records, [before]);
    assert.equal((await harness.waitForTask(before.jobId, ctx)).state.outcome.status, 'completed');
  } finally {
    await harness.close(ctx);
    await rm(directory, { recursive: true, force: true });
  }
});

test('completing background owner remains live until ordinary child work drains', async () => {
  const gate = deferred();
  const Worker = defineTask({
    name: 'probe.drain-worker', version: 1, initial: () => ({ phase: 'wait' }),
    phases: {
      wait: async (_task, runtime, context) => {
        await awaitWithContext(gate.promise, context);
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context);
      },
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });
  const Owner = defineTask({
    name: 'probe.drain-owner', version: 1, initial: () => ({ phase: 'finish' }),
    phases: {
      finish: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context),
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'probe-drain', tasks: [Owner, Worker] }));
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, ctx);
  try {
    const root = await harness.root(ctx);
    const ownerId = await root.commit(async tx => {
      const id = await tx.createTask(Owner, null, { ownership: { kind: 'conversation' }, background: true });
      await tx.createTask(Worker, null, { ownership: { kind: 'task', taskId: id } });
      return id;
    }, ctx);
    harness.resume();
    await until(async () => (await harness.getTask(ownerId, ctx)).state.status === 'completing');
    // A decided outcome is not terminal and must not release an admission slot.
    assert.notEqual((await harness.getTask(ownerId, ctx)).state.status, 'terminal');
    gate.resolve();
    assert.equal((await harness.waitForTask(ownerId, ctx)).state.status, 'terminal');
  } finally {
    await harness.close(ctx);
  }
});

test('table read after task creation rejects and atomically rolls back that commit', async () => {
  const Done = defineTask({
    name: 'probe.order', version: 1, initial: () => ({ phase: 'done' }),
    phases: { done: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context) },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'probe-order', tasks: [Done] }));
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, ctx);
  try {
    const root = await harness.root(ctx);
    await assert.rejects(root.commit(async tx => {
      await tx.createTask(Done, null, { ownership: { kind: 'conversation' } });
      await tx.scanTasks({ conversationId: root.id }, 10);
    }, ctx), { name: 'ReadAfterWrite' });
    const tasks = await root.commit(tx => tx.scanTasks({ conversationId: root.id }, 10), ctx);
    assert.equal(tasks.items.length, 0);
  } finally {
    await harness.close(ctx);
  }
});

test('withdrawn follow-up remains aborted under same ID, even when supplied content changes', async () => {
  const faux = fauxProvider({ tokensPerSecond: 1 });
  faux.setResponses([fauxAssistantMessage('A deliberately long answer that will be interrupted.')]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, ctx);
  try {
    const root = await harness.root(ctx, { agent: { model } });
    await root.submit({ type: 'input', content: 'busy', requestId: 'user' }, ctx);
    const report = await root.submit({ type: 'input', content: 'completion', requestId: 'notice-1', whenBusy: 'followUp' }, ctx);
    assert.equal((await report.status(ctx)).status, 'queued');
    await root.abort(ctx);
    assert.equal((await report.status(ctx)).status, 'unanswered');
    assert.equal((await report.status(ctx)).reason, 'aborted');
    const replay = await root.submit({ type: 'input', content: 'different completion', requestId: 'notice-1' }, ctx);
    assert.equal(replay.id, report.id);
    assert.equal((await replay.status(ctx)).reason, 'aborted');
  } finally {
    await harness.close(ctx);
  }
});

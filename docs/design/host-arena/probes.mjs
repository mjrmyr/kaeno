import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT, awaitWithContext } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { Harness, MemoryStorage, createRegistry, defineDoc, defineExtension, defineTask } from '@earendil-works/pi-durable';

// Native boundary probes only. No Kaeno frontend, remote executor or Kubernetes implementation.
const context = BACKGROUND_CONTEXT;
const Reservation = defineDoc({
  kind: 'probe.external-reservation', version: 1, scope: 'conversation',
  history: 'latest', fork: 'initial', initial: () => ({ held: true }),
});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'condition timed out');
    await new Promise(done => setTimeout(done, 5));
  }
}
async function open(tasks = []) {
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'probe-host-boundary', tasks }));
  return Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
}

test('terminal coordinator task does not drain another Harness; external reservation survives', async () => {
  const gate = deferred();
  const Worker = defineTask({
    name: 'probe.foreign-worker', version: 1, initial: () => ({ phase: 'work' }),
    phases: {
      work: async (_task, runtime, ctx) => {
        await awaitWithContext(gate.promise, ctx);
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx);
      },
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  });
  const Parent = defineTask({
    name: 'probe.foreign-parent', version: 1, initial: () => ({ phase: 'fault' }),
    phases: { fault: async () => { throw new Error('coordinator invocation fault'); } },
  });
  const coordinator = await open([Parent]);
  const worker = await open([Worker]);
  try {
    const workerRoot = await worker.root(context);
    const workerId = await workerRoot.commit(tx => tx.createTask(Worker, null, { ownership: { kind: 'conversation' } }), context);
    worker.resume();
    await until(async () => (await worker.getTask(workerId, context)).state.status === 'running');
    const root = await coordinator.root(context);
    const parentId = await root.commit(async tx => {
      await tx.doc(Reservation, root.id);
      return tx.createTask(Parent, { workerId }, { ownership: { kind: 'conversation' }, background: true });
    }, context);
    coordinator.resume();
    const parent = await coordinator.waitForTask(parentId, context);
    assert.equal(parent.state.outcome.status, 'faulted');
    assert.equal((await worker.getTask(workerId, context)).state.status, 'running');
    assert.equal((await coordinator.snapshot(Reservation, root.id, context)).held, true);
    // Native liveness alone would falsely release the slot; this tests why an external reservation is necessary.
    gate.resolve();
    await worker.waitForTask(workerId, context);
  } finally {
    gate.resolve();
    await coordinator.close(context);
    await worker.close(context);
  }
});

test('builtin conversation view omits app docs; commit subscription sees job-only changes', async () => {
  const harness = await open();
  let unsubscribe;
  let view;
  try {
    const root = await harness.root(context);
    await root.commit(tx => tx.doc(Reservation, root.id), context);
    view = await root.viewState(context);
    let publications = 0;
    unsubscribe = harness.subscribeCommits(() => { publications++; });
    await root.commit(async tx => { (await tx.doc(Reservation, root.id)).held = false; }, context);
    assert.equal((await harness.snapshot(Reservation, root.id, context)).held, false);
    assert.equal(view.value.docs['probe.external-reservation'], undefined);
    assert.ok(publications > 0);
  } finally {
    unsubscribe?.();
    view?.dispose();
    await harness.close(context);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createJobExtension, jobCards, loadProfiles } from '../src/jobs.ts';

const output = (result) => result.content.map(part => part.text).join('\n');

test('reader lists a folder then reads files, but explains denied/missing paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kaeno-reader-paths-'));
  const workspace = join(dir, 'approved');
  const stateDir = join(workspace, '.kaeno');
  const notes = join(workspace, 'notes');
  const outside = join(dir, 'outside');
  try {
    await mkdir(join(stateDir, 'agents'), { recursive: true });
    await mkdir(notes);
    await mkdir(outside);
    await writeFile(join(notes, 'yesterday.md'), 'worked on Kaeno\n');
    await writeFile(join(outside, 'private.md'), 'not approved\n');
    await writeFile(join(stateDir, 'credentials.json'), '{"openai":"sk-never-expose-this-key"}\n');
    await writeFile(join(stateDir, 'agents', 'reader.json'), JSON.stringify({
      name: 'reader', description: 'Browse notes', modelId: 'faux-1',
      workspace, tools: ['read'], instructions: 'Read only.'
    }));
    const profiles = await loadProfiles(join(stateDir, 'agents'), 'faux-1');
    const { JobExtension, ReadExtension } = createJobExtension(profiles, 'faux', await realpath(stateDir));
    const read = ReadExtension.tools.find(tool => tool.name === 'read');
    const list = ReadExtension.tools.find(tool => tool.name === 'list');
    assert.ok(read && list, 'read capability must also provide directory discovery');
    const api = { agent: async () => ({ cwd: workspace }), env: new NodeExecutionEnv({ cwd: workspace }) };
    const call = (tool, path) => tool.execute({ path }, api, BACKGROUND_CONTEXT);

    assert.match(output(await call(list, 'notes')), /yesterday\.md/);
    assert.match(output(await call(read, 'notes\/yesterday.md')), /worked on Kaeno/);
    assert.match(output(await call(read, 'notes')), /directory.*Use list/);
    assert.match(output(await call(list, '.')), /notes\//);
    assert.doesNotMatch(output(await call(list, '.')), /\.kaeno/);

    const denied = await call(list, '../outside');
    assert.equal(denied.isError, true);
    assert.match(output(denied), /outside the reader workspace.*change \.kaeno\/agents\/reader\.json workspace/);
    assert.equal((await call(read, '../outside/private.md')).isError, true);
    const home = await call(list, '~/docs/daily');
    assert.equal(home.isError, true);
    assert.match(output(home), /outside the reader workspace/); // ~ expands, but never bypasses approval.
    const missing = await call(read, 'notes/not-here.md');
    assert.equal(missing.isError, true);
    assert.match(output(missing), /Path not found: .*Relative paths start in/);
    assert.match(output(await call(read, '.kaeno/credentials.json')), /Private Kaeno state cannot be read/);
    assert.match(output(await call(list, '.kaeno')), /Private Kaeno state cannot be read/);

    // Exercise tool selection in a real native child conversation, not just the wrapper.
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const content = (message) => typeof message?.content === 'string' ? message.content
      : message?.content?.filter(part => part.type === 'text').map(part => part.text).join('') ?? '';
    const route = (request) => {
      const last = request.messages.findLast(message => message.role !== 'system');
      const text = content(last);
      if (last?.role === 'toolResult' && text.includes('worked on Kaeno')) return fauxAssistantMessage('Yesterday: worked on Kaeno.');
      if (last?.role === 'toolResult' && text.includes('yesterday.md'))
        return fauxAssistantMessage([fauxToolCall('read', { path: 'notes/yesterday.md' })], { stopReason: 'toolUse' });
      if (last?.role === 'user' && text.startsWith('Objective: '))
        return fauxAssistantMessage([fauxToolCall('list', { path: 'notes' })], { stopReason: 'toolUse' });
      if (last?.role === 'user' && text === 'please delegate')
        return fauxAssistantMessage([fauxToolCall('delegate', { agent: 'reader', objective: 'Summarize yesterday', brief: 'Read notes' })], { stopReason: 'toolUse' });
      return fauxAssistantMessage('Acknowledged.');
    };
    faux.setResponses(Array.from({ length: 30 }, () => route));
    const registry = createRegistry();
    registry.install(JobExtension);
    registry.install(ReadExtension);
    const harness = await Harness.open(new MemoryStorage(), {
      models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace }),
    }, BACKGROUND_CONTEXT);
    try {
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: 'faux', modelId: 'faux-1' }, extensions: [JobExtension] },
      });
      await (await root.submit({ type: 'input', content: 'please delegate', requestId: 'delegate-notes' }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
      let card;
      for (let attempt = 0; attempt < 100; attempt++) {
        card = (await jobCards(harness, root.id, BACKGROUND_CONTEXT))[0];
        if (card?.result) break;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      assert.equal(card?.result?.type, 'completed');
      assert.match(card.result.text, /Yesterday: worked on Kaeno/);
    } finally { await harness.close(BACKGROUND_CONTEXT); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

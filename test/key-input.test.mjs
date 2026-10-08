import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyInput } from '../src/key-input.ts';

test('key entry accepts bracketed Cmd+V paste without submitting or losing characters', () => {
  const submitted = [];
  const input = new KeyInput((key) => submitted.push(key));
  input.focused = true;
  const key = 'sk-pasted-token-123456789';
  input.handleInput('\x1b[200~sk-pasted-');
  input.handleInput('token-123456789\n\x1b[201~');
  assert.equal(input.getValue(), key);
  assert.deepEqual(submitted, []);
  assert.ok(input.render(80)[0].includes(key));
  input.handleInput('\x12'); // Ctrl+R hides it, without changing the value.
  assert.doesNotMatch(input.render(80)[0], /sk-pasted/);
  input.handleInput('\x12');
  assert.ok(input.render(80)[0].includes(key));
  input.handleInput('\r');
  assert.deepEqual(submitted, [key]);
  input.clear();
  assert.equal(input.getValue(), '');
});

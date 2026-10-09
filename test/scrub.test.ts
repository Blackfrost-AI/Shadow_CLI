import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubControlTokens, scrubForDisplay } from '../src/util/scrub.js';

test('preserves leading reasoning tags because only the provider knows if they are structural', () => {
  for (const text of [
    '</think>demo',
    '</think>  `log.txt` has 4 lines.',
    ' \n</mm:think ></thinking>\nThe result.',
    '<think>demo</think>',
  ]) assert.equal(scrubControlTokens(text), text);
  assert.equal(scrubControlTokens('<|im_start|></think>  The result.'), '</think>  The result.');
});

test('strips channel / tool_call / tool_response tokens (gemma4-opus, ChatML)', () => {
  assert.equal(scrubControlTokens('done<channel|>'), 'done');
  assert.equal(scrubControlTokens('a<tool_call|>b'), 'ab');
  assert.equal(scrubControlTokens('<|tool_response>result'), 'result');
  assert.equal(scrubControlTokens('<|im_start|>assistant<|im_end|>'), 'assistant');
});

test('leaves normal answer text untouched', () => {
  const t = 'Here is the answer: 42. No tokens here.';
  assert.equal(scrubControlTokens(t), t);
});

test('literal reasoning tags remain intact throughout committed and displayed answers', () => {
  const answers = [
    'Return exactly "<think>demo</think>" and keep this trailing sentence.',
    'A <think> block ends at </think>; <mm:thinking> and </mm:thinking > are variants.',
    '<think>demo</think> is a literal example, not scrubber-owned reasoning.',
    '</think> The literal closing token is </think>.',
  ];
  for (const answer of answers) {
    assert.equal(scrubControlTokens(answer), answer);
    assert.equal(scrubForDisplay(answer), answer);
  }
});

test('quoted and Markdown code examples preserve chat-template tokens', () => {
  const examples = [
    'Use `<|im_start|>assistant<|im_end|>` and `<｜end▁of▁sentence｜>`.',
    'Use ``a `<channel|>` b``; then remove real noise.<channel|>',
    'The token is "<tool_call|>" or \'<|tool_response>\' or “<｜tool▁sep｜>”.',
    'Escaped markup: \\<|im_start|> remains literal.',
    '> <|im_start|>assistant<|im_end|>\n> <think>quoted</think>',
    '```xml\n<think>demo</think>\n<|im_start|>\n```\nTrailing answer.',
    '~~~text\n<｜end▁of▁sentence｜>\n~~~\nTrailing answer.',
    '````text\n```xml\n<|im_start|>\n```\n````\nTrailing answer.',
    'Code:\n\n    <|im_start|>assistant<|im_end|>\n\t<think>demo</think>',
  ];
  for (const example of examples) {
    const expected = example.endsWith('<channel|>') ? example.slice(0, -'<channel|>'.length) : example;
    assert.equal(scrubControlTokens(example), expected);
    assert.equal(scrubForDisplay(example), expected);
  }
});

test('partial code examples and escaped quotes preserve their literal token content', () => {
  for (const example of [
    'Here is `<|im_start|> before the code span finishes',
    '```text\n<|im_start|>\n<think>demo</think>',
    'The string is "a \\"quoted\\" <|im_start|> token".',
    "Don't leak noise.<channel|>",
  ]) {
    assert.equal(scrubControlTokens(example), example.replace(/<channel\|>$/, ''));
  }
});

test('leading indentation survives with and without a leaked chat-template token', () => {
  const code = '    </think>\n    <|im_start|>\n    return result;';
  assert.equal(scrubControlTokens(code), code);
  assert.equal(scrubControlTokens(`<|im_start|>\n${code}`), code);
  assert.equal(scrubControlTokens('  ordinary text'), '  ordinary text');
});

test('display scrub preserves tool envelope examples but removes actual leaked envelopes', () => {
  const envelope = '<tool_call>{"name":"read_file","arguments":{"path":"demo.txt"}}</tool_call>';
  for (const literal of [
    `Use \`${envelope}\` as the example.`,
    `\`\`\`xml\n${envelope}\n\`\`\`\nThe trailing answer remains.`,
    `Quoted: '${envelope}'.`,
    'Example: `<tool_call>{"name":"read_file"`',
  ]) {
    assert.equal(scrubForDisplay(literal), literal);
  }
  assert.equal(scrubForDisplay(`Before.\n${envelope}\nAfter.`), 'Before.\n\nAfter.');
  assert.equal(scrubForDisplay('Before.\n<tool_call>{"name":"read_file"'), 'Before.');
});

test('indented code survives — multi-space runs are NEVER collapsed (regression: code blocks flattened)', () => {
  // The old scrub collapsed `[ \t]{2,}` to one space "for compactness", silently mangling the
  // indented code blocks a local model is most likely to emit. Whitespace is content. Place the
  // closing template marker outside the indented line: markers inside code are now literal.
  const code = '  const x = 1;\n    return x;\t// tabbed tail';
  assert.equal(scrubControlTokens(`Here:\n<|im_start|>${code}\n<|im_end|>`), `Here:\n${code}\n`);
});

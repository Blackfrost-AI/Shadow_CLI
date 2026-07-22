import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collapseKind,
  collapseNoun,
  collapseVerb,
  collapseVerbLive,
  displayToolArg,
  displayToolName,
  formatReconSummary,
  isCollapsibleTool,
  isWriteTool,
  reconCount,
} from '../src/tui/toolDisplay.js';

test('displayToolName: snake_case → calm verbs', () => {
  assert.equal(displayToolName('read_file'), 'Read');
  assert.equal(displayToolName('edit_file'), 'Update');
  assert.equal(displayToolName('multi_edit'), 'Update');
  assert.equal(displayToolName('apply_patch'), 'Update');
  assert.equal(displayToolName('write_file'), 'Write');
  assert.equal(displayToolName('run_shell'), 'Bash');
  assert.equal(displayToolName('grep'), 'Grep');
  assert.equal(displayToolName('glob'), 'Glob');
  assert.equal(displayToolName('web_fetch'), 'Fetch');
  assert.equal(displayToolName('web_search'), 'WebSearch');
  assert.equal(displayToolName('mcp_server__list_issues'), 'ListIssues');
});

test('isCollapsibleTool: only recon tools fold', () => {
  assert.equal(isCollapsibleTool('read_file'), true);
  assert.equal(isCollapsibleTool('grep'), true);
  assert.equal(isCollapsibleTool('glob'), true);
  assert.equal(isCollapsibleTool('view_image'), true);
  assert.equal(isCollapsibleTool('edit_file'), false);
  assert.equal(isCollapsibleTool('write_file'), false);
  assert.equal(isCollapsibleTool('run_shell'), false);
  assert.equal(isCollapsibleTool('agent'), false);
  assert.equal(isCollapsibleTool('web_fetch'), false);
});

test('isWriteTool: mutations only', () => {
  assert.equal(isWriteTool('edit_file'), true);
  assert.equal(isWriteTool('multi_edit'), true);
  assert.equal(isWriteTool('write_file'), true);
  assert.equal(isWriteTool('apply_patch'), true);
  assert.equal(isWriteTool('read_file'), false);
  assert.equal(isWriteTool('run_shell'), false);
});

test('displayToolArg: strips $ and http(s), middle-truncates', () => {
  assert.equal(displayToolArg('$ npm test'), 'npm test');
  assert.equal(displayToolArg('https://example.com/path'), 'example.com/path');
  const long = 'a'.repeat(80);
  const shown = displayToolArg(long, 20);
  assert.ok(shown.includes('…'));
  assert.ok(shown.length <= 21);
});

test('collapseKind / verb / noun', () => {
  assert.equal(collapseKind('read_file'), 'read');
  assert.equal(collapseKind('grep'), 'search');
  assert.equal(collapseKind('glob'), 'list');
  assert.equal(collapseVerb('read'), 'Read');
  assert.equal(collapseVerb('search'), 'Grep');
  assert.equal(collapseVerbLive('read'), 'Reading');
  assert.equal(collapseVerbLive('search'), 'Grepping');
  assert.equal(collapseNoun('read', 1), 'file');
  assert.equal(collapseNoun('read', 3), 'files');
  assert.equal(collapseNoun('search', 1), 'pattern');
  assert.equal(collapseNoun('search', 2), 'patterns');
});

test('formatReconSummary: live progressive vs committed past', () => {
  const kinds = { read: 3, search: 1 };
  assert.equal(formatReconSummary(kinds), 'Read 3 files, Grep 1 pattern');
  assert.equal(formatReconSummary(kinds, { live: true }), 'Reading 3 files, Grepping 1 pattern');
  assert.equal(reconCount(kinds), 4);
  assert.equal(formatReconSummary({}, { fallbackLen: 5 }), '5 tools');
});

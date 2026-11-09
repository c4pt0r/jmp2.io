import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, plainText, snippet } from '../src/search.js';
import { docHref } from '../src/theme.js';

test('long terms go to the index, short ones to LIKE', () => {
  const q = parseQuery('deploy 搜索 worker 全文检索');
  assert.equal(q.match, '"deploy" AND "worker" AND "全文检索"');
  assert.deepEqual(q.likes, ['%搜索%']);
});

test('FTS5 syntax in a query is quoted, LIKE wildcards are escaped', () => {
  const q = parseQuery('a"b OR NEAR( 5%');
  assert.equal(q.match, '"a""b" AND "NEAR("');
  assert.deepEqual(q.likes, ['%OR%', '%5\\%%']);
});

test('an empty query has no terms', () => {
  assert.deepEqual(parseQuery('   ').terms, []);
  assert.equal(parseQuery('').match, null);
});

test('plain text drops markup, keeps the words', () => {
  const { title, text } = plainText('---\ntitle: T\n---\n# Hello\n\nSome **bold** & `code` <b>x</b>\n');
  assert.equal(title, 'T');
  assert.equal(text, 'Hello Some bold & code <b>x</b>');
});

test('snippets are escaped and highlight every term', () => {
  const s = snippet('x'.repeat(100) + ' the <worker> runs the Worker', ['worker']);
  assert.ok(s.startsWith('…'));
  assert.ok(s.includes('&lt;<mark>worker</mark>&gt;'));
  assert.ok(s.includes('<mark>Worker</mark>'));
});

test('doc URLs drop the extension and collapse indexes', () => {
  assert.equal(docHref('/h', 'index.md'), '/h/');
  assert.equal(docHref('/h', 'docs/README.md'), '/h/docs/');
  assert.equal(docHref('/h', 'docs/api.markdown'), '/h/docs/api');
});

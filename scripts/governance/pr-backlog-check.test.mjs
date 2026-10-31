import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPullRequests, reportMarkdown } from './pr-backlog-check.mjs';

const now = new Date('2026-10-31T02:00:00Z');
const p = (number, ref, base, hours = 1) => ({
  number, head: {ref}, base: {ref: base},
  created_at: new Date(now.getTime() - hours * 3_600_000).toISOString()
});

test('detects the real failure mode: 17 open stacked drafts before any draft is merged', () => {
  const all = Array.from({length: 17}, (_, i) => p(60 + i, `ux-${i}`, i ? `ux-${i-1}` : 'main', i ? 1 : 25));
  const audit = auditPullRequests(all, now);
  assert.equal(audit.openCount, 17);
  assert.equal(audit.stackCount, 1);
  assert.deepEqual(audit.findings.map(f => f.code), ['STACK_TOO_DEEP', 'STACK_ROOT_AGING']);
  assert.match(reportMarkdown(audit, 'EzzeddineAlimi/ezz-clinic-app'), /#60 → #61/);
});

test('allows a small recent stack while still requiring ordinary merge/review checks', () => {
  const audit = auditPullRequests([p(1, 'root', 'main'), p(2, 'next', 'root'), p(3, 'tip', 'next')], now);
  assert.deepEqual(audit.findings, []);
});

test('detects forgotten independent drafts even if comments refreshed updated_at', () => {
  const old = {...p(44, 'preview', 'main', 49), updated_at: now.toISOString()};
  assert.equal(auditPullRequests([old], now).findings[0].code, 'STANDALONE_AGING');
});

test('handles branching stacks without counting a shared ancestor twice', () => {
  const audit = auditPullRequests([p(1, 'root', 'main'), p(2, 'left', 'root'), p(3, 'right', 'root')], now);
  assert.equal(audit.stackCount, 1);
  assert.deepEqual(audit.findings, []);
});

test('fails fast on ambiguous graphs instead of reporting a false pass', () => {
  assert.throws(() => auditPullRequests([p(1, 'x', 'y'), p(2, 'y', 'x')], now), /cycle/);
  assert.throws(() => auditPullRequests([p(1, 'same', 'main'), p(2, 'same', 'main')], now), /Duplicate/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamRate, formatTokPerSec } from '../src/app/streamRate.js';

const CHUNK = 'a'.repeat(80); // 20 estimated tokens at four characters per token.

test('a stream shows an em dash until it has measured active decode time', () => {
  const rate = new StreamRate();
  assert.equal(formatTokPerSec(rate.read(1000, true)), '—');
  rate.append('short', 1000);
  assert.equal(formatTokPerSec(rate.read(1000, true)), '—');
  assert.equal(formatTokPerSec(rate.read(10_000, true)), '—');
});

test('live rate counts the first chunk and advances between stream events', () => {
  const rate = new StreamRate();
  rate.append(CHUNK, 1000);
  rate.append(CHUNK, 1500);
  assert.equal(formatTokPerSec(rate.read(1500, true)), '80 tok/s');
  assert.equal(formatTokPerSec(rate.read(1800, true)), '50 tok/s');
});

test('long pauses do not count as model decode time', () => {
  const rate = new StreamRate();
  rate.append(CHUNK, 1000);
  rate.append(CHUNK, 1500);
  rate.append(CHUNK, 10_000);
  // Two 500 ms active intervals produce 40 tokens: the 8.5 second gap is excluded.
  assert.equal(formatTokPerSec(rate.read(10_500, true)), '40 tok/s');
  assert.equal(formatTokPerSec(rate.read(60_000, true)), '40 tok/s');
});

test('the bounded window expires old fast samples and the final value freezes', () => {
  const rate = new StreamRate();
  rate.append(CHUNK, 0);
  rate.append(CHUNK, 125);
  assert.equal(formatTokPerSec(rate.read(325, true)), '123 tok/s');
  // A long wall-clock gap is not decode time and cannot age out the valid older burst. The
  // final value must freeze, not decay while idle or continue growing after completion.
  rate.append(CHUNK, 4000);
  rate.append(CHUNK, 4750);
  const live = formatTokPerSec(rate.read(4750, true));
  const finished = rate.finish(4750);
  assert.equal(formatTokPerSec(finished), live);
  assert.equal(formatTokPerSec(rate.read(10_000, false)), live);
  assert.equal(formatTokPerSec(rate.read(10_000, true)), live);
});

test('a full active window replaces older samples without counting idle wall time', () => {
  const rate = new StreamRate();
  rate.append(CHUNK, 0);
  rate.append(CHUNK, 125);
  // Resume after an idle gap, then decode continuously for a complete three-second window.
  for (let time = 10_000; time < 13_000; time += 500) rate.append(CHUNK, time);
  assert.equal(formatTokPerSec(rate.read(13_000, true)), '40 tok/s');
  assert.equal(formatTokPerSec(rate.read(13_500, true)), '40 tok/s', 'the tail cannot extend a full active window');
});

test('tool-only, zero-time, and new turns have no fabricated throughput', () => {
  const rate = new StreamRate();
  rate.append(CHUNK, 1000);
  assert.equal(rate.finish(1000), null);
  rate.reset();
  assert.equal(formatTokPerSec(rate.read(5000, false)), '—');
  rate.append(CHUNK, 5000);
  assert.equal(formatTokPerSec(rate.read(5000, true)), '—');
});

// 持ち点の配り方と割り当ての計算を確かめる:  npm test（= node --test）

import test from 'node:test';
import assert from 'node:assert/strict';
import { BUDGET, proportional, fromMarks, evenSplit, setPoint, spendRemainder, remaining, allocate, parseSessions } from '../logic.js';

// 決まった順の乱数（mulberry32）。問題を作るのに使う
function rand(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

// 全部試して、最小値 → 合計 の順で一番よいものを返す
function bruteForce(points, capacity) {
  const n = points.length, m = capacity.length;
  let best = null;
  const slotOf = new Array(n), used = new Array(m).fill(0);
  (function rec(i) {
    if (i === n) {
      const got = slotOf.map((s, k) => points[k][s]);
      const min = Math.min(...got), total = got.reduce((a, x) => a + x, 0);
      if (!best || min > best.min || (min === best.min && total > best.total)) best = { min, total };
      return;
    }
    for (let s = 0; s < m; s++) {
      if (used[s] >= capacity[s]) continue;
      used[s]++; slotOf[i] = s; rec(i + 1); used[s]--;
    }
  })(0);
  return best;
}

function checkCapacity(res, capacity) {
  const count = new Array(capacity.length).fill(0);
  for (const s of res.slotOf) count[s]++;
  count.forEach((c, s) => assert.ok(c <= capacity[s], `定員を超えた: ${c} > ${capacity[s]}`));
}

test('小さい問題 400 個で、全部試した答えと最小値・合計が一致する', () => {
  const r = rand(20260925);
  for (let k = 0; k < 400; k++) {
    const m = int(r, 2, 4);
    const capacity = Array.from({ length: m }, () => int(r, 1, 2));
    const seats = capacity.reduce((a, c) => a + c, 0);
    const n = int(r, 1, Math.min(5, seats));
    // 半分は ◎○△✕ から（同点が多い）、半分はばらばらの点
    const points = Array.from({ length: n }, () => (k % 2
      ? fromMarks(Array.from({ length: m }, () => '◎○△✕'[int(r, 0, 3)]))
      : Array.from({ length: m }, () => int(r, 0, 100))));
    const res = allocate(points, capacity, k);
    const best = bruteForce(points, capacity);
    assert.equal(res.min, best.min, `#${k} 最小値 ${JSON.stringify({ points, capacity })}`);
    assert.equal(res.total, best.total, `#${k} 合計 ${JSON.stringify({ points, capacity })}`);
    checkCapacity(res, capacity);
  }
});

test('仕様の例', () => {
  const cases = [
    { cap: [1, 1], pts: [[100, 0], [50, 50]], min: 50, total: 150, slotOf: [0, 1] },
    { cap: [1, 1], pts: [[100, 30], [40, 0]], min: 30, total: 70, slotOf: [1, 0] },
    { cap: [1, 1, 1], pts: [[50, 50, 50], [50, 50, 50], [90, 50, 50]], min: 50, total: 190 },
    { cap: [2, 2], pts: [[90, 10], [90, 10], [90, 10], [90, 10]], min: 10, total: 200 },
  ];
  for (const c of cases) {
    for (let seed = 0; seed < 10; seed++) {
      const res = allocate(c.pts, c.cap, seed);
      assert.equal(res.min, c.min);
      assert.equal(res.total, c.total);
      if (c.slotOf) assert.deepEqual(res.slotOf, c.slotOf);
      checkCapacity(res, c.cap);
    }
  }
  assert.equal(allocate([[50, 50, 50], [50, 50, 50], [90, 50, 50]], [1, 1, 1]).slotOf[2], 0);   // c→A
  const four = allocate([[90, 10], [90, 10], [90, 10], [90, 10]], [2, 2]).slotOf;
  assert.equal(four.filter((s) => s === 0).length, 2);
});

test('同じ種なら同じ結果、種を変えると同点の中で顔ぶれが変わる', () => {
  const pts = [[50, 50], [50, 50], [50, 50]], cap = [3, 3];
  assert.deepEqual(allocate(pts, cap, 7), allocate(pts, cap, 7));
  const seen = new Set();
  let allA = false;
  for (let seed = 0; seed < 40; seed++) {
    const res = allocate(pts, cap, seed);
    assert.equal(res.min, 50);
    assert.equal(res.total, 150);
    seen.add(res.slotOf.join());
    if (res.slotOf.every((s) => s === 0)) allA = true;
  }
  assert.ok(seen.size > 1, '引き直しても変わらない');
  assert.ok(allA, '40 回で 3 人とも A に当たらなかった');
});

test('定員が足りなければ投げる、希望のない人（全部 0）もいてよい', () => {
  assert.throws(() => allocate([[1, 0], [0, 1], [1, 1]], [1, 1]));
  const res = allocate([[0, 0], [60, 40]], [1, 1]);
  assert.deepEqual(res, { slotOf: [1, 0], min: 0, total: 60 });
});

test('一番大きい場合（30 人・10 か所・席 300）が 200 ミリ秒以内', () => {
  const r = rand(1);
  const points = Array.from({ length: 30 }, () => fromMarks(Array.from({ length: 10 }, () => '◎○△✕'[int(r, 0, 3)])));
  const capacity = new Array(10).fill(30);
  allocate(points, capacity, 0);   // 最初の 1 回は JIT の準備
  const times = [];
  for (let seed = 0; seed < 5; seed++) {
    const t0 = performance.now();
    allocate(points, capacity, seed);
    times.push(performance.now() - t0);
  }
  const worst = Math.max(...times);
  console.log(`30 人・10 か所・席 300: ${times.map((t) => t.toFixed(1)).join(' / ')} ms`);
  assert.ok(worst < 200, `${worst} ms`);
});

test('持ち点の配り方', () => {
  assert.deepEqual(fromMarks(['◎', '○', '△', '✕']), [57, 29, 14, 0]);
  assert.deepEqual(fromMarks(['✕', '✕']), [0, 0]);
  assert.deepEqual(fromMarks(['○', '○', '○']), [34, 33, 33]);
  assert.deepEqual(evenSplit(3), [34, 33, 33]);
  assert.deepEqual(proportional([1, 1, 1, 1, 1, 1, 1]), [15, 15, 14, 14, 14, 14, 14]);
  for (let n = 1; n <= 10; n++) assert.equal(remaining(evenSplit(n)), 0);
  assert.deepEqual(setPoint([30, 60], 0, 50), [40, 60]);   // 100 を超える分は受け付けない
  assert.deepEqual(setPoint([30, 60], 0, -5), [0, 60]);
  assert.deepEqual(spendRemainder([10, 30, 30]), [10, 60, 30]);
  assert.equal(BUDGET, 100);
});

test('記録: 形の合わないものは読み飛ばす', () => {
  const ok = { id: 'a', title: 't', budget: 100, slots: [{ id: 's', name: 'A', capacity: 2 }],
    members: [{ id: 'm', name: 'x', points: { s: 100 } }], seed: 0, results: null, createdAt: '1', updatedAt: '2' };
  const newer = { ...ok, id: 'b', updatedAt: '3', results: [{ memberId: 'm', slotId: 's', points: 100 }] };
  const bad = [null, 1, { ...ok, slots: 'x' }, { ...ok, members: [{ id: 'm', name: 'x', points: { zz: 5 } }] }];
  assert.deepEqual(parseSessions({ v: 1, list: [ok, ...bad, newer] }).map((s) => s.id), ['b', 'a']);
  assert.deepEqual(parseSessions(null), []);
  assert.deepEqual(parseSessions({ v: 2, list: [ok] }), []);
});

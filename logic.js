// 持ち点の配り方と割り当ての計算（画面に依存しない部分）。test/logic.test.mjs で確かめる。
// 点はすべて整数のまま扱う（小数を通さない）。

export const BUDGET = 100;
export const LIMITS = { members: [2, 30], slots: [2, 10], capacity: [1, 30] };

// ---------- 持ち点の配り方 ----------

export const MARKS = ['◎', '○', '△', '✕'];
const MARK_WEIGHT = { '◎': 8, '○': 4, '△': 2, '✕': 0 };

// 重みの比で budget を整数に分ける（最大剰余法）。切り捨ててから、余りの大きい順に 1 点ずつ。
// 同じ余りなら上の行から。重みが全部 0 なら全部 0。
export function proportional(weights, budget = BUDGET) {
  const total = weights.reduce((a, w) => a + w, 0);
  if (total <= 0) return weights.map(() => 0);
  const out = weights.map((w) => Math.floor((budget * w) / total));
  const left = budget - out.reduce((a, x) => a + x, 0);
  const order = weights.map((w, i) => ({ i, rest: (budget * w) % total }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (let k = 0; k < left; k++) out[order[k].i] += 1;
  return out;
}

export const fromMarks = (marks, budget = BUDGET) => proportional(marks.map((m) => MARK_WEIGHT[m]), budget);
export const evenSplit = (count, budget = BUDGET) => proportional(new Array(count).fill(1), budget);
export const remaining = (points, budget = BUDGET) => budget - points.reduce((a, x) => a + x, 0);

// i 番目を value にする。0 未満と、合計が budget を超える分は受け付けない（配れるところまで）
export function setPoint(points, i, value, budget = BUDGET) {
  const others = points.reduce((a, x, k) => (k === i ? a : a + x), 0);
  const next = points.slice();
  next[i] = Math.max(0, Math.min(value, budget - others));
  return next;
}

// 余りを、いま一番点が高い所（同じなら上の行）へ
export function spendRemainder(points, budget = BUDGET) {
  const left = remaining(points, budget);
  if (left <= 0 || points.length === 0) return points.slice();
  let top = 0;
  for (let i = 1; i < points.length; i++) if (points[i] > points[top]) top = i;
  const next = points.slice();
  next[top] += left;
  return next;
}

// ---------- 割り当て ----------

// 整数の乱数（mulberry32）。0〜2³²−1 の整数を返す
function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function shuffle(arr, next) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 全員が t 点以上の席に座れるか（2 部グラフの完全マッチング、増加路法）
function canSeat(P, t) {
  const S = P[0].length;
  const owner = new Int32Array(S).fill(-1);
  let seen;
  const augment = (i) => {
    for (let s = 0; s < S; s++) {
      if (seen[s] || P[i][s] < t) continue;
      seen[s] = 1;
      if (owner[s] < 0 || augment(owner[s])) { owner[s] = i; return true; }
    }
    return false;
  };
  for (let i = 0; i < P.length; i++) {
    seen = new Uint8Array(S);
    if (!augment(i)) return false;
  }
  return true;
}

// 最小費用の割り当て（ハンガリー法）。行 n ≤ 列 m。行ごとの列の番号を返す
function hungarian(cost) {
  const n = cost.length, m = cost[0].length;
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity), used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const col = new Array(n);
  for (let j = 1; j <= m; j++) if (p[j]) col[p[j] - 1] = j - 1;
  return col;
}

// points[人][行き先] は 0 以上の整数、capacity[行き先] は定員。
// 1. 一番低い人の点を最大に 2. そのうえで合計を最大に 3. 同じなら seed で並べ替えた順で選ぶ。
// 返り値: { slotOf: 人ごとの行き先の番号, min, total }
export function allocate(points, capacity, seed = 0) {
  const n = points.length;
  if (n === 0) return { slotOf: [], min: 0, total: 0 };
  const seatsTotal = capacity.reduce((a, c) => a + c, 0);
  if (seatsTotal < n) throw new Error('定員が足りない');

  // 人と席の並びを種で並べ替える（同点のときにどれを選ぶかがここで決まる）
  const next = rng(seed);
  const people = shuffle([...Array(n).keys()], next);
  const seats = shuffle(capacity.flatMap((c, slot) => new Array(c).fill(slot)), next);
  const P = people.map((i) => seats.map((slot) => points[i][slot]));

  // 段階 1: 表に出てくる点の値で二分探索。一番小さい値なら必ず座れる
  const values = [...new Set(P.flat())].sort((a, b) => a - b);
  let lo = 0, hi = values.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (canSeat(P, values[mid])) lo = mid; else hi = mid - 1;
  }
  const t = values[lo];

  // 段階 2: t 点未満の席は禁止にして、費用 = 最大の点 − 点 の最小を解く（= 合計が最大）
  const top = values[values.length - 1];
  const BAN = (top + 1) * (n + 1);   // 許された席だけの費用の合計より必ず大きい
  const col = hungarian(P.map((row) => row.map((x) => (x >= t ? top - x : BAN))));

  const slotOf = new Array(n);
  people.forEach((i, k) => { slotOf[i] = seats[col[k]]; });
  const got = slotOf.map((slot, i) => points[i][slot]);
  return { slotOf, min: Math.min(...got), total: got.reduce((a, x) => a + x, 0) };
}

// ---------- 記録 ----------

const isInt = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;

function looksLikeSession(s) {
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || typeof s.title !== 'string') return false;
  if (!Array.isArray(s.slots) || !Array.isArray(s.members) || !Number.isInteger(s.seed)) return false;
  if (typeof s.createdAt !== 'string' || typeof s.updatedAt !== 'string') return false;
  if (!s.slots.every((x) => x && typeof x.id === 'string' && typeof x.name === 'string' && isInt(x.capacity, 1, 30))) return false;
  const ids = new Set(s.slots.map((x) => x.id));
  const okPoints = (p) => p === null || (typeof p === 'object' && Object.entries(p).every(([k, v]) => ids.has(k) && isInt(v, 0, BUDGET)));
  if (!s.members.every((m) => m && typeof m.id === 'string' && typeof m.name === 'string' && okPoints(m.points))) return false;
  const mids = new Set(s.members.map((m) => m.id));
  return s.results === null || (Array.isArray(s.results)
    && s.results.every((r) => r && mids.has(r.memberId) && ids.has(r.slotId) && isInt(r.points, 0, BUDGET)));
}

// 保存されていた値から、形の合う記録だけを新しい順に返す（1 件が壊れても全部は消えない）
export function parseSessions(data) {
  const list = data && data.v === 1 && Array.isArray(data.list) ? data.list : [];
  return list.filter(looksLikeSession).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

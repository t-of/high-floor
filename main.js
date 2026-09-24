// HIGH FLOOR: みんなが持ち点 100 点を行き先に配り、一番点の低い人ができるだけ高くなる割り当てを出す。
// 計算は logic.js。名前・希望点・結果は localStorage にだけ置き、通信しない。

import { BUDGET, LIMITS, MARKS, fromMarks, evenSplit, setPoint, spendRemainder, remaining, allocate, parseSessions } from './logic.js';

// ---------- 保存 ----------

// localStorage はほかのアプリと共有される（同じ t-of.github.io のため）。
// キーは必ず 'high-floor.' で始める。
const STORE = 'high-floor.';
function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても使える */ }
}

const MAX_RECORDS = 20;
let sessions = parseSessions(load('sessions', null));
const settings = { sound: load('settings', null)?.sound !== false };

function saveSessions() {
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  save('sessions', { v: 1, list: sessions });
}
const findSession = (id) => sessions.find((s) => s.id === id);
const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function touch(s) { s.updatedAt = new Date().toISOString(); saveSessions(); }

WebAppKit.init({ title: 'HIGH FLOOR', text: '一番損する人を出さない割り当て。部屋割りや係決めに。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// ---------- 音 ----------

// 音を鳴らす前と音の設定を切り替えたときにこれを呼ぶ（RULES.md §5「音」）。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}

const sound = {
  ctx: null,
  wake() {
    if (!settings.sound) return;
    setAudioSession(true);
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  tone(freq, { at = 0, dur = 0.12, type = 'sine', gain = 0.1 } = {}) {
    if (!settings.sound || !this.ctx) return;
    const t = this.ctx.currentTime + at;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  },
  // カチッ（pitch が大きいほど高い。◎ 3 … ✕ 0）
  click(pitch = 1) { this.tone(900 + pitch * 180, { dur: 0.03, type: 'triangle', gain: 0.07 }); },
  bump() { this.tone(140, { dur: 0.09, type: 'square', gain: 0.035 }); },
  yes() { [660, 880].forEach((f, i) => this.tone(f, { at: i * 0.09, dur: 0.16, gain: 0.07 })); },
  done() { [784, 988, 1318].forEach((f, i) => this.tone(f, { at: i * 0.08, dur: 0.14, type: 'triangle', gain: 0.07 })); },
  decide() { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, { at: i * 0.1, dur: 0.22, type: 'triangle', gain: 0.08 })); },
  shuffle() { [700, 900, 760, 1000, 1180].forEach((f, i) => this.tone(f, { at: i * 0.045, dur: 0.05, type: 'triangle', gain: 0.06 })); },
  remove() { this.tone(180, { dur: 0.2, gain: 0.09 }); },
};
addEventListener('pointerdown', () => sound.wake(), { capture: true });

// ---------- 画面の切り替え（history を使うのでブラウザの戻るでも戻れる） ----------
// 手渡し → 希望を入れる → 目かくし → 次の手渡し は replaceState でつなぐ。
// 戻ると必ず「入力のようす」に出るので、前の人の点をのぞけない。

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function go(state, replace = false) {
  history[replace ? 'replaceState' : 'pushState'](state, '');
  render();
  scrollTo(0, 0);
}
addEventListener('popstate', () => { closeSheet(); render(); });

let createDraft = null;   // つくる画面の中身
let wish = null;          // 希望を入れる画面の中身（入れ終わったら捨てる）

// 今の状態で出せない画面なら、出せる画面に直す
function fixState(st) {
  const s = st.id && findSession(st.id);
  if (st.id && !s) return { s: 'home' };
  if (st.member && !s.members.some((m) => m.id === st.member)) return { s: 'session', id: st.id };
  // 希望の入力中に読み込み直したら、手渡しからやり直す
  if (st.s === 'input' && (!wish || wish.member !== st.member)) return { s: 'handoff', id: st.id, member: st.member };
  if (st.s === 'result' && !s.results) return { s: 'session', id: st.id };
  return st;
}

function render() {
  const raw = history.state || { s: 'home' };
  const st = fixState(raw);
  if (st !== raw) history.replaceState(st, '');
  if (st.s !== 'input') wish = null;
  if (st.s === 'create' && !createDraft) createDraft = newDraft();

  const s = st.id && findSession(st.id);
  document.body.dataset.screen = st.s;
  const titles = { home: 'HIGH FLOOR', create: '新しく決める', session: '入力のようす', result: '結果' };
  $('bar-title').textContent = titles[st.s] ?? '';
  const view = { home: viewHome, create: viewCreate, session: viewSession, handoff: viewHandoff, input: viewInput, blind: viewBlind, result: viewResult }[st.s] || viewHome;
  stage.innerHTML = view(s, st);
}

// ---------- 確かめのシート（window.confirm は使わない） ----------

let sheetButtons = [];
function openSheet(title, text, buttons) {
  $('sheet-title').textContent = title;
  $('sheet-text').textContent = text;
  sheetButtons = buttons;
  $('sheet-btns').innerHTML = buttons.map((b, i) =>
    `<button class="btn ${b.kind || 'ghost'}" data-sheet="${i}">${esc(b.label)}</button>`).join('');
  $('sheet').hidden = false;
}
function closeSheet() { $('sheet').hidden = true; }
$('sheet').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sheet]');
  if (b) { closeSheet(); sheetButtons[b.dataset.sheet].fn?.(); }
  else if (e.target === $('sheet')) closeSheet();
});

// ---------- ホーム ----------

const fmtDate = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
const submitted = (s) => s.members.filter((m) => m.points).length;

function viewHome() {
  const list = sessions.map((s) => `
    <li><button class="record" data-act="open" data-id="${s.id}">
      <span class="record__title">${esc(s.title)}</span>
      <span class="tag ${s.results ? 'tag--done' : ''}">${s.results ? '決定' : `入力中 ${submitted(s)}/${s.members.length}`}</span>
      <span class="record__meta">${fmtDate(s.createdAt)}・${s.slots.length} か所・${s.members.length} 人</span>
    </button></li>`).join('');
  return `
    <div class="hero">
      <p class="hero__lead">一番損する人を出さない割り当て</p>
      <button class="btn primary big" data-act="new">新しく決める</button>
    </div>
    ${sessions.length ? `<h2 class="h">記録</h2><ul class="records">${list}</ul>` : ''}
    <section class="howto">
      <h2 class="h">使い方</h2>
      <ol>
        <li>決めたいこと（例: 部屋割り）と、行き先（和室 4 人・洋室 2 人…）と、参加者を入れる。</li>
        <li>端末を 1 人ずつ回す。自分の番の人は、持ち点 <b>100 点</b>を行きたい先に多く配る（◎○△✕ を付けるだけでもよい）。前の人の点は見えない。</li>
        <li>全員が入れたら「割り当てる」。<b>一番点の低い人ができるだけ高くなる</b>組み合わせが出る。同じくらい公平な組み合わせがほかにもあれば「引き直す」で変えられる。</li>
      </ol>
      <p class="note">名前と希望はこの端末から出ません。</p>
    </section>`;
}

// ---------- つくる ----------

const TEMPLATES = [
  { name: '部屋割り', slots: [['和室', 4], ['洋室A', 2], ['洋室B', 2]] },
  { name: '係決め', slots: [['会計', 1], ['書記', 1], ['広報', 2], ['備品', 2]] },
  { name: '当番', slots: [['月曜', 1], ['火曜', 1], ['水曜', 1], ['木曜', 1], ['金曜', 1]] },
  { name: '品物', slots: [['品物A', 1], ['品物B', 1], ['品物C', 1], ['品物D', 1]] },
];
const fromTemplate = (t) => t.slots.map(([name, capacity]) => ({ name, capacity }));

function newDraft() {
  return { template: TEMPLATES[0].name, title: '', slots: fromTemplate(TEMPLATES[0]), members: ['', '', '', ''] };
}

function seatProblem(slots, memberCount) {
  const seats = slots.reduce((a, x) => a + x.capacity, 0);
  return seats >= memberCount ? '' : `定員の合計が ${seats} 人で、参加者 ${memberCount} 人に足りません。定員を増やすか、行き先を足してください。`;
}

function viewCreate() {
  const d = createDraft;
  const seats = d.slots.reduce((a, x) => a + x.capacity, 0);
  const problem = seatProblem(d.slots, d.members.length);
  return `
    <label class="field"><span class="field__label">タイトル</span>
      <input class="input" data-field="title" maxlength="30" placeholder="${esc(d.template)}" value="${esc(d.title)}"></label>
    <div class="chips-row">${TEMPLATES.map((t) =>
      `<button class="chip-btn" data-act="template" data-name="${esc(t.name)}" aria-pressed="${d.template === t.name}">${esc(t.name)}</button>`).join('')}</div>

    <h2 class="h">行き先 <small>${d.slots.length} か所</small></h2>
    <ul class="rows">${d.slots.map((x, i) => `
      <li class="row">
        <input class="input" data-field="slot" data-i="${i}" maxlength="20" placeholder="行き先 ${i + 1}" value="${esc(x.name)}" aria-label="行き先 ${i + 1} の名前">
        <div class="stepper">
          <button class="icon-btn" data-act="cap" data-i="${i}" data-d="-1" aria-label="定員を減らす">−</button>
          <span class="stepper__num">${x.capacity}<small>人</small></span>
          <button class="icon-btn" data-act="cap" data-i="${i}" data-d="1" aria-label="定員を増やす">＋</button>
        </div>
        <button class="icon-btn danger" data-act="del-slot" data-i="${i}" aria-label="消す">×</button>
      </li>`).join('')}</ul>
    <button class="btn ghost" data-act="add-slot">＋ 行き先を足す</button>

    <h2 class="h">参加者 <small>${d.members.length} 人</small></h2>
    <ul class="rows">${d.members.map((name, i) => `
      <li class="row">
        <input class="input" data-field="member" data-i="${i}" maxlength="20" placeholder="参加者 ${i + 1}" value="${esc(name)}" aria-label="参加者 ${i + 1} の名前">
        <button class="icon-btn danger" data-act="del-member" data-i="${i}" aria-label="消す">×</button>
      </li>`).join('')}</ul>
    <button class="btn ghost" data-act="add-member">＋ 参加者を足す</button>

    <div class="sum ${problem ? 'sum--bad' : ''}">定員の合計 <b>${seats}</b> 人 ／ 参加者 <b>${d.members.length}</b> 人</div>
    ${problem ? `<p class="warn">${esc(problem)}</p>` : ''}
    <button class="btn primary big" data-act="start" ${problem ? 'disabled' : ''}>はじめる</button>`;
}

stage.addEventListener('input', (e) => {
  const f = e.target.dataset.field;
  if (!f || !createDraft) return;
  const i = +e.target.dataset.i;
  if (f === 'title') createDraft.title = e.target.value;
  else if (f === 'slot') createDraft.slots[i].name = e.target.value;
  else if (f === 'member') createDraft.members[i] = e.target.value;
});

function startSession() {
  const d = createDraft;
  if (seatProblem(d.slots, d.members.length)) { sound.bump(); return; }
  const make = () => {
    const now = new Date().toISOString();
    const s = {
      id: makeId(),
      title: d.title.trim() || d.template,
      budget: BUDGET,
      slots: d.slots.map((x, i) => ({ id: makeId() + i, name: x.name.trim() || `行き先 ${i + 1}`, capacity: x.capacity })),
      members: d.members.map((name, i) => ({ id: makeId() + i, name: name.trim() || `参加者 ${i + 1}`, points: null })),
      seed: 0,
      results: null,
      createdAt: now,
      updatedAt: now,
    };
    sessions.unshift(s);
    saveSessions();
    createDraft = null;
    sound.yes();
    go({ s: 'session', id: s.id }, true);
  };
  if (sessions.length < MAX_RECORDS) return make();
  // 21 件目: 一番古い「決定」の記録から消す。全部入力中ならたずねる
  const byOld = sessions.slice().sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const decided = byOld.find((s) => s.results);
  if (decided) { sessions = sessions.filter((s) => s !== decided); return make(); }
  openSheet('記録がいっぱいです', `記録は ${MAX_RECORDS} 件までです。入力中の一番古い「${byOld[0].title}」を消して作りますか？`, [
    { label: '消して作る', kind: 'danger', fn: () => { sessions = sessions.filter((s) => s !== byOld[0]); make(); } },
    { label: 'やめる' },
  ]);
}

// ---------- 入力のようす ----------

function viewSession(s) {
  const done = submitted(s);
  const next = s.members.find((m) => !m.points);
  return `
    <h2 class="title">${esc(s.title)}</h2>
    <p class="sub">${s.slots.map((x) => `${esc(x.name)} ${x.capacity}`).join('・')}</p>
    <p class="progress">入力ずみ <b>${done}</b> / ${s.members.length} 人</p>
    <ul class="people">${s.members.map((m) => `
      <li><button class="person" data-act="member" data-member="${m.id}">
        <span class="person__name">${esc(m.name)}</span>
        <span class="tag ${m.points ? 'tag--done' : ''}">${m.points ? '入力ずみ' : 'まだ'}</span>
      </button></li>`).join('')}</ul>
    <p class="note">名前を押すと、入れ直す・外すができます。</p>
    <div class="actions">
      ${next ? `<button class="btn primary big" data-act="handoff" data-member="${next.id}">${esc(next.name)}さんに渡す</button>` : ''}
      <button class="btn ${next ? 'ghost' : 'primary big'}" data-act="allocate">割り当てる</button>
      <button class="btn text danger" data-act="delete">この記録を消す</button>
    </div>`;
}

function memberSheet(s, m) {
  if (m.points) {
    openSheet(m.name, '入力ずみです。', [
      { label: '入れ直す', kind: 'primary', fn: () => go({ s: 'handoff', id: s.id, member: m.id }) },
      { label: '希望を消す', kind: 'danger', fn: () => { m.points = null; s.results = null; touch(s); sound.remove(); render(); } },
      { label: 'とじる' },
    ]);
  } else {
    openSheet(m.name, 'まだ入力していません。', [
      { label: 'この人に渡す', kind: 'primary', fn: () => go({ s: 'handoff', id: s.id, member: m.id }) },
      { label: '外す', kind: 'danger', fn: () => {
        if (s.members.length <= LIMITS.members[0]) { sound.bump(); return openSheet('外せません', `参加者は ${LIMITS.members[0]} 人以上いります。`, [{ label: 'とじる' }]); }
        s.members = s.members.filter((x) => x !== m); s.results = null; touch(s); sound.remove(); render();
      } },
      { label: 'とじる' },
    ]);
  }
}

function decide(s, seed) {
  const points = s.members.map((m) => s.slots.map((x) => m.points?.[x.id] ?? 0));
  const res = allocate(points, s.slots.map((x) => x.capacity), seed);
  s.seed = seed;
  s.results = s.members.map((m, i) => ({ memberId: m.id, slotId: s.slots[res.slotOf[i]].id, points: points[i][res.slotOf[i]] }));
  touch(s);
}

function askAllocate(s) {
  const problem = seatProblem(s.slots, s.members.length);
  if (problem) { sound.bump(); return openSheet('割り当てられません', problem, [{ label: 'とじる' }]); }
  const run = () => { decide(s, s.seed); sound.decide(); go({ s: 'result', id: s.id, from: 'session' }); };
  const left = s.members.filter((m) => !m.points);
  if (!left.length) return run();
  openSheet('まだの人がいます', `${left.map((m) => m.name).join('・')}さんは、全部の行き先に 0 点を付けたものとして割り当てます。`, [
    { label: 'このまま割り当てる', kind: 'primary', fn: run },
    { label: 'もどる' },
  ]);
}

function askDelete(s) {
  openSheet('この記録を消しますか？', `「${s.title}」の名前・希望・結果を消します。元に戻せません。`, [
    { label: '消す', kind: 'danger', fn: () => { sessions = sessions.filter((x) => x !== s); saveSessions(); sound.remove(); go({ s: 'home' }, true); } },
    { label: 'やめる' },
  ]);
}

// ---------- 手渡し・希望を入れる・目かくし ----------

function viewHandoff(s, st) {
  const m = s.members.find((x) => x.id === st.member);
  return `
    <div class="center">
      <p class="handoff__name">${esc(m.name)}</p>
      <p class="handoff__ask">さんですか？</p>
      <p class="note">前の人の希望は見えません。</p>
      <button class="btn primary big" data-act="yes">はい、${esc(m.name)}です</button>
      <button class="btn ghost" data-act="back">やめる</button>
    </div>`;
}

function startWish(s, m) {
  const marks = s.slots.map(() => '○');
  // 入れ直すときは前の点から（こまかく）
  wish = m.points
    ? { member: m.id, mode: 'fine', marks, points: s.slots.map((x) => m.points[x.id] ?? 0) }
    : { member: m.id, mode: 'easy', marks, points: fromMarks(marks) };
}

function viewInput(s) {
  const m = s.members.find((x) => x.id === wish.member);
  const left = remaining(wish.points);
  const easy = wish.mode === 'easy';
  return `
    <h2 class="title">${esc(m.name)}さんの希望</h2>
    <div class="seg" role="group" aria-label="入れ方">
      <button data-act="mode" data-mode="easy" aria-pressed="${easy}">かんたん</button>
      <button data-act="mode" data-mode="fine" aria-pressed="${!easy}">こまかく</button>
    </div>
    <p class="left">${easy ? '◎ 行きたい ○ よい △ まあ ✕ いやだ' : `あと <b>${left}</b> 点`}</p>
    <ul class="wish">${s.slots.map((x, i) => `
      <li class="wish__row">
        <div class="wish__head">
          <span class="wish__name">${esc(x.name)}</span><span class="wish__cap">定員 ${x.capacity}</span>
          <span class="wish__pts"><b>${wish.points[i]}</b>点</span>
        </div>
        <div class="meter"><i style="width:${wish.points[i]}%"></i></div>
        <div class="wish__ctl">${easy
          ? MARKS.map((k) => `<button class="mark" data-act="mark" data-i="${i}" data-mark="${k}" aria-pressed="${wish.marks[i] === k}">${k}</button>`).join('')
          : [-10, -1, 1, 10].map((d) => `<button class="mark" data-act="step" data-i="${i}" data-d="${d}">${d > 0 ? '+' : '−'}${Math.abs(d)}</button>`).join('')}
        </div>
      </li>`).join('')}</ul>
    ${easy ? '' : `<div class="two">
      <button class="btn ghost" data-act="even">均等にする</button>
      <button class="btn ghost" data-act="rest">残りを一番高い所へ</button></div>`}
    <button class="btn primary big" data-act="submit">入れ終わった（次の人へ）</button>`;
}

function submitWish(s) {
  const m = s.members.find((x) => x.id === wish.member);
  const done = () => {
    m.points = Object.fromEntries(s.slots.map((x, i) => [x.id, wish.points[i]]));
    s.results = null;
    touch(s);
    wish = null;
    sound.done();
    go({ s: 'blind', id: s.id }, true);
  };
  const left = remaining(wish.points);
  if (!left) return done();
  openSheet(`あと ${left} 点残っています`, '残りの点は捨てて出しますか？', [
    { label: 'このまま出す', kind: 'primary', fn: done },
    { label: 'もどる' },
  ]);
}

function viewBlind() {
  return `<button class="blind" data-act="blind-next">次の人に<br>渡してください</button>`;
}

// ---------- 結果 ----------

const PALETTE = ['#7ee0b5', '#ffd35c', '#6cb8ff', '#ff8a7a', '#c59bff', '#5fd4d9', '#f0a35e', '#b4d96b', '#ff9fd0', '#a8b0c0'];
const color = (i) => PALETTE[i % PALETTE.length];

function summary(s) {
  const pts = s.results.map((r) => r.points);
  return { min: Math.min(...pts), total: pts.reduce((a, x) => a + x, 0) };
}

function viewResult(s) {
  const { min, total } = summary(s);
  const nameOf = Object.fromEntries(s.members.map((m) => [m.id, m.name]));
  const groups = s.slots.map((x, si) => {
    const inside = s.results.filter((r) => r.slotId === x.id);
    return `<li class="group" style="--c:${color(si)};--d:${si}">
      <div class="group__head"><span class="group__name">${esc(x.name)}</span><small>${inside.length} / ${x.capacity} 人</small></div>
      <ul class="chips">${inside.map((r) => `<li class="chip ${r.points === min ? 'chip--min' : ''}">${r.points === min ? '▼ ' : ''}${esc(nameOf[r.memberId])} <b>${r.points}</b></li>`).join('') || '<li class="chip chip--empty">だれもいない</li>'}</ul>
    </li>`;
  }).join('');
  const bars = s.members.map((m) => {
    const r = s.results.find((x) => x.memberId === m.id);
    const segs = s.slots.map((x, i) => {
      const p = m.points?.[x.id] ?? 0;
      return p ? `<i style="width:${p}%;background:${color(i)}" class="${x.id === r.slotId ? 'on' : ''}"></i>` : '';
    }).join('');
    return `<li class="wbar"><div class="wbar__head"><span>${esc(m.name)}</span><span>→ ${esc(s.slots.find((x) => x.id === r.slotId).name)} <b>${r.points}</b>点</span></div>
      <div class="stack">${segs || '<em>希望なし（全部 0 点）</em>'}</div></li>`;
  }).join('');
  return `
    <h2 class="title">${esc(s.title)}</h2>
    <div class="score">
      <div><span>一番低い人で</span><b>${min}</b><small>点</small></div>
      <div><span>全員の合計</span><b>${total}</b><small>点</small></div>
    </div>
    <ul class="groups">${groups}</ul>
    <p class="note">▼ は一番低い点（${min} 点）の人。数字はその人が入った先に付けていた点。</p>
    <details class="why">
      <summary>なぜこうなったか</summary>
      <p>まず、一番点の低い人の点ができるだけ高くなる組み合わせを探します。そのうえで、全員の点の合計が一番高くなるものを選びます。同じくらい公平な組み合わせがほかにもあるときは「引き直す」で変わります（一番低い点と合計は変わりません）。</p>
      <p class="legend">${s.slots.map((x, i) => `<span><i style="background:${color(i)}"></i>${esc(x.name)}</span>`).join('')}</p>
      <ul class="wbars">${bars}</ul>
      <p class="note">みんなの希望点。明るい所が入った先。</p>
    </details>
    <div class="actions">
      <button class="btn primary big" data-act="reshuffle">引き直す</button>
      <button class="btn ghost" data-act="share-result">共有</button>
      <button class="btn ghost" data-act="reopen">入力にもどす</button>
      <button class="btn text danger" data-act="delete">この記録を消す</button>
    </div>`;
}

// 共有するのは割り当ての顔ぶれと最小値だけ（一人ひとりの希望点は入れない）
function shareText(s) {
  const nameOf = Object.fromEntries(s.members.map((m) => [m.id, m.name]));
  const parts = s.slots.map((x) => [x.name, s.results.filter((r) => r.slotId === x.id).map((r) => nameOf[r.memberId])])
    .filter(([, names]) => names.length).map(([slot, names]) => `${slot}＝${names.join('・')}`);
  return `${s.title}: ${parts.join('／')}（一番低い人でも ${summary(s).min} 点／${BUDGET} 点）。HIGH FLOOR で決めました。`;
}

// ---------- 押したとき ----------

function updateSoundBtn() {
  $('sound-btn').textContent = settings.sound ? '音 オン' : '音 オフ';
  $('sound-btn').setAttribute('aria-pressed', settings.sound);
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const st = history.state || {};
  const s = st.id && findSession(st.id);
  const d = createDraft;
  const i = +b.dataset.i;
  switch (b.dataset.act) {
    case 'back': history.back(); break;
    case 'sound':
      settings.sound = !settings.sound;
      save('settings', { v: 1, sound: settings.sound });
      setAudioSession(settings.sound);
      updateSoundBtn();
      if (settings.sound) { sound.wake(); sound.click(); }
      break;
    case 'new': createDraft = newDraft(); sound.click(); go({ s: 'create' }); break;
    case 'open': {
      const t = findSession(b.dataset.id);
      sound.click();
      go({ s: t.results ? 'result' : 'session', id: t.id });
      break;
    }
    case 'template': {
      const t = TEMPLATES.find((x) => x.name === b.dataset.name);
      d.template = t.name; d.slots = fromTemplate(t);
      sound.click(); render();
      break;
    }
    case 'cap': {
      const c = d.slots[i].capacity + +b.dataset.d;
      if (c < LIMITS.capacity[0] || c > LIMITS.capacity[1]) { sound.bump(); break; }
      d.slots[i].capacity = c; sound.click(b.dataset.d > 0 ? 2 : 0); render();
      break;
    }
    case 'add-slot':
      if (d.slots.length >= LIMITS.slots[1]) { sound.bump(); break; }
      d.slots.push({ name: '', capacity: 1 }); sound.click(2); render();
      break;
    case 'del-slot':
      if (d.slots.length <= LIMITS.slots[0]) { sound.bump(); break; }
      d.slots.splice(i, 1); sound.remove(); render();
      break;
    case 'add-member':
      if (d.members.length >= LIMITS.members[1]) { sound.bump(); break; }
      d.members.push(''); sound.click(2); render();
      break;
    case 'del-member':
      if (d.members.length <= LIMITS.members[0]) { sound.bump(); break; }
      d.members.splice(i, 1); sound.remove(); render();
      break;
    case 'start': startSession(); break;
    case 'member': memberSheet(s, s.members.find((m) => m.id === b.dataset.member)); break;
    case 'handoff': sound.click(); go({ s: 'handoff', id: s.id, member: b.dataset.member }); break;
    case 'allocate': askAllocate(s); break;
    case 'delete': askDelete(s); break;
    case 'yes':
      startWish(s, s.members.find((m) => m.id === st.member));
      sound.yes();
      go({ s: 'input', id: s.id, member: st.member }, true);
      break;
    case 'mode':
      wish.mode = b.dataset.mode;
      if (wish.mode === 'easy') wish.points = fromMarks(wish.marks);
      sound.click(); render();
      break;
    case 'mark':
      wish.marks[i] = b.dataset.mark;
      wish.points = fromMarks(wish.marks);
      sound.click(3 - MARKS.indexOf(b.dataset.mark)); render();
      break;
    case 'step': {
      const next = setPoint(wish.points, i, wish.points[i] + +b.dataset.d);
      if (next[i] === wish.points[i]) { sound.bump(); break; }
      wish.points = next; sound.click(b.dataset.d > 0 ? 2 : 0); render();
      break;
    }
    case 'even': wish.points = evenSplit(s.slots.length); sound.click(); render(); break;
    case 'rest':
      if (!remaining(wish.points)) { sound.bump(); break; }
      wish.points = spendRemainder(wish.points); sound.click(2); render();
      break;
    case 'submit': submitWish(s); break;
    case 'blind-next': {
      const next = s.members.find((m) => !m.points);
      sound.click();
      if (next) go({ s: 'handoff', id: s.id, member: next.id }, true);
      else history.back();   // 手渡しの前の「入力のようす」へ
      break;
    }
    case 'reshuffle': decide(s, s.seed + 1); sound.shuffle(); render(); break;
    case 'share-result': sound.click(); WebAppKit.share({ text: shareText(s) }); break;
    case 'reopen':
      openSheet('入力にもどしますか？', '結果を消して、希望の入力にもどします。入れた希望は残ります。', [
        { label: '入力にもどす', kind: 'primary', fn: () => {
          s.results = null; touch(s); sound.remove();
          if (st.from === 'session') history.back(); else go({ s: 'session', id: s.id }, true);
        } },
        { label: 'やめる' },
      ]);
      break;
  }
});

updateSoundBtn();
if (!history.state) history.replaceState({ s: 'home' }, '');
render();

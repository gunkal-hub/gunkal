// 뉴건즈 홈페이지판: 계정(아이디·비번 / 비회원), 아이디·비번 찾기 메일, 킬뎃·기록, 계급 랭킹, Firebase 온라인 방
import CONFIG from './config.js';

const $ = id => document.getElementById(id);
const NG = window.NG, NET = NG.NET;

/* ---------------- 계급 ---------------- */
const TIERS = ['아이언', '브론즈', '실버', '골드', '플래티넘', '에메랄드', '다이아몬드'];
const DIVS = ['IV', 'III', 'II', 'I'];
export const RANKS = [...TIERS.flatMap(t => DIVS.map(d => `${t} ${d}`)), '마스터', '그랜드마스터', '챌린저'];
const TOP = RANKS.length - 1;
const PROMO = 100;   // 한 단계 올라가는 데 필요한 점수
const TIER_COLOR = ['#8a7f78', '#b07a4f', '#aeb8c4', '#e7b64a', '#4fc1b0', '#34c27a', '#7aa8ff', '#c27aff', '#ff6b6b', '#ffd36b'];
const rankColor = i => TIER_COLOR[i >= 28 ? 7 + (i - 28) : Math.floor(i / 4)];
const rankName = i => RANKS[Math.max(0, Math.min(TOP, i | 0))];
NET.hooks.rankName = rankName;

// 철권식 점수: 계급 차이(단계 4개 = 1티어)를 보고 얻고 잃는 점수를 정함
//  · 예상대로 끝난 판(높은 사람이 이김)은 차이가 클수록 적게 얻고 적게 잃음
//  · 비슷한 계급끼리는 크게 얻고 크게 잃음
//  · 이변(낮은 사람이 이김)은 차이가 클수록 이긴 쪽이 더 얻고 진 쪽이 더 잃음
export function rankDelta(myIdx, oppIdx, won) {
  const gap = Math.abs(myIdx - oppIdx) / 4;
  const upset = won ? oppIdx > myIdx : oppIdx < myIdx;
  const mult = upset ? 1 + Math.min(1, gap * 0.5) : Math.max(0.2, 1 - gap * 0.35);
  return Math.round((won ? 30 : -24) * mult);
}
export function applyRank(idx, pts, delta) {
  pts += delta;
  let note = '';
  while (pts >= PROMO && idx < TOP) { pts -= PROMO; idx++; note = '승급!'; }
  if (pts < 0) {
    if (idx > 0) { idx--; pts = Math.max(0, PROMO + pts); note = '강등'; }
    else pts = 0;
  }
  return { idx, pts, note };
}

/* ---------------- Firebase ---------------- */
const configured = !!(CONFIG && CONFIG.apiKey && !/^여기/.test(CONFIG.apiKey) && CONFIG.databaseURL);
let F = null, auth = null, fs = null, db = null, profile = null;

function setBar() {
  const u = auth && auth.currentUser;
  const name = profile ? profile.id : u && u.isAnonymous ? '비회원' : '로그인 안 함';
  $('acctName').textContent = name;
  $('acctRank').textContent = profile ? `${rankName(profile.idx)} · ${profile.pts}점` : '';
  $('acctRank').style.color = profile ? rankColor(profile.idx) : '';
  $('btnLogin').hidden = !!profile;
  $('btnLogout').hidden = !(u);
  $('btnMe').hidden = !profile;
  NET.acct = profile ? { u: profile.id, r: profile.idx, p: profile.pts } : u ? { u: '비회원', g: 1 } : null;
  if (NET.room && NET.acct) NET.room.presence({ acct: NET.acct }).catch(() => {});
}

/* RTDB로 만든 방: Claude 방 기능과 같은 모양(join / presence / peers / onPeers / leave) */
function mkRoom(path) {
  const tab = Math.random().toString(36).slice(2, 8);
  let my = {}, map = {}, cache = null, myKey = null, timer = null, closed = false;
  const ls = new Set();
  const keyNow = () => auth.currentUser ? `${auth.currentUser.uid}_${tab}` : null;
  const notify = () => { cache = null; const ch = { peers: api.peers(), joined: [], left: [], updated: [] }; ls.forEach(f => { try { f(ch); } catch (_) {} }); };
  const unsub = F.onValue(F.ref(db, path), snap => { map = snap.val() || {}; notify(); });
  function flush() {
    timer = null;
    const k = keyNow(); if (!k || closed) return;
    const r = F.ref(db, `${path}/${k}`);
    if (k !== myKey) { myKey = k; F.onDisconnect(r).remove(); }
    if (Object.keys(my).length) F.set(r, my).catch(() => {}); else F.remove(r).catch(() => {});
  }
  const api = {
    name: path,
    async presence(patch) {
      for (const k in patch) { if (patch[k] === null) delete my[k]; else my[k] = patch[k]; }
      cache = null;
      if (!timer) timer = setTimeout(flush, 50);   // 초당 20번 보냄 (무료 요금제 데이터량을 아끼려고)
    },
    peers() {
      if (cache) return cache;
      const uid = auth.currentUser && auth.currentUser.uid, out = [];
      const mk = keyNow();
      for (const k in map) {
        if (k === mk) continue;
        out.push({ peer: k, by: null, isMe: !!uid && k.startsWith(uid + '_'), sameTab: false, kind: 'viewer', guest: false, presence: map[k] || {}, updatedAt: 0 });
      }
      if (mk) out.push({ peer: mk, by: null, isMe: true, sameTab: true, kind: 'viewer', guest: false, presence: { ...my }, updatedAt: 0 });
      return (cache = out);
    },
    onPeers(f) { ls.add(f); setTimeout(() => f({ peers: api.peers(), joined: [], left: [], updated: [] }), 0); return () => ls.delete(f); },
    connected: () => true,
    async leave() { closed = true; unsub(); ls.clear(); const k = keyNow(); if (k) await F.remove(F.ref(db, `${path}/${k}`)).catch(() => {}); },
    emit: async () => {}, on: () => () => {},
  };
  return api;
}

async function loadProfile(u) {
  if (!u || u.isAnonymous) { profile = null; return; }
  const snap = await F.getDoc(F.doc(fs, 'players', u.uid));
  profile = snap.exists() ? snap.data() : null;
  if (!profile && u.displayName) {   // 가입 도중 끊긴 경우 다시 만들어 줌
    profile = newProfile(u.displayName);
    await F.setDoc(F.doc(fs, 'players', u.uid), profile);
  }
}
const newProfile = id => ({ id, idx: 0, pts: 0, score: 0, kills: 0, deaths: 0, wins: 0, losses: 0, t: Date.now() });
const score = p => p.idx * 10000 + p.pts;
async function sha(t) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t.trim().toLowerCase()));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/* ---------------- 대화상자 ---------------- */
const dlg = $('dlg');
function openPane(name) {
  for (const el of dlg.querySelectorAll('[data-pane]')) el.hidden = el.dataset.pane !== name;
  dlg.querySelectorAll('.err').forEach(e => { e.textContent = ''; });
  if (!dlg.open) dlg.showModal();
  if (document.pointerLockElement) document.exitPointerLock();
  const first = dlg.querySelector(`[data-pane="${name}"] input`); if (first) setTimeout(() => first.focus(), 30);
}
const err = (pane, t) => { const e = dlg.querySelector(`[data-pane="${pane}"] .err`); if (e) e.textContent = t; };
const busy = (btn, on) => { btn.disabled = on; };
const KO_ERR = {
  'auth/invalid-credential': '아이디 또는 비밀번호가 틀려요',
  'auth/wrong-password': '아이디 또는 비밀번호가 틀려요',
  'auth/user-not-found': '아이디 또는 비밀번호가 틀려요',
  'auth/email-already-in-use': '이미 가입된 이메일이에요',
  'auth/invalid-email': '이메일 형식이 아니에요',
  'auth/weak-password': '비밀번호는 6자 이상이어야 해요',
  'auth/too-many-requests': '너무 많이 시도했어요. 잠시 뒤 다시 해 주세요',
  'auth/network-request-failed': '인터넷 연결을 확인해 주세요',
  'auth/operation-not-allowed': '서버 설정에서 이 로그인 방식이 꺼져 있어요 (README 참고)',
  'auth/expired-action-code': '링크가 만료됐어요. 다시 찾기를 해 주세요',
  'auth/invalid-action-code': '이미 사용했거나 잘못된 링크예요',
};
const koErr = e => KO_ERR[e && e.code] || '잠시 뒤 다시 해 주세요 (' + ((e && e.code) || e) + ')';

function wireUI() {
  $('btnLogin').addEventListener('click', () => openPane(configured ? 'login' : 'setup'));
  $('btnRank').addEventListener('click', () => configured ? showRanking() : openPane('setup'));
  $('btnMe').addEventListener('click', showMe);
  $('btnLogout').addEventListener('click', async () => { if (NET.room) return NG.showMsg('방을 나간 뒤 로그아웃할 수 있어요', 90); await F.signOut(auth); });
  dlg.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); openPane(b.dataset.go); }));
  dlg.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); dlg.close(); }));
  dlg.addEventListener('keydown', e => e.stopPropagation());

  $('fLogin').addEventListener('submit', async e => {
    e.preventDefault(); const btn = e.submitter || $('fLogin').querySelector('button[type=submit]'); busy(btn, true);
    try {
      let who = $('liId').value.trim(); const pw = $('liPw').value;
      if (!who || !pw) throw { code: 'empty' };
      if (!who.includes('@')) {
        const s = await F.getDoc(F.doc(fs, 'usernames', who.toLowerCase()));
        if (!s.exists()) throw { code: 'auth/invalid-credential' };
        who = s.data().email;
      }
      await F.signInWithEmailAndPassword(auth, who, pw);
      dlg.close(); $('fLogin').reset();
    } catch (x) { err('login', x.code === 'empty' ? '아이디와 비밀번호를 입력하세요' : koErr(x)); }
    busy(btn, false);
  });
  $('fSignup').addEventListener('submit', async e => {
    e.preventDefault(); const btn = $('fSignup').querySelector('button[type=submit]'); busy(btn, true);
    try {
      const id = $('suId').value.trim().toLowerCase(), pw = $('suPw').value, pw2 = $('suPw2').value, email = $('suEmail').value.trim();
      if (!/^[a-z0-9_]{3,16}$/.test(id)) throw { msg: '아이디는 영어 소문자·숫자·밑줄 3~16자예요' };
      if (pw.length < 6) throw { msg: '비밀번호는 6자 이상이어야 해요' };
      if (pw !== pw2) throw { msg: '비밀번호 확인이 달라요' };
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw { msg: '아이디·비번 찾기에 쓸 이메일을 정확히 적어 주세요' };
      if ((await F.getDoc(F.doc(fs, 'usernames', id))).exists()) throw { msg: '이미 있는 아이디예요' };
      const cred = await F.createUserWithEmailAndPassword(auth, email, pw);
      await F.updateProfile(cred.user, { displayName: id });
      await F.setDoc(F.doc(fs, 'usernames', id), { uid: cred.user.uid, email });
      await F.setDoc(F.doc(fs, 'emails', await sha(email)), { id, uid: cred.user.uid });
      profile = newProfile(id);
      await F.setDoc(F.doc(fs, 'players', cred.user.uid), profile);
      setBar(); dlg.close(); $('fSignup').reset(); NG.showMsg(`${id}님 환영해요! 아이언 IV부터 시작`, 150);
    } catch (x) { err('signup', x.msg || koErr(x)); }
    busy(btn, false);
  });
  $('fFind').addEventListener('submit', async e => {
    e.preventDefault(); const btn = $('fFind').querySelector('button[type=submit]'); busy(btn, true);
    try {
      const email = $('fdEmail').value.trim();
      if (!email) throw { msg: '가입할 때 적은 이메일을 입력하세요' };
      await F.sendPasswordResetEmail(auth, email, { url: location.origin + location.pathname });
      err('find', ''); $('fdOk').hidden = false;
    } catch (x) {
      // 가입 안 된 이메일이어도 똑같이 안내 (누가 가입했는지 알 수 없게)
      if (x.code === 'auth/user-not-found') $('fdOk').hidden = false; else err('find', x.msg || koErr(x));
    }
    busy(btn, false);
  });
  $('fReset').addEventListener('submit', async e => {
    e.preventDefault(); const btn = $('fReset').querySelector('button[type=submit]'); busy(btn, true);
    try {
      const pw = $('rsPw').value; if (pw.length < 6) throw { msg: '비밀번호는 6자 이상이어야 해요' };
      await F.confirmPasswordReset(auth, resetCode, pw);
      history.replaceState(null, '', location.pathname);
      $('rsDone').hidden = false; $('fReset').querySelector('button[type=submit]').hidden = true;
    } catch (x) { err('reset', x.msg || koErr(x)); }
    busy(btn, false);
  });
}

/* 메일 속 링크를 누르고 이 페이지로 돌아오면: 아이디를 보여 주고 새 비밀번호를 정함 */
let resetCode = null;
async function handleResetLink() {
  const q = new URLSearchParams(location.search);
  if (q.get('mode') !== 'resetPassword' || !q.get('oobCode')) return;
  resetCode = q.get('oobCode');
  openPane('reset'); $('rsId').textContent = '확인 중…';
  try {
    const email = await F.verifyPasswordResetCode(auth, resetCode);
    const s = await F.getDoc(F.doc(fs, 'emails', await sha(email)));
    $('rsId').textContent = s.exists() ? s.data().id : '(아이디 없음 · 이메일로 로그인하세요)';
  } catch (x) { $('rsId').textContent = '-'; err('reset', koErr(x)); }
}

/* ---------------- 기록 ---------------- */
// 한 판(2선승)이 끝날 때 불림. 화면에 띄울 짧은 글을 돌려줌
NET.hooks.match = ({ won, kills, deaths, opp }) => {
  const u = auth && auth.currentUser;
  if (!profile || !u) return '';
  const ranked = opp && !opp.g && typeof opp.r === 'number';
  const before = { idx: profile.idx, pts: profile.pts };
  let delta = 0, note = '';
  if (ranked) {
    delta = rankDelta(profile.idx, opp.r, won);
    const r = applyRank(profile.idx, profile.pts, delta); profile.idx = r.idx; profile.pts = r.pts; note = r.note;
  }
  profile.kills += kills; profile.deaths += deaths; if (won) profile.wins++; else profile.losses++;
  profile.score = score(profile); profile.t = Date.now();
  const rec = { t: Date.now(), opp: String((opp && opp.u) || '상대').slice(0, 16), oppRank: ranked ? opp.r : -1, won, kills, deaths, delta, idx: profile.idx, pts: profile.pts, from: before.idx };
  F.setDoc(F.doc(fs, 'players', u.uid), profile).catch(() => NG.showMsg('기록 저장 실패 · 인터넷 연결을 확인하세요', 120));
  F.addDoc(F.collection(fs, 'players', u.uid, 'matches'), rec).catch(() => {});
  setBar();
  if (!ranked) return '· 비회원 상대라 계급 점수는 없어요';
  return `${delta >= 0 ? '+' : ''}${delta}점 · ${note ? note + ' ' : ''}${rankName(profile.idx)}`;
};
NET.hooks.beforeJoin = async () => {
  if (!auth.currentUser) await F.signInAnonymously(auth);   // 비회원도 방에 들어갈 수 있게
  setBar();
};

const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kd = p => p.deaths ? (p.kills / p.deaths).toFixed(2) : p.kills ? `${p.kills}.00` : '-';
const rankCell = i => `<span class="rk" style="color:${rankColor(i)}">${esc(rankName(i))}</span>`;
async function showRanking() {
  openPane('rank'); const box = $('rankList'); box.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const snap = await F.getDocs(F.query(F.collection(fs, 'players'), F.orderBy('score', 'desc'), F.limit(50)));
    const rows = []; let i = 0;
    snap.forEach(d => { const p = d.data(); i++; rows.push(`<tr${profile && p.id === profile.id ? ' class="mine"' : ''}><td class="num">${i}</td><td>${esc(p.id)}</td><td>${rankCell(p.idx)}</td><td class="num">${p.pts}</td><td class="num">${p.kills}/${p.deaths}</td><td class="num">${kd(p)}</td><td class="num">${p.wins}승 ${p.losses}패</td></tr>`); });
    box.innerHTML = rows.length ? `<table><thead><tr><th>순위</th><th>아이디</th><th>계급</th><th>점수</th><th>킬/데스</th><th>킬뎃</th><th>전적</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '<p class="muted">아직 기록이 없어요. 첫 판을 해 보세요!</p>';
  } catch (x) { box.innerHTML = `<p class="err">${esc(koErr(x))}</p>`; }
}
async function showMe() {
  if (!profile) return openPane('login');
  openPane('me');
  const p = profile;
  $('meCard').innerHTML = `<div class="mebig">${rankCell(p.idx)}<span class="num">${p.pts} / ${PROMO}점</span></div>
    <div class="bar2"><i style="width:${Math.min(100, p.pts)}%;background:${rankColor(p.idx)}"></i></div>
    <p class="muted">${esc(p.id)} · 킬 ${p.kills} · 데스 ${p.deaths} · 킬뎃 ${kd(p)} · ${p.wins}승 ${p.losses}패</p>`;
  const box = $('meList'); box.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const snap = await F.getDocs(F.query(F.collection(fs, 'players', auth.currentUser.uid, 'matches'), F.orderBy('t', 'desc'), F.limit(15)));
    const rows = [];
    snap.forEach(d => { const m = d.data(); rows.push(`<tr><td>${new Date(m.t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td class="${m.won ? 'win' : 'lose'}">${m.won ? '승' : '패'}</td><td>${esc(m.opp)}${m.oppRank >= 0 ? ' · ' + rankCell(m.oppRank) : ' · 비회원'}</td><td class="num">${m.kills}/${m.deaths}</td><td class="num">${m.oppRank >= 0 ? (m.delta >= 0 ? '+' : '') + m.delta : '-'}</td></tr>`); });
    box.innerHTML = rows.length ? `<table><thead><tr><th>언제</th><th>결과</th><th>상대</th><th>킬/데스</th><th>점수</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '<p class="muted">아직 대전 기록이 없어요</p>';
  } catch (x) { box.innerHTML = `<p class="err">${esc(koErr(x))}</p>`; }
}

/* ---------------- 시작 ---------------- */
wireUI();
// 점수표 (README와 같은 숫자)
$('rankRule').innerHTML = (() => {
  const ex = [[8, 8], [8, 12], [8, 16], [12, 8], [16, 8]].map(([a, b]) => `<tr><td>${esc(rankName(a))} vs ${esc(rankName(b))}</td><td class="num">${rankDelta(a, b, true) > 0 ? '+' : ''}${rankDelta(a, b, true)}</td><td class="num">${rankDelta(a, b, false)}</td></tr>`).join('');
  return `<table><thead><tr><th>내 계급 vs 상대</th><th>이기면</th><th>지면</th></tr></thead><tbody>${ex}</tbody></table>`;
})();
if (!configured) {
  $('acctName').textContent = '서버 설정 전';
  $('btnLogin').textContent = '설정 안내';
  window.__ngWebResolve(null);
} else {
  try {
    F = await import('./fb.js');
    const app = F.initializeApp(CONFIG);
    auth = F.getAuth(app); fs = F.getFirestore(app); db = F.getDatabase(app);
    try { auth.languageCode = 'ko'; } catch (_) {}
    F.onAuthStateChanged(auth, async u => { try { await loadProfile(u); } catch (_) { profile = null; } setBar(); });
    const lobby = mkRoom('lobby');
    lobby.join = async name => mkRoom('rooms/' + name);
    window.__ngWebResolve(lobby);
    handleResetLink();
  } catch (x) {
    console.error(x);
    $('acctName').textContent = '서버 연결 실패';
    window.__ngWebResolve(null);
  }
}

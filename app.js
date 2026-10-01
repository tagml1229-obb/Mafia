import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeAuth, browserSessionPersistence, signInAnonymously, onAuthStateChanged, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getDatabase, connectDatabaseEmulator, ref, get, set, update, push, remove, onValue,
  query, limitToLast, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// ───────── 설정 ─────────
const DURATION = { night: 40, day: 90, vote: 30 }; // 초
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 12;

const ROLES = {
  mafia:   { name: "마피아", emoji: "🔪", desc: "밤마다 한 명을 골라 제거해요. 마피아끼리 비밀 채팅을 할 수 있어요.", act: "오늘 밤 제거할 사람을 고르세요" },
  doctor:  { name: "의사",   emoji: "💉", desc: "밤마다 한 명을 골라 마피아의 공격에서 살려요. 자기 자신도 고를 수 있어요.", act: "오늘 밤 살릴 사람을 고르세요" },
  police:  { name: "경찰",   emoji: "🔎", desc: "밤마다 한 명을 조사해서 마피아인지 알아내요.", act: "오늘 밤 조사할 사람을 고르세요" },
  citizen: { name: "시민",   emoji: "🙂", desc: "특별한 능력은 없어요. 낮에 토론하고 투표로 마피아를 찾아내세요." },
};
const PHASE_LABEL = { lobby: "대기실", night: "🌙 밤", day: "☀️ 낮 토론", vote: "🗳️ 투표", ended: "게임 종료" };

// ?emu 를 붙이면 로컬 Firebase 에뮬레이터에 연결 (개발/테스트용)
const EMU = new URLSearchParams(location.search).has("emu");
const config = EMU
  ? { apiKey: "demo-key", projectId: "demo-mafia", databaseURL: "https://demo-mafia-default-rtdb.firebaseio.com" }
  : firebaseConfig;
const configured = EMU || !String(config.apiKey || "").startsWith("YOUR");

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ───────── 상태 ─────────
const S = {
  uid: null, code: null, offset: 0,
  meta: null, players: {}, myRole: null, myAction: null, votes: {},
  chat: [], priv: [], mafia: [], tab: "all",
};
let unsubs = [];
let mafiaUnsub = null;
let advancing = false;

let db, auth;
if (configured) {
  const app = initializeApp(config);
  // 탭마다 다른 익명 계정 → 한 브라우저에서 탭 여러 개로 테스트 가능
  auth = initializeAuth(app, { persistence: browserSessionPersistence });
  db = getDatabase(app);
  if (EMU) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectDatabaseEmulator(db, "127.0.0.1", 9000);
  }
} else {
  $("setup-warning").classList.remove("hidden");
  $("create").disabled = $("join").disabled = true;
}

const now = () => Date.now() + S.offset;
const roomRef = (path = "") => ref(db, `rooms/${S.code}${path ? "/" + path : ""}`);
const isHost = () => S.meta?.host === S.uid;
const me = () => S.players[S.uid];
const nameOf = (uid) => S.players[uid]?.name ?? "???";

// ───────── 로그인 & 재접속 ─────────
if (configured) {
  $("name").value = localStorage.getItem("mafia-name") || "";
  onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    S.uid = user.uid;
    onValue(ref(db, ".info/serverTimeOffset"), (s) => (S.offset = s.val() || 0));
    // 새로고침했을 때 원래 있던 방으로 복귀
    const saved = sessionStorage.getItem("mafia-room");
    if (saved) {
      const p = await get(ref(db, `rooms/${saved}/players/${S.uid}`)).catch(() => null);
      if (p?.exists()) enterRoom(saved);
      else sessionStorage.removeItem("mafia-room");
    }
  });
  signInAnonymously(auth).catch((e) => showHomeError("로그인 실패: Firebase에서 익명 로그인을 켰는지 확인하세요. (" + e.code + ")"));
}

function showHomeError(msg) { $("home-error").textContent = msg; }

function readName() {
  const name = $("name").value.trim();
  if (!name) { showHomeError("닉네임을 입력하세요."); return null; }
  localStorage.setItem("mafia-name", name);
  return name;
}

$("create").onclick = async () => {
  const name = readName();
  if (!name || !S.uid) return;
  try {
    let code;
    for (let i = 0; i < 10; i++) {
      code = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)]).join("");
      if (!(await get(ref(db, `rooms/${code}/meta`))).exists()) break;
    }
    await set(ref(db, `rooms/${code}/meta`), { host: S.uid, phase: "lobby", day: 0, createdAt: serverTimestamp() });
    await set(ref(db, `rooms/${code}/players/${S.uid}`), { name, alive: true, joinedAt: serverTimestamp() });
    enterRoom(code);
  } catch (e) {
    showHomeError("방 만들기 실패: " + e.message);
  }
};

$("join").onclick = async () => {
  const name = readName();
  const code = $("code").value.trim().toUpperCase();
  if (!name || !S.uid) return;
  if (code.length !== 4) return showHomeError("방 코드 4자리를 입력하세요.");
  try {
    const meta = (await get(ref(db, `rooms/${code}/meta`))).val();
    if (!meta) return showHomeError("그런 방이 없어요.");
    const mine = await get(ref(db, `rooms/${code}/players/${S.uid}`));
    if (!mine.exists()) {
      if (meta.phase !== "lobby") return showHomeError("이미 게임이 진행 중인 방이에요.");
      const others = (await get(ref(db, `rooms/${code}/players`))).size;
      if (others >= MAX_PLAYERS) return showHomeError(`방이 꽉 찼어요. (최대 ${MAX_PLAYERS}명)`);
      await set(ref(db, `rooms/${code}/players/${S.uid}`), { name, alive: true, joinedAt: serverTimestamp() });
    }
    enterRoom(code);
  } catch (e) {
    showHomeError(e.code === "PERMISSION_DENIED" ? "이 방에 들어갈 수 없어요." : "참가 실패: " + e.message);
  }
};
$("code").addEventListener("keydown", (e) => e.key === "Enter" && $("join").click());

// ───────── 방 입장 & 실시간 구독 ─────────
function enterRoom(code) {
  stopListening();
  Object.assign(S, { code, meta: null, players: {}, myRole: null, myAction: null, votes: {}, chat: [], priv: [], mafia: [], tab: "all" });
  sessionStorage.setItem("mafia-room", code);
  $("home").classList.add("hidden");
  $("room").classList.remove("hidden");
  $("room-code").textContent = code;

  const warn = (e) => console.warn(e.message);
  const listen = (r, fn) => unsubs.push(onValue(r, fn, warn));
  const toList = (s) => {
    const list = [];
    s.forEach((c) => { list.push({ id: c.key, ...c.val() }); });
    return list;
  };

  listen(roomRef("meta"), (s) => {
    S.meta = s.val();
    if (!S.meta) return exitRoom("방이 사라졌어요.");
    render();
  });
  listen(roomRef("players"), (s) => {
    S.players = s.val() || {};
    if (!S.players[S.uid]) return exitRoom("방에서 내보내졌어요.");
    render();
  });
  listen(roomRef(`roles/${S.uid}`), (s) => {
    S.myRole = s.val();
    if (S.myRole?.role === "mafia" && !mafiaUnsub) {
      mafiaUnsub = onValue(query(roomRef("mafiachat"), limitToLast(100)), (m) => { S.mafia = toList(m); render(); }, warn);
    } else if (S.myRole?.role !== "mafia" && mafiaUnsub) {
      mafiaUnsub(); mafiaUnsub = null; S.mafia = [];
      if (S.tab === "mafia") S.tab = "all";
    }
    render();
  });
  listen(roomRef(`actions/${S.uid}`), (s) => { S.myAction = s.val(); render(); });
  listen(roomRef("votes"), (s) => { S.votes = s.val() || {}; render(); });
  listen(query(roomRef("chat"), limitToLast(150)), (s) => { S.chat = toList(s); render(); });
  listen(roomRef(`private/${S.uid}`), (s) => { S.priv = toList(s).map((m) => ({ ...m, priv: true })); render(); });
}

function stopListening() {
  unsubs.forEach((u) => u());
  unsubs = [];
  if (mafiaUnsub) { mafiaUnsub(); mafiaUnsub = null; }
}

function exitRoom(msg = "") {
  stopListening();
  sessionStorage.removeItem("mafia-room");
  S.code = null;
  document.body.className = "";
  $("room").classList.add("hidden");
  $("home").classList.remove("hidden");
  showHomeError(msg);
}

// ───────── 방장: 게임 진행 ─────────
// 서버가 따로 없으므로 방장 브라우저가 판정과 진행을 맡는다.
setInterval(() => {
  renderTimer();
  if (!S.code || !isHost() || advancing) return;
  const end = S.meta?.phaseEnd;
  if (end && now() >= end) advance();
}, 500);

async function advance() {
  if (advancing) return;
  advancing = true;
  try {
    const phase = S.meta.phase;
    if (phase === "night") await resolveNight();
    else if (phase === "day") await startVote();
    else if (phase === "vote") await resolveVote();
  } catch (e) {
    console.error(e);
    alert("진행 중 오류: " + e.message);
  } finally {
    advancing = false;
  }
}

function sys(up, text) {
  const key = push(roomRef("chat")).key;
  up[`chat/${key}`] = { sys: true, text, ts: serverTimestamp() };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function winnerOf(players, roles) {
  const alive = Object.keys(players).filter((u) => players[u].alive);
  const mafia = alive.filter((u) => roles[u]?.role === "mafia").length;
  if (mafia === 0) return "citizen";
  if (mafia >= alive.length - mafia) return "mafia";
  return null;
}

function endGame(up, winner, roles) {
  up["meta/phase"] = "ended";
  up["meta/phaseEnd"] = null;
  up["meta/winner"] = winner;
  up["meta/reveal"] = Object.fromEntries(Object.entries(roles).map(([u, r]) => [u, r.role]));
  sys(up, winner === "mafia" ? "🔪 마피아 승리! 마피아가 마을을 장악했습니다." : "🎉 시민 승리! 마피아를 모두 찾아냈습니다.");
}

async function startGame() {
  const uids = Object.keys(S.players);
  if (uids.length < MIN_PLAYERS) return alert(`최소 ${MIN_PLAYERS}명이 필요해요.`);
  const n = uids.length;
  const mafiaCount = n >= 9 ? 3 : n >= 6 ? 2 : 1;
  const deck = [...Array(mafiaCount).fill("mafia"), "doctor", "police"];
  while (deck.length < n) deck.push("citizen");
  shuffle(deck);

  const roles = {};
  uids.forEach((u, i) => (roles[u] = { role: deck[i] }));
  const mafiaUids = uids.filter((u) => roles[u].role === "mafia");
  for (const m of mafiaUids) {
    roles[m].mates = Object.fromEntries(mafiaUids.filter((x) => x !== m).map((x) => [x, S.players[x].name]));
  }

  const up = {
    roles, actions: null, votes: null, mafiachat: null, private: null,
    "meta/phase": "night", "meta/day": 1, "meta/phaseEnd": now() + DURATION.night * 1000,
    "meta/winner": null, "meta/reveal": null,
  };
  uids.forEach((u) => (up[`players/${u}/alive`] = true));
  sys(up, `게임 시작! ${n}명 중 마피아는 ${mafiaCount}명입니다.`);
  sys(up, "🌙 1일차 밤이 되었습니다. 마피아, 의사, 경찰은 능력을 사용하세요.");
  await update(roomRef(), up);
}

async function resolveNight() {
  const [rs, as, ps] = await Promise.all([get(roomRef("roles")), get(roomRef("actions")), get(roomRef("players"))]);
  const roles = rs.val() || {}, acts = as.val() || {}, players = ps.val() || {};
  const alive = (u) => players[u]?.alive === true;
  const withRole = (role) => Object.keys(roles).filter((u) => roles[u].role === role && alive(u));

  // 마피아: 가장 많이 지목된 사람 (동률이면 마지막에 고른 쪽)
  const tally = {};
  for (const m of withRole("mafia")) {
    const a = acts[m];
    if (!a || !alive(a.target)) continue;
    const t = (tally[a.target] ??= { n: 0, ts: 0 });
    t.n++;
    t.ts = Math.max(t.ts, a.ts || 0);
  }
  const kill = Object.entries(tally).sort((a, b) => b[1].n - a[1].n || b[1].ts - a[1].ts)[0]?.[0];
  const doctor = withRole("doctor")[0];
  const save = doctor && acts[doctor]?.target;
  const police = withRole("police")[0];
  const inspect = police && acts[police]?.target;

  const up = { actions: null };
  if (police && inspect) {
    const key = push(roomRef(`private/${police}`)).key;
    const isMafia = roles[inspect]?.role === "mafia";
    up[`private/${police}/${key}`] = {
      text: `🔎 조사 결과: ${players[inspect].name}님은 ${isMafia ? "마피아입니다!" : "마피아가 아닙니다."}`,
      ts: serverTimestamp(),
    };
  }

  const day = S.meta.day;
  let dead = null;
  if (kill && kill !== save) {
    dead = kill;
    players[kill].alive = false;
    up[`players/${kill}/alive`] = false;
  }
  sys(up, `☀️ ${day}일차 아침이 밝았습니다. ` +
    (dead ? `밤사이 ${players[dead].name}님이 마피아에게 살해당했습니다.` : "지난밤에는 아무도 죽지 않았습니다."));

  const winner = winnerOf(players, roles);
  if (winner) endGame(up, winner, roles);
  else {
    up["meta/phase"] = "day";
    up["meta/phaseEnd"] = now() + DURATION.day * 1000;
  }
  await update(roomRef(), up);
}

async function startVote() {
  const up = { votes: null, "meta/phase": "vote", "meta/phaseEnd": now() + DURATION.vote * 1000 };
  sys(up, "🗳️ 투표 시간! 마피아로 의심되는 사람에게 투표하세요.");
  await update(roomRef(), up);
}

async function resolveVote() {
  const [rs, vs, ps] = await Promise.all([get(roomRef("roles")), get(roomRef("votes")), get(roomRef("players"))]);
  const roles = rs.val() || {}, votes = vs.val() || {}, players = ps.val() || {};

  const count = {};
  for (const [voter, target] of Object.entries(votes)) {
    if (players[voter]?.alive && players[target]?.alive) count[target] = (count[target] || 0) + 1;
  }
  const sorted = Object.entries(count).sort((a, b) => b[1] - a[1]);
  const up = { votes: null, actions: null };

  if (!sorted.length) sys(up, "아무도 투표하지 않아 처형이 없습니다.");
  else if (sorted[1] && sorted[1][1] === sorted[0][1]) sys(up, "동점이 나와서 아무도 처형되지 않았습니다.");
  else {
    const [target, n] = sorted[0];
    players[target].alive = false;
    up[`players/${target}/alive`] = false;
    sys(up, `⚖️ ${players[target].name}님이 ${n}표로 처형되었습니다.`);
  }

  const winner = winnerOf(players, roles);
  if (winner) endGame(up, winner, roles);
  else {
    const day = S.meta.day + 1;
    up["meta/day"] = day;
    up["meta/phase"] = "night";
    up["meta/phaseEnd"] = now() + DURATION.night * 1000;
    sys(up, `🌙 ${day}일차 밤이 되었습니다.`);
  }
  await update(roomRef(), up);
}

async function backToLobby() {
  const up = {
    roles: null, actions: null, votes: null, mafiachat: null, private: null,
    "meta/phase": "lobby", "meta/day": 0, "meta/phaseEnd": null, "meta/winner": null, "meta/reveal": null,
  };
  Object.keys(S.players).forEach((u) => (up[`players/${u}/alive`] = true));
  sys(up, "대기실로 돌아왔습니다. 방장이 새 게임을 시작할 수 있어요.");
  await update(roomRef(), up);
}

// ───────── 플레이어 행동 ─────────
// 지금 이 사람을 누를 수 있는지
function targetMode() {
  if (!me()?.alive) return null;
  const phase = S.meta?.phase;
  if (phase === "night" && S.myRole && S.myRole.role !== "citizen") return "night";
  if (phase === "vote") return "vote";
  return null;
}
function canTarget(uid) {
  const mode = targetMode();
  if (!mode || !S.players[uid]?.alive) return false;
  if (mode === "vote") return uid !== S.uid;
  const role = S.myRole.role;
  if (role === "mafia") return uid !== S.uid && !S.myRole.mates?.[uid];
  if (role === "police") return uid !== S.uid;
  return true; // 의사는 자기 자신도 가능
}

$("players").onclick = async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const { act, uid } = btn.dataset;
  try {
    if (act === "pick") {
      if (targetMode() === "night") await set(roomRef(`actions/${S.uid}`), { target: uid, ts: serverTimestamp() });
      else await set(roomRef(`votes/${S.uid}`), uid);
    } else if (act === "kick" && confirm(`${nameOf(uid)}님을 내보낼까요?`)) {
      await remove(roomRef(`players/${uid}`));
    }
  } catch (err) {
    console.warn(err);
  }
};

$("host-controls").onclick = (e) => {
  const act = e.target.closest("button")?.dataset.act;
  if (act === "start") startGame().catch((err) => alert(err.message));
  if (act === "lobby") backToLobby().catch((err) => alert(err.message));
  if (act === "leave") {
    remove(roomRef(`players/${S.uid}`)).catch(() => {});
    exitRoom();
  }
};
$("skip").onclick = () => isHost() && advance();
$("room-code").onclick = () => navigator.clipboard?.writeText(S.code);

document.querySelector(".tabs").onclick = (e) => {
  const tab = e.target.closest("[data-tab]")?.dataset.tab;
  if (tab) { S.tab = tab; render(); }
};

$("chat-form").onsubmit = async (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  const path = S.tab === "mafia" ? "mafiachat" : "chat";
  try {
    await push(roomRef(path), { uid: S.uid, name: me()?.name, text, ts: serverTimestamp() });
    input.value = "";
  } catch {
    // 규칙에 막힘 (밤이거나 죽었거나)
  }
};

// ───────── 화면 그리기 ─────────
function render() {
  if (!S.code || !S.meta) return;
  const { phase } = S.meta;
  const role = S.myRole?.role;
  const alive = me()?.alive;
  document.body.className = phase === "night" ? "night" : phase === "day" || phase === "vote" ? "day" : "";

  $("phase").textContent = phase === "lobby" || phase === "ended" ? PHASE_LABEL[phase] : `${S.meta.day}일차 ${PHASE_LABEL[phase]}`;
  $("skip").classList.toggle("hidden", !(isHost() && ["night", "day", "vote"].includes(phase)));

  // 내 직업 카드
  const card = $("role-card");
  if (role && phase !== "lobby") {
    const r = ROLES[role];
    const mates = Object.values(S.myRole.mates || {});
    card.className = `card role ${role}`;
    card.innerHTML = `<div class="emoji">${r.emoji}</div><div>
      <h3>당신은 ${r.name}입니다${alive ? "" : " (사망)"}</h3><p>${r.desc}</p>
      ${mates.length ? `<p>동료 마피아: <b>${mates.map(esc).join(", ")}</b></p>` : ""}</div>`;
  } else card.className = "hidden";

  // 승리 배너
  const banner = $("banner");
  if (phase === "ended") {
    banner.className = `banner ${S.meta.winner}`;
    banner.textContent = S.meta.winner === "mafia" ? "🔪 마피아 승리!" : "🎉 시민 승리!";
  } else banner.className = "hidden";

  // 안내 문구
  let hint = "";
  const count = Object.keys(S.players).length;
  if (phase === "lobby") hint = count < MIN_PLAYERS ? `${MIN_PLAYERS}명 이상 모이면 시작할 수 있어요. 친구에게 방 코드를 알려주세요!` : isHost() ? "준비되면 게임 시작을 누르세요." : "방장이 시작하길 기다리는 중...";
  else if (phase === "ended") hint = isHost() ? "다시 하려면 대기실로 돌아가세요." : "방장이 새 게임을 열 때까지 기다려주세요.";
  else if (!alive) hint = "☠️ 당신은 죽었습니다. 끝까지 관전하세요. (말은 할 수 없어요)";
  else if (phase === "night") hint = role && role !== "citizen" ? ROLES[role].act : "밤입니다. 조용히 아침을 기다리세요...";
  else if (phase === "day") hint = "토론 시간! 채팅으로 누가 마피아인지 이야기해보세요.";
  else if (phase === "vote") hint = "마피아로 의심되는 사람에게 투표하세요. (시간 내 바꿀 수 있어요)";
  $("hint").textContent = hint;

  // 방장 버튼
  let hc = "";
  if (phase === "lobby" && isHost()) hc = `<button class="small primary" style="margin:0;width:auto" data-act="start" ${count < MIN_PLAYERS ? "disabled" : ""}>게임 시작</button>`;
  if (phase === "lobby" && !isHost()) hc = `<button class="small" data-act="leave">나가기</button>`;
  if (phase === "ended" && isHost()) hc = `<button class="small" data-act="lobby">대기실로</button>`;
  $("host-controls").innerHTML = hc;

  // 플레이어 목록
  const voteCount = {};
  Object.values(S.votes).forEach((t) => (voteCount[t] = (voteCount[t] || 0) + 1));
  const picked = targetMode() === "night" ? S.myAction?.target : targetMode() === "vote" ? S.votes[S.uid] : null;
  const reveal = S.meta.reveal || {};
  const mode = targetMode();
  const btnLabel = mode === "vote" ? "투표" : { mafia: "제거", doctor: "치료", police: "조사" }[role];

  $("count").textContent = `(${Object.values(S.players).filter((p) => p.alive).length}/${count})`;
  $("players").innerHTML = Object.entries(S.players)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))
    .map(([uid, p]) => {
      const tags = [];
      if (uid === S.meta.host) tags.push(`<span class="tag">👑 방장</span>`);
      if (uid === S.uid) tags.push(`<span class="tag">나</span>`);
      if (S.myRole?.mates?.[uid] && phase !== "lobby") tags.push(`<span class="tag mafia">🔪 동료</span>`);
      if (phase === "ended" && reveal[uid]) tags.push(`<span class="tag ${reveal[uid] === "mafia" ? "mafia" : ""}">${ROLES[reveal[uid]].emoji} ${ROLES[reveal[uid]].name}</span>`);
      if (phase === "vote" && voteCount[uid]) tags.push(`<span class="tag votes">${voteCount[uid]}표</span>`);
      let btn = "";
      if (canTarget(uid)) btn = `<button class="small" data-act="pick" data-uid="${uid}">${picked === uid ? "✔ " : ""}${btnLabel}</button>`;
      if (phase === "lobby" && isHost() && uid !== S.uid) btn = `<button class="small danger" data-act="kick" data-uid="${uid}">내보내기</button>`;
      return `<li class="${p.alive ? "" : "dead"} ${picked === uid ? "picked" : ""}">
        <span>${p.alive ? "🙂" : "☠️"}</span><span class="pname">${esc(p.name)}</span>${tags.join("")}${btn}</li>`;
    })
    .join("");

  // 채팅
  const isMafia = role === "mafia" && phase !== "lobby";
  if (!isMafia && S.tab === "mafia") S.tab = "all";
  document.querySelector(".mafia-tab").classList.toggle("hidden", !isMafia);
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === S.tab));

  const msgs = S.tab === "mafia" ? S.mafia : [...S.chat, ...S.priv].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const box = $("messages");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = msgs.map((m) => {
    if (m.sys) return `<div class="msg sys">${esc(m.text)}</div>`;
    if (m.priv) return `<div class="msg priv">🔒 ${esc(m.text)}</div>`;
    return `<div class="msg ${m.uid === S.uid ? "me" : ""}"><span class="who">${esc(m.name)}</span>${esc(m.text)}</div>`;
  }).join("") || `<p class="muted">아직 메시지가 없어요.</p>`;
  if (atBottom) box.scrollTop = box.scrollHeight;

  // 채팅 가능 여부
  let blocked = "";
  if (S.tab === "mafia") blocked = alive ? "" : "죽은 마피아는 말할 수 없어요";
  else if (phase === "night") blocked = isMafia ? "밤에는 🔪 마피아 탭에서만 대화할 수 있어요" : "밤에는 대화할 수 없어요";
  else if ((phase === "day" || phase === "vote") && !alive) blocked = "죽은 사람은 말할 수 없어요";
  const input = $("chat-input");
  input.disabled = !!blocked;
  input.placeholder = blocked || (S.tab === "mafia" ? "마피아끼리만 보이는 메시지" : "메시지 입력");
  $("chat-form").querySelector("button").disabled = !!blocked;

  renderTimer();
}

function renderTimer() {
  const end = S.meta?.phaseEnd;
  if (!S.code || !end) { $("timer").textContent = ""; return; }
  const left = Math.max(0, Math.ceil((end - now()) / 1000));
  $("timer").textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

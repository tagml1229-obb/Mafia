// P2P 마피아: 방장 브라우저가 서버 역할을 한다.
// 다른 사람은 PeerJS(WebRTC)로 방장에게 직접 연결해서, 자기한테 보여도 되는 정보만 받는다.

// ───────── 설정 ─────────
const DURATION = { night: 40, day: 90, vote: 30 }; // 초
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 12;
const PEER_PREFIX = "webmafia-kr-v1-"; // PeerJS 공용 서버에서 다른 앱과 방 ID가 겹치지 않게

const ROLES = {
  mafia:   { name: "마피아", emoji: "🔪", desc: "밤마다 한 명을 골라 제거해요. 마피아끼리 비밀 채팅을 할 수 있어요.", act: "오늘 밤 제거할 사람을 고르세요" },
  doctor:  { name: "의사",   emoji: "💉", desc: "밤마다 한 명을 골라 마피아의 공격에서 살려요. 자기 자신도 고를 수 있어요.", act: "오늘 밤 살릴 사람을 고르세요" },
  police:  { name: "경찰",   emoji: "🔎", desc: "밤마다 한 명을 조사해서 마피아인지 알아내요.", act: "오늘 밤 조사할 사람을 고르세요" },
  citizen: { name: "시민",   emoji: "🙂", desc: "특별한 능력은 없어요. 낮에 토론하고 투표로 마피아를 찾아내세요." },
};
const PHASE_LABEL = { lobby: "대기실", night: "🌙 밤", day: "☀️ 낮 토론", vote: "🗳️ 투표", ended: "게임 종료" };

// 테스트용: ?peerhost=127.0.0.1:9001 이면 로컬 시그널링 서버 사용
const params = new URLSearchParams(location.search);
const PEER_OPTS = { debug: 0 };
if (params.get("peerhost")) {
  const [host, port] = params.get("peerhost").split(":");
  Object.assign(PEER_OPTS, { host, port: Number(port), path: "/", secure: false });
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, session = true) { try { return (session ? sessionStorage : localStorage).getItem(k); } catch { return null; } },
  set(k, v, session = true) { try { (session ? sessionStorage : localStorage).setItem(k, v); } catch {} },
  del(k) { try { sessionStorage.removeItem(k); } catch {} },
};
const randId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// 탭마다 다른 플레이어 (새로고침해도 유지)
const myPid = store.get("mafia-pid") || randId();
store.set("mafia-pid", myPid);

// ───────── 공통 상태 ─────────
let mode = null;        // "host" | "guest"
let peer = null;
let V = null;           // 내 화면에 보여줄 정보
let localEnd = null;    // 타이머 끝나는 시각 (내 시계 기준)
let tab = "all";

// 방장 전용
let G = null;           // 전체 게임 상태 (방장만 가짐)
const conns = {};       // pid -> 연결

// 참가자 전용
let hostConn = null;
let guestCode = null, guestName = null;
let reconnectTimer = null;
let joinTimer = null;

// ───────── 첫 화면 ─────────
$("name").value = store.get("mafia-name", false) || "";
if (params.get("room")) {
  $("code").value = params.get("room").toUpperCase().slice(0, 4);
}

function showHomeError(msg) { $("home-error").textContent = msg; }
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), 2500);
}

function readName() {
  const name = $("name").value.trim();
  if (!name) { showHomeError("닉네임을 입력하세요."); $("name").focus(); return null; }
  store.set("mafia-name", name, false);
  return name;
}

function checkLib() {
  if (window.Peer) return true;
  showHomeError("게임 모듈을 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침하세요.");
  return false;
}

$("create").onclick = () => {
  const name = readName();
  if (!name || !checkLib()) return;
  $("create").disabled = true;
  showHomeError("방 만드는 중...");
  startHosting(name, null);
};

$("join").onclick = () => {
  const name = readName();
  const code = $("code").value.trim().toUpperCase();
  if (!name || !checkLib()) return;
  if (!/^[A-Z]{4}$/.test(code)) return showHomeError("방 코드 4자리(영문)를 입력하세요.");
  $("join").disabled = true;
  showHomeError("연결 중...");
  startGuest(code, name);
};
$("code").addEventListener("keydown", (e) => e.key === "Enter" && $("join").click());

function newCode() {
  return Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)]).join("");
}

function enterRoomUI(code) {
  $("home").classList.add("hidden");
  $("room").classList.remove("hidden");
  $("room-code").textContent = code;
  $("create").disabled = $("join").disabled = false;
  showHomeError("");
}

function exitRoom(msg = "") {
  mode = null;
  clearTimeout(reconnectTimer);
  clearTimeout(joinTimer);
  try { peer?.destroy(); } catch {}
  peer = hostConn = null;
  G = V = null;
  for (const k of Object.keys(conns)) delete conns[k];
  ["mafia-mode", "mafia-room", "mafia-host-state"].forEach(store.del);
  document.body.className = "";
  $("room").classList.add("hidden");
  $("home").classList.remove("hidden");
  $("conn").classList.add("hidden");
  $("create").disabled = $("join").disabled = false;
  showHomeError(msg);
}

function setConn(msg) {
  $("conn").textContent = msg || "";
  $("conn").classList.toggle("hidden", !msg);
}

// ───────── 방장 ─────────
function startHosting(name, saved, attempt = 0) {
  mode = "host";
  const code = saved?.code || newCode();
  peer = new Peer(PEER_PREFIX + code, PEER_OPTS);

  peer.on("open", () => {
    if (G) return setConn(""); // 연결 서버에 재접속한 경우: 게임은 그대로
    G = saved || {
      code, host: myPid, phase: "lobby", day: 0, phaseEnd: null,
      players: { [myPid]: { name, alive: true, joinedAt: Date.now(), online: true } },
      roles: {}, actions: {}, votes: {}, chat: [], mafia: [], priv: {}, winner: null,
    };
    // 새로고침으로 돌아왔으면 남은 시간을 다시 줌 (방장이 없던 동안 시간이 흘렀을 수 있으므로)
    if (saved && G.phaseEnd && G.phaseEnd < Date.now() + 10000) G.phaseEnd = Date.now() + 10000;
    for (const p of Object.values(G.players)) p.online = false;
    G.players[myPid].online = true;
    store.set("mafia-mode", "host");
    enterRoomUI(code);
    setConn("");
    publish();
  });

  peer.on("connection", onGuestConn);

  peer.on("error", (e) => {
    if (e.type === "unavailable-id") {
      try { peer.destroy(); } catch {}
      // 새로고침 직후엔 예전 연결이 아직 이 코드를 잡고 있을 수 있어서 잠깐 기다렸다 재시도
      if (saved && attempt < 15) { setConn("방 다시 여는 중..."); setTimeout(() => startHosting(name, saved, attempt + 1), 2000); }
      else if (saved) exitRoom("방을 다시 열지 못했어요. 새 방을 만들어주세요.");
      else startHosting(name, null, attempt + 1);
    } else if (e.type === "network" || e.type === "server-error" || e.type === "socket-error" || e.type === "socket-closed") {
      if (!G) exitRoom("연결 서버에 접속하지 못했어요. 인터넷 연결을 확인하세요.");
      else setConn("인터넷 연결이 불안정해요. 다시 연결하는 중...");
    } else if (e.type === "browser-incompatible") {
      exitRoom("이 브라우저는 지원하지 않아요. 크롬이나 사파리로 열어주세요.");
    } else console.warn(e);
  });

  peer.on("disconnected", () => {
    if (mode !== "host") return;
    setConn("연결 서버와 끊겼어요. 다시 연결하는 중...");
    setTimeout(() => { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 1500);
  });
}

function onGuestConn(conn) {
  conn.on("data", (m) => {
    try { handleGuestMsg(conn, m); } catch (e) { console.warn(e); }
  });
  conn.on("close", () => {
    const pid = conn.pid;
    if (pid && conns[pid] === conn) {
      delete conns[pid];
      if (G?.players[pid]) G.players[pid].online = false;
      publish();
    }
  });
}

function handleGuestMsg(conn, m) {
  if (!G || !m || typeof m !== "object") return;
  if (m.type === "join") {
    const pid = String(m.pid || "").slice(0, 40);
    const name = String(m.name || "").trim().slice(0, 12);
    if (!pid || !name || pid === G.host) return conn.send({ type: "error", text: "참가 정보가 잘못됐어요." });
    if (!G.players[pid]) {
      if (G.phase !== "lobby") return conn.send({ type: "error", text: "이미 게임이 진행 중인 방이에요." });
      if (Object.keys(G.players).length >= MAX_PLAYERS) return conn.send({ type: "error", text: `방이 꽉 찼어요. (최대 ${MAX_PLAYERS}명)` });
      G.players[pid] = { name, alive: true, joinedAt: Date.now(), online: true };
    }
    if (conns[pid] && conns[pid] !== conn) { conns[pid].pid = null; conns[pid].close(); }
    conns[pid] = conn;
    conn.pid = pid;
    G.players[pid].online = true;
    return publish();
  }
  if (conn.pid && G.players[conn.pid]) act(conn.pid, m);
}

// 모든 행동은 여기서 검증 (방장 자신의 행동도 여기를 거침)
function act(pid, m) {
  const p = G.players[pid];
  const role = G.roles[pid];
  const isHost = pid === G.host;
  const text = typeof m.text === "string" ? m.text.trim().slice(0, 300) : "";

  switch (m.type) {
    case "chat":
      if (!text) return;
      if (G.phase === "night" || ((G.phase === "day" || G.phase === "vote") && !p.alive)) return;
      G.chat.push({ pid, name: p.name, text, ts: Date.now() });
      break;
    case "mchat":
      if (!text || role !== "mafia" || !p.alive || G.phase === "lobby" || G.phase === "ended") return;
      G.mafia.push({ pid, name: p.name, text, ts: Date.now() });
      break;
    case "act":
      if (G.phase !== "night" || !p.alive || !role || role === "citizen") return;
      if (!canTarget(pid, m.target, "night", role, mafiaMates(pid), G.players)) return;
      G.actions[pid] = { target: m.target, ts: Date.now() };
      break;
    case "vote":
      if (G.phase !== "vote" || !p.alive || !canTarget(pid, m.target, "vote", role, [], G.players)) return;
      G.votes[pid] = m.target;
      break;
    case "leave":
      if (G.phase !== "lobby" || isHost) return;
      delete G.players[pid];
      conns[pid]?.close();
      delete conns[pid];
      break;
    case "kick":
      if (!isHost || G.phase !== "lobby" || !G.players[m.target] || m.target === G.host) return;
      delete G.players[m.target];
      if (conns[m.target]) {
        const c = conns[m.target];
        delete conns[m.target];
        c.pid = null;
        c.send({ type: "kicked" });
        setTimeout(() => c.close(), 500);
      }
      break;
    case "start": if (isHost) return startGame(); return;
    case "skip": if (isHost) return advance(); return;
    case "lobby": if (isHost && G.phase === "ended") return backToLobby(); return;
    default: return;
  }
  publish();
}

function mafiaMates(pid) {
  return Object.keys(G.roles).filter((u) => u !== pid && G.roles[u] === "mafia");
}

// 방장 / 참가자 화면 둘 다 쓰는 규칙
function canTarget(me, target, mode, role, mates, players) {
  const alive = (u) => (Array.isArray(players) ? players.find((p) => p.id === u)?.alive : players[u]?.alive);
  if (!alive(target)) return false;
  if (mode === "vote") return target !== me;
  if (role === "mafia") return target !== me && !mates.includes(target);
  if (role === "police") return target !== me;
  return role === "doctor"; // 의사는 자기 자신도 가능
}

function viewFor(pid) {
  const role = G.roles[pid] || null;
  return {
    code: G.code, me: pid, host: G.host, phase: G.phase, day: G.day,
    left: G.phaseEnd ? Math.max(0, G.phaseEnd - Date.now()) : null,
    players: Object.entries(G.players)
      .sort((a, b) => a[1].joinedAt - b[1].joinedAt)
      .map(([id, p]) => ({ id, name: p.name, alive: p.alive, online: id === G.host || p.online })),
    role,
    mates: role === "mafia" ? mafiaMates(pid) : [],
    myAction: G.actions[pid]?.target || null,
    votes: G.phase === "vote" ? G.votes : {},
    chat: G.chat.slice(-100),
    mafia: role === "mafia" ? G.mafia.slice(-100) : [],
    priv: G.priv[pid] || [],
    winner: G.winner,
    reveal: G.phase === "ended" ? G.roles : null,
  };
}

// 상태가 바뀔 때마다: 저장하고 → 각자에게 자기 화면용 정보만 보냄
function publish() {
  if (!G) return;
  store.set("mafia-host-state", JSON.stringify(G));
  for (const [pid, conn] of Object.entries(conns)) {
    if (conn.open) {
      try { conn.send({ type: "state", view: viewFor(pid) }); } catch (e) { console.warn(e); }
    }
  }
  applyView(viewFor(myPid));
}

function sys(text) { G.chat.push({ sys: true, text, ts: Date.now() }); }

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function winnerOf() {
  const alive = Object.keys(G.players).filter((u) => G.players[u].alive);
  const mafia = alive.filter((u) => G.roles[u] === "mafia").length;
  if (mafia === 0) return "citizen";
  if (mafia >= alive.length - mafia) return "mafia";
  return null;
}

function endGame(winner) {
  G.phase = "ended";
  G.phaseEnd = null;
  G.winner = winner;
  sys(winner === "mafia" ? "🔪 마피아 승리! 마피아가 마을을 장악했습니다." : "🎉 시민 승리! 마피아를 모두 찾아냈습니다.");
}

function setPhase(phase, seconds) {
  G.phase = phase;
  G.phaseEnd = Date.now() + seconds * 1000;
}

function startGame() {
  if (G.phase !== "lobby") return;
  const uids = Object.keys(G.players);
  const n = uids.length;
  if (n < MIN_PLAYERS) return;
  const mafiaCount = n >= 9 ? 3 : n >= 6 ? 2 : 1;
  const deck = [...Array(mafiaCount).fill("mafia"), "doctor", "police"];
  while (deck.length < n) deck.push("citizen");
  shuffle(deck);

  G.roles = {};
  uids.forEach((u, i) => { G.roles[u] = deck[i]; G.players[u].alive = true; });
  Object.assign(G, { actions: {}, votes: {}, mafia: [], priv: {}, winner: null, day: 1 });
  setPhase("night", DURATION.night);
  sys(`게임 시작! ${n}명 중 마피아는 ${mafiaCount}명입니다.`);
  sys("🌙 1일차 밤이 되었습니다. 마피아, 의사, 경찰은 능력을 사용하세요.");
  publish();
}

function resolveNight() {
  const alive = (u) => G.players[u]?.alive;
  const withRole = (r) => Object.keys(G.roles).filter((u) => G.roles[u] === r && alive(u));

  // 마피아: 가장 많이 지목된 사람 (동률이면 마지막에 고른 쪽)
  const tally = {};
  for (const m of withRole("mafia")) {
    const a = G.actions[m];
    if (!a || !alive(a.target)) continue;
    const t = (tally[a.target] ??= { n: 0, ts: 0 });
    t.n++;
    t.ts = Math.max(t.ts, a.ts);
  }
  const kill = Object.entries(tally).sort((a, b) => b[1].n - a[1].n || b[1].ts - a[1].ts)[0]?.[0];
  const doctor = withRole("doctor")[0];
  const save = doctor && G.actions[doctor]?.target;
  const police = withRole("police")[0];
  const inspect = police && G.actions[police]?.target;

  if (police && inspect && G.players[inspect]) {
    const isMafia = G.roles[inspect] === "mafia";
    (G.priv[police] ??= []).push({
      text: `🔎 조사 결과: ${G.players[inspect].name}님은 ${isMafia ? "마피아입니다!" : "마피아가 아닙니다."}`,
      ts: Date.now(),
    });
  }

  let dead = null;
  if (kill && kill !== save) {
    dead = kill;
    G.players[kill].alive = false;
  }
  G.actions = {};
  sys(`☀️ ${G.day}일차 아침이 밝았습니다. ` +
    (dead ? `밤사이 ${G.players[dead].name}님이 마피아에게 살해당했습니다.` : "지난밤에는 아무도 죽지 않았습니다."));

  const winner = winnerOf();
  if (winner) endGame(winner);
  else setPhase("day", DURATION.day);
}

function startVote() {
  G.votes = {};
  setPhase("vote", DURATION.vote);
  sys("🗳️ 투표 시간! 마피아로 의심되는 사람에게 투표하세요.");
}

function resolveVote() {
  const count = {};
  for (const [voter, target] of Object.entries(G.votes)) {
    if (G.players[voter]?.alive && G.players[target]?.alive) count[target] = (count[target] || 0) + 1;
  }
  const sorted = Object.entries(count).sort((a, b) => b[1] - a[1]);
  G.votes = {};

  if (!sorted.length) sys("아무도 투표하지 않아 처형이 없습니다.");
  else if (sorted[1] && sorted[1][1] === sorted[0][1]) sys("동점이 나와서 아무도 처형되지 않았습니다.");
  else {
    const [target, n] = sorted[0];
    G.players[target].alive = false;
    sys(`⚖️ ${G.players[target].name}님이 ${n}표로 처형되었습니다.`);
  }

  const winner = winnerOf();
  if (winner) endGame(winner);
  else {
    G.day++;
    G.actions = {};
    setPhase("night", DURATION.night);
    sys(`🌙 ${G.day}일차 밤이 되었습니다.`);
  }
}

function advance() {
  if (!G) return;
  if (G.phase === "night") resolveNight();
  else if (G.phase === "day") startVote();
  else if (G.phase === "vote") resolveVote();
  else return;
  publish();
}

function backToLobby() {
  Object.assign(G, { phase: "lobby", day: 0, phaseEnd: null, roles: {}, actions: {}, votes: {}, mafia: [], priv: {}, winner: null });
  Object.values(G.players).forEach((p) => (p.alive = true));
  sys("대기실로 돌아왔습니다. 방장이 새 게임을 시작할 수 있어요.");
  publish();
}

setInterval(() => {
  if (mode === "host" && G?.phaseEnd && Date.now() >= G.phaseEnd) advance();
  renderTimer();
}, 500);

// ───────── 참가자 ─────────
function startGuest(code, name) {
  mode = "guest";
  guestCode = code;
  guestName = name;
  store.set("mafia-mode", "guest");
  store.set("mafia-room", code);
  peer = new Peer(PEER_OPTS);
  peer.on("open", connectToHost);
  peer.on("error", (e) => {
    if (mode !== "guest") return;
    if (e.type === "peer-unavailable") {
      if (!V) exitRoom("방을 찾을 수 없어요. 코드를 확인하거나, 방장이 화면을 켜두고 있는지 확인하세요.");
      else scheduleReconnect();
    } else if (e.type === "browser-incompatible") {
      exitRoom("이 브라우저는 지원하지 않아요. 크롬이나 사파리로 열어주세요.");
    } else if (!V) {
      exitRoom("연결 서버에 접속하지 못했어요. 인터넷 연결을 확인하세요.");
    } else scheduleReconnect();
  });
  peer.on("disconnected", () => {
    if (mode !== "guest") return;
    setTimeout(() => { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 1500);
  });
}

function connectToHost() {
  if (mode !== "guest" || !peer || peer.destroyed) return;
  clearTimeout(joinTimer);
  try { hostConn?.close(); } catch {}
  const conn = peer.connect(PEER_PREFIX + guestCode, { reliable: true });
  hostConn = conn;
  conn.on("open", () => {
    conn.send({ type: "join", pid: myPid, name: guestName });
  });
  conn.on("data", (m) => {
    if (mode !== "guest" || hostConn !== conn || !m || typeof m !== "object") return;
    if (m.type === "state") {
      clearTimeout(joinTimer);
      if (!V) enterRoomUI(guestCode);
      setConn("");
      applyView(m.view);
    } else if (m.type === "error") exitRoom(m.text);
    else if (m.type === "kicked") exitRoom("방장이 방에서 내보냈어요.");
  });
  conn.on("close", () => {
    if (mode === "guest" && hostConn === conn) {
      setConn("방장과 연결이 끊겼어요. 다시 연결하는 중...");
      scheduleReconnect();
    }
  });
  // 연결이 안 열리고 멈춰 있는 경우 (일부 네트워크)
  joinTimer = setTimeout(() => {
    if (mode !== "guest" || conn.open) return;
    if (!V) exitRoom("방장 폰과 연결하지 못했어요. 방장이 화면을 켜두었는지 확인하고, 와이파이↔데이터를 바꿔서 다시 시도해보세요.");
    else scheduleReconnect();
  }, 15000);
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (mode !== "guest") return;
    if (!peer || peer.destroyed) return startGuest(guestCode, guestName);
    if (peer.disconnected) peer.reconnect();
    else connectToHost();
  }, 3000);
}

// 폰에서 다른 앱 갔다가 돌아왔을 때 바로 다시 연결
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !peer || peer.destroyed) return;
  if (peer.disconnected) peer.reconnect();
  if (mode === "guest" && !hostConn?.open) connectToHost();
});

// 내 행동 보내기 (방장은 바로 처리)
function send(m) {
  if (mode === "host") act(myPid, m);
  else if (hostConn?.open) hostConn.send(m);
  else toast("방장과 연결 중이에요. 잠시 후 다시 해보세요.");
}

// ───────── 새로고침하면 방으로 복귀 ─────────
(function resume() {
  if (!window.Peer) return;
  const m = store.get("mafia-mode");
  const name = store.get("mafia-name", false);
  if (m === "host") {
    try {
      const saved = JSON.parse(store.get("mafia-host-state"));
      if (saved?.host === myPid) return startHosting(saved.players[myPid].name, saved);
    } catch {}
  } else if (m === "guest" && store.get("mafia-room") && name) {
    showHomeError("방에 다시 연결하는 중...");
    return startGuest(store.get("mafia-room"), name);
  }
  ["mafia-mode", "mafia-room", "mafia-host-state"].forEach(store.del);
})();

// ───────── 화면 조작 ─────────
$("players").onclick = (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn || !V) return;
  const { act: a, uid } = btn.dataset;
  if (a === "pick") send({ type: V.phase === "night" ? "act" : "vote", target: uid });
  if (a === "kick") {
    if (btn.dataset.sure) send({ type: "kick", target: uid });
    else { btn.dataset.sure = "1"; btn.textContent = "정말?"; }
  }
};

$("host-controls").onclick = (e) => {
  const a = e.target.closest("button")?.dataset.act;
  if (a === "start") send({ type: "start" });
  if (a === "lobby") send({ type: "lobby" });
  if (a === "leave") { send({ type: "leave" }); setTimeout(() => exitRoom(), 200); }
};
$("skip").onclick = () => send({ type: "skip" });

$("share").onclick = async () => {
  const url = `${location.origin}${location.pathname}?room=${V.code}`;
  const text = `마피아 하자! 방 코드: ${V.code}`;
  if (navigator.share) {
    try { await navigator.share({ title: "마피아 게임", text, url }); return; } catch (err) { if (err.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); toast("초대 링크를 복사했어요. 단톡방에 붙여넣으세요!"); }
  catch { toast(url); }
};

document.querySelector(".tabs").onclick = (e) => {
  const t = e.target.closest("[data-tab]")?.dataset.tab;
  if (t) { tab = t; render(); }
};

$("chat-form").onsubmit = (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  send({ type: tab === "mafia" ? "mchat" : "chat", text });
  input.value = "";
};

// ───────── 화면 그리기 ─────────
function applyView(view) {
  V = view;
  localEnd = view.left != null ? Date.now() + view.left : null;
  render();
}

function render() {
  if (!V) return;
  const { phase } = V;
  const isHost = V.me === V.host;
  const meP = V.players.find((p) => p.id === V.me);
  const alive = meP?.alive;
  const role = V.role;
  const nameOf = (id) => V.players.find((p) => p.id === id)?.name ?? "???";
  document.body.className = phase === "night" ? "night" : phase === "day" || phase === "vote" ? "day" : "";

  $("phase").textContent = phase === "lobby" || phase === "ended" ? PHASE_LABEL[phase] : `${V.day}일차 ${PHASE_LABEL[phase]}`;
  $("skip").classList.toggle("hidden", !(isHost && ["night", "day", "vote"].includes(phase)));

  // 내 직업 카드
  const card = $("role-card");
  if (role && phase !== "lobby") {
    const r = ROLES[role];
    card.className = `card role ${role}`;
    card.innerHTML = `<div class="emoji">${r.emoji}</div><div>
      <h3>당신은 ${r.name}입니다${alive ? "" : " (사망)"}</h3><p>${r.desc}</p>
      ${V.mates.length ? `<p>동료 마피아: <b>${V.mates.map((m) => esc(nameOf(m))).join(", ")}</b></p>` : ""}</div>`;
  } else card.className = "hidden";

  // 승리 배너
  const banner = $("banner");
  if (phase === "ended") {
    banner.className = `banner ${V.winner}`;
    banner.textContent = V.winner === "mafia" ? "🔪 마피아 승리!" : "🎉 시민 승리!";
  } else banner.className = "hidden";

  // 안내 문구
  const count = V.players.length;
  let hint = "";
  if (phase === "lobby") hint = count < MIN_PLAYERS ? `${MIN_PLAYERS}명 이상 모이면 시작할 수 있어요. 🔗 초대 버튼으로 링크를 보내세요!` : isHost ? "준비되면 게임 시작을 누르세요." : "방장이 시작하길 기다리는 중...";
  else if (phase === "ended") hint = isHost ? "다시 하려면 대기실로 돌아가세요." : "방장이 새 게임을 열 때까지 기다려주세요.";
  else if (!alive) hint = "☠️ 당신은 죽었습니다. 끝까지 관전하세요. (말은 할 수 없어요)";
  else if (phase === "night") hint = role && role !== "citizen" ? ROLES[role].act : "밤입니다. 조용히 아침을 기다리세요...";
  else if (phase === "day") hint = "토론 시간! 채팅으로 누가 마피아인지 이야기해보세요.";
  else if (phase === "vote") hint = "마피아로 의심되는 사람에게 투표하세요. (시간 내 바꿀 수 있어요)";
  if (isHost && phase !== "lobby" && phase !== "ended") hint += " · 방장은 게임 중에 화면을 끄지 마세요!";
  $("hint").textContent = hint;

  // 방장 버튼
  let hc = "";
  if (phase === "lobby" && isHost) hc = `<button class="small primary" style="margin:0;width:auto" data-act="start" ${count < MIN_PLAYERS ? "disabled" : ""}>게임 시작</button>`;
  if (phase === "lobby" && !isHost) hc = `<button class="small" data-act="leave">나가기</button>`;
  if (phase === "ended" && isHost) hc = `<button class="small" data-act="lobby">대기실로</button>`;
  $("host-controls").innerHTML = hc;

  // 플레이어 목록
  const mode = alive && phase === "night" && role && role !== "citizen" ? "night" : alive && phase === "vote" ? "vote" : null;
  const voteCount = {};
  Object.values(V.votes).forEach((t) => (voteCount[t] = (voteCount[t] || 0) + 1));
  const picked = mode === "night" ? V.myAction : mode === "vote" ? V.votes[V.me] : null;
  const btnLabel = mode === "vote" ? "투표" : { mafia: "제거", doctor: "치료", police: "조사" }[role];

  $("count").textContent = `(${V.players.filter((p) => p.alive).length}/${count})`;
  $("players").innerHTML = V.players.map((p) => {
    const tags = [];
    if (p.id === V.host) tags.push(`<span class="tag">👑 방장</span>`);
    if (p.id === V.me) tags.push(`<span class="tag">나</span>`);
    if (!p.online) tags.push(`<span class="tag off">📴 연결 끊김</span>`);
    if (V.mates.includes(p.id) && phase !== "lobby") tags.push(`<span class="tag mafia">🔪 동료</span>`);
    const rv = V.reveal?.[p.id];
    if (rv) tags.push(`<span class="tag ${rv === "mafia" ? "mafia" : ""}">${ROLES[rv].emoji} ${ROLES[rv].name}</span>`);
    if (phase === "vote" && voteCount[p.id]) tags.push(`<span class="tag votes">${voteCount[p.id]}표</span>`);
    let btn = "";
    if (mode && canTarget(V.me, p.id, mode, role, V.mates, V.players)) {
      btn = `<button class="small" data-act="pick" data-uid="${esc(p.id)}">${picked === p.id ? "✔ " : ""}${btnLabel}</button>`;
    }
    if (phase === "lobby" && isHost && p.id !== V.me) btn = `<button class="small danger" data-act="kick" data-uid="${esc(p.id)}">내보내기</button>`;
    return `<li class="${p.alive ? "" : "dead"} ${picked === p.id ? "picked" : ""}">
      <span>${p.alive ? "🙂" : "☠️"}</span><span class="pname">${esc(p.name)}</span>${tags.join("")}${btn}</li>`;
  }).join("");

  // 채팅
  const isMafia = role === "mafia" && phase !== "lobby";
  if (!isMafia && tab === "mafia") tab = "all";
  document.querySelector(".mafia-tab").classList.toggle("hidden", !isMafia);
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));

  const msgs = tab === "mafia" ? V.mafia : [...V.chat, ...V.priv.map((m) => ({ ...m, priv: true }))].sort((a, b) => a.ts - b.ts);
  const box = $("messages");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = msgs.map((m) => {
    if (m.sys) return `<div class="msg sys">${esc(m.text)}</div>`;
    if (m.priv) return `<div class="msg priv">🔒 ${esc(m.text)}</div>`;
    return `<div class="msg ${m.pid === V.me ? "me" : ""}"><span class="who">${esc(m.name)}</span>${esc(m.text)}</div>`;
  }).join("") || `<p class="muted">아직 메시지가 없어요.</p>`;
  if (atBottom) box.scrollTop = box.scrollHeight;

  // 채팅 가능 여부
  let blocked = "";
  if (tab === "mafia") blocked = alive ? "" : "죽은 마피아는 말할 수 없어요";
  else if (phase === "night") blocked = isMafia ? "밤에는 🔪 마피아 탭에서만 대화할 수 있어요" : "밤에는 대화할 수 없어요";
  else if ((phase === "day" || phase === "vote") && !alive) blocked = "죽은 사람은 말할 수 없어요";
  const input = $("chat-input");
  input.disabled = !!blocked;
  input.placeholder = blocked || (tab === "mafia" ? "마피아끼리만 보이는 메시지" : "메시지 입력");
  $("chat-form").querySelector("button").disabled = !!blocked;

  renderTimer();
}

function renderTimer() {
  if (!V || !localEnd) { $("timer").textContent = ""; return; }
  const left = Math.max(0, Math.ceil((localEnd - Date.now()) / 1000));
  $("timer").textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

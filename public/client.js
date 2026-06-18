/* client.js — UI + realtime client for Hex Settlers (v2) */
const socket = io();
const $ = (id) => document.getElementById(id);

const RES_COLORS = { wood: '#3f8a4f', brick: '#c1572f', sheep: '#8fb84e', wheat: '#e3b23c', ore: '#7d8a99', desert: '#d9c79b' };
const RES_DARK = { wood: '#244e2d', brick: '#7d3318', sheep: '#5c7a2a', wheat: '#9c7613', ore: '#48535f', desert: '#a8915c' };
const RES_LABEL = { wood: 'Wood', brick: 'Brick', sheep: 'Sheep', wheat: 'Wheat', ore: 'Ore' };
const RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const DEV_LABEL = { knight: 'Knight', road_building: 'Road Building', monopoly: 'Monopoly', year_of_plenty: 'Year of Plenty' };

let state = null;
let me = null;
let mode = null;
let currentModal = null;   // {type}
let lastGainSeq = 0;
let lastEventId = 0;

/* ---------- session ---------- */
function saveSession(s) { localStorage.setItem('hexsettle', JSON.stringify(s)); }
function loadSession() { try { return JSON.parse(localStorage.getItem('hexsettle')); } catch { return null; } }
function clearSession() { localStorage.removeItem('hexsettle'); }

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.style.background = kind === 'bad' ? '#7d2018' : kind === 'good' ? '#1f5e36' : '#2c2418';
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3600);
}
socket.on('error_msg', (m) => toast(m, 'bad'));

/* ---------- lobby ---------- */
$('btn-create').onclick = () => {
  const name = $('name').value.trim();
  if (!name) return ($('lobby-error').textContent = 'Enter a name first.');
  socket.emit('create_room', { name }, (res) => {
    if (res.error) return ($('lobby-error').textContent = res.error);
    me = { roomId: res.roomId, playerId: res.playerId }; saveSession(me);
  });
};
$('btn-join').onclick = () => {
  const name = $('name').value.trim();
  const roomId = $('room-code').value.trim().toUpperCase();
  if (!name) return ($('lobby-error').textContent = 'Enter a name first.');
  if (!roomId) return ($('lobby-error').textContent = 'Enter a room code.');
  socket.emit('join_room', { name, roomId }, (res) => {
    if (res.error) return ($('lobby-error').textContent = res.error);
    me = { roomId: res.roomId, playerId: res.playerId }; saveSession(me);
  });
};
socket.on('connect', () => {
  const s = loadSession();
  if (s && !me) socket.emit('rejoin', s, (res) => { if (res && !res.error) me = s; else clearSession(); });
});
$('copy-link').onclick = () => {
  navigator.clipboard?.writeText(`${location.origin}/?room=${state.roomId}`);
  toast('Invite link copied.', 'good');
};
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('room-code').value = urlRoom.toUpperCase();

/* ---------- main state ---------- */
socket.on('state', (s) => {
  state = s;
  if (!me) me = { roomId: s.roomId, playerId: s.you };
  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');
  render();
  handleGain();
  handleEvents();
});

function send(type, payload) { socket.emit('action', { type, payload }); }
function meId() { return state.you; }
function isMyTurn() { return state.current === meId(); }
function playerById(id) { return state.players.find((p) => p.id === id); }
function myPlayer() { return playerById(meId()); }

/* ---------- render ---------- */
function render() {
  renderTopbar();
  renderPlayers();
  renderHand();
  renderControls();
  renderBoard();
  renderLog();
  renderModals();
}

function renderTopbar() {
  $('room-id').textContent = state.roomId;
  const banner = $('turn-banner');
  if (state.phase === 'lobby') banner.textContent = 'Waiting in lobby…';
  else if (state.phase === 'over') { const w = playerById(state.winner); banner.textContent = w ? `🏆 ${w.name} wins!` : 'Game over'; }
  else { const cur = playerById(state.current); banner.textContent = isMyTurn() ? 'Your turn' : `${cur ? cur.name : '—'}'s turn`; }
  const dice = $('dice');
  if (state.dice) { dice.classList.remove('hidden'); dice.innerHTML = dieSVG(state.dice[0]) + dieSVG(state.dice[1]); }
  else dice.classList.add('hidden');
}

function renderPlayers() {
  const el = $('players'); el.innerHTML = '';
  state.players.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'prow' + (p.id === state.current ? ' active' : '') + (p.connected ? '' : ' off');
    const badges = [];
    if (state.longestRoad === p.id) badges.push('<span class="badge" title="Longest road">🛣 Road</span>');
    if (state.largestArmy === p.id) badges.push('<span class="badge" title="Largest army">⚔ Army</span>');
    row.innerHTML = `
      <span class="swatch" style="background:${p.color}"></span>
      <span class="pname">${escapeHtml(p.name)}${p.isHost ? ' ★' : ''}</span>
      <span class="pmeta">
        <span title="Victory points"><strong>${p.vp}</strong> VP</span>
        <span title="Resource cards">🂠 ${p.handCount}</span>
        <span title="Development cards">📜 ${p.devCount}</span>
        ${badges.join('')}
      </span>`;
    el.appendChild(row);
  });
}

function renderHand() {
  const el = $('hand'); el.innerHTML = '';
  const my = myPlayer();
  if (!my || !my.resources) { el.innerHTML = '<span class="hint">—</span>'; return; }
  let any = false;
  RESOURCES.forEach((r) => {
    const n = my.resources[r]; if (n <= 0) return; any = true;
    const c = document.createElement('span'); c.className = 'card';
    c.style.background = RES_COLORS[r] + '55';
    c.innerHTML = `<span class="dot" style="background:${RES_COLORS[r]}"></span>${RES_LABEL[r]} ${n}`;
    el.appendChild(c);
  });
  if (!any) el.innerHTML = '<span class="hint">No resources yet.</span>';

  // owned ports / trade rates
  if (state.myPorts && Object.keys(state.myPorts).length) {
    const ports = document.createElement('div'); ports.className = 'ports-line';
    const list = Object.keys(state.myPorts).map((t) => t === '3:1' ? '3:1 any' : `2:1 ${RES_LABEL[t]}`).join(' · ');
    ports.innerHTML = `<span class="hint">⚓ Your harbors: ${list}</span>`;
    el.parentElement.appendChild(ports);
    // remove stale duplicates
    const lines = el.parentElement.querySelectorAll('.ports-line');
    for (let i = 0; i < lines.length - 1; i++) lines[i].remove();
  } else {
    el.parentElement.querySelectorAll('.ports-line').forEach((n) => n.remove());
  }
}

function renderControls() {
  const el = $('controls'); el.innerHTML = '';
  const add = (html) => { const d = document.createElement('div'); d.innerHTML = html; while (d.firstChild) el.appendChild(d.firstChild); };

  if (state.phase === 'lobby') {
    const my = myPlayer();
    add(`<p class="hint">Share room code <strong>${state.roomId}</strong>. ${state.players.length}/4 joined.</p>`);
    if (my && my.isHost) {
      const b = document.createElement('button'); b.className = 'primary';
      b.textContent = state.players.length < 2 ? 'Need 2+ players' : 'Start game';
      b.disabled = state.players.length < 2; b.onclick = () => send('start', {});
      el.appendChild(b);
    } else add('<p class="hint">Waiting for the host to start…</p>');
    return;
  }
  if (state.phase === 'over') { add('<p class="hint">Game over. Refresh to play again.</p>'); return; }

  if (state.phase === 'setup') {
    if (isMyTurn()) { mode = state.setup.expect === 'settlement' ? 'settlement' : 'road';
      add(`<p class="hint">Setup: place a <strong>${state.setup.expect}</strong>. Your second settlement collects starting resources.</p>`); }
    else { mode = null; add('<p class="hint">Waiting for other players to set up…</p>'); }
    return;
  }

  if (!isMyTurn()) {
    mode = null;
    if (state.offer && state.offer.from !== meId()) renderTradeResponse(el);
    else add('<p class="hint">Waiting for your turn. You still collect resources on every roll.</p>');
    return;
  }

  // my turn
  if (state.mustDiscard > 0) { add('<p class="hint">Discard cards to continue (see dialog).</p>'); return; }
  if (state.robberStep) { mode = 'robber'; add('<p class="hint">Move the robber: click a hex.</p>'); return; }
  if (state.stealCandidates.length) { mode = null; add('<p class="hint">Choose someone to steal from (see dialog).</p>'); return; }

  if (!state.hasRolled) {
    const b = document.createElement('button'); b.className = 'primary'; b.textContent = '🎲 Roll dice';
    b.onclick = () => send('roll', {}); el.appendChild(b);
    add('<p class="hint">Roll to produce resources, then build, buy, or trade.</p>'); mode = null; return;
  }

  if (state.freeRoads > 0) add(`<p class="hint" style="color:#7d3318;font-weight:600">Road Building: place ${state.freeRoads} free road${state.freeRoads > 1 ? 's' : ''}.</p>`);

  add(`<div class="btn-row">
        <button class="act ${mode === 'road' ? 'on' : ''}" data-m="road">Road</button>
        <button class="act ${mode === 'settlement' ? 'on' : ''}" data-m="settlement">Settle</button>
        <button class="act ${mode === 'city' ? 'on' : ''}" data-m="city">City</button>
      </div>`);
  el.querySelectorAll('[data-m]').forEach((btn) => { btn.onclick = () => { mode = mode === btn.dataset.m ? null : btn.dataset.m; render(); }; });
  add(`<p class="hint">Road: wood+brick · Settlement: wood+brick+sheep+wheat · City: 2 wheat+3 ore</p>`);

  // trade
  const trade = document.createElement('div'); trade.className = 'btn-row';
  trade.appendChild(mkBtn('Bank/port trade', () => openBankTrade()));
  trade.appendChild(mkBtn('Offer to players', () => openOfferModal()));
  el.appendChild(trade);
  if (state.offer && state.offer.from === meId()) renderOwnOffer(el);

  // development cards
  renderDevSection(el);

  const endBtn = mkBtn('End turn', () => { mode = null; send('end_turn', {}); });
  endBtn.className = 'primary'; el.appendChild(endBtn);
}

function renderDevSection(el) {
  const my = myPlayer();
  const wrap = document.createElement('div'); wrap.className = 'dev-box';
  const h = document.createElement('h3'); h.textContent = 'Development cards'; wrap.appendChild(h);

  const buy = mkBtn(`Buy card · 1 ore + 1 sheep + 1 wheat (${state.devDeckLeft} left)`, () => send('buy_dev', {}));
  buy.disabled = state.devDeckLeft === 0; wrap.appendChild(buy);

  const playable = my.dev || {};
  const fresh = my.devNew || {};
  const row = (key, action, payloadFn) => {
    const n = playable[key] || 0; if (n <= 0) return;
    if (my.playedDev) {
      const d = document.createElement('div'); d.className = 'hint'; d.textContent = `${DEV_LABEL[key]} ×${n} (already played a card this turn)`; wrap.appendChild(d); return;
    }
    const b = mkBtn(`Play ${DEV_LABEL[key]} ×${n}`, () => payloadFn ? payloadFn() : send(action, {}));
    b.className = 'dev-play'; wrap.appendChild(b);
  };
  row('knight', 'play_knight');
  row('road_building', 'play_road_building');
  row('monopoly', null, () => openMonopoly());
  row('year_of_plenty', null, () => openYearOfPlenty());
  if (playable.vp > 0) { const d = document.createElement('div'); d.className = 'hint'; d.textContent = `🎖 ${playable.vp} hidden Victory Point card${playable.vp > 1 ? 's' : ''} (counts toward your score).`; wrap.appendChild(d); }
  const newCount = Object.values(fresh).reduce((a, b) => a + b, 0);
  if (newCount > 0) { const d = document.createElement('div'); d.className = 'hint'; d.textContent = `🆕 ${newCount} card${newCount > 1 ? 's' : ''} bought this turn — playable next turn.`; wrap.appendChild(d); }
  el.appendChild(wrap);
}

function mkBtn(label, fn, cls) { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; if (cls) b.className = cls; return b; }

function renderOwnOffer(el) {
  const box = document.createElement('div');
  box.innerHTML = `<p class="hint">Your offer: give ${fmtBundle(state.offer.give)} for ${fmtBundle(state.offer.want)}.</p>`;
  if (state.offer.responders.length) state.offer.responders.forEach((id) => { const p = playerById(id); box.appendChild(mkBtn(`Trade with ${p.name}`, () => send('confirm_trade', { withId: id }))); });
  else { const w = document.createElement('p'); w.className = 'hint'; w.textContent = 'Waiting for someone to accept…'; box.appendChild(w); }
  box.appendChild(mkBtn('Cancel offer', () => send('cancel_offer', {})));
  el.appendChild(box);
}
function renderTradeResponse(el) {
  const o = state.offer, from = playerById(o.from);
  const box = document.createElement('div');
  box.innerHTML = `<p class="hint"><strong>${from.name}</strong> offers ${fmtBundle(o.give)} and wants ${fmtBundle(o.want)} from you.</p>`;
  const accepted = o.responders.includes(meId());
  box.appendChild(mkBtn(accepted ? '✓ Accepted (waiting)' : 'Accept offer', () => send('respond_offer', { accept: !accepted })));
  el.appendChild(box);
}
function fmtBundle(b) { const p = Object.entries(b).filter(([, n]) => n > 0).map(([r, n]) => `${n} ${RES_LABEL[r] || r}`); return p.length ? p.join(', ') : 'nothing'; }

function renderLog() {
  const el = $('log'); el.innerHTML = '';
  state.log.slice().reverse().forEach((line) => { const li = document.createElement('li'); li.textContent = line; el.appendChild(li); });
}

/* ---------- board ---------- */
function renderBoard() {
  const svg = $('board'); svg.innerHTML = '';
  if (!state.board) return;
  const { hexes, vertices, edges, ports, robber } = state.board;
  const xs = vertices.map((v) => v.x).concat(ports.map((p) => p.x));
  const ys = vertices.map((v) => v.y).concat(ports.map((p) => p.y));
  const pad = 46;
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  const w = Math.max(...xs) - minX + pad, h = Math.max(...ys) - minY + pad;
  svg.setAttribute('viewBox', `${minX} ${minY} ${w} ${h}`);
  const ns = (tag, attrs, parent) => { const e = document.createElementNS(SVG_NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); (parent || svg).appendChild(e); return e; };

  // sea backdrop
  ns('rect', { x: minX, y: minY, width: w, height: h, fill: 'url(#sea)' });
  const defs = ns('defs', {});
  defs.innerHTML = `<radialGradient id="sea" cx="50%" cy="40%" r="75%">
      <stop offset="0%" stop-color="#1a6076"/><stop offset="100%" stop-color="#0d3a48"/></radialGradient>`;

  // ports: dashed tethers + badge
  ports.forEach((p) => {
    ns('line', { x1: p.x, y1: p.y, x2: p.ex1, y2: p.ey1, stroke: '#ffffff66', 'stroke-width': 2, 'stroke-dasharray': '4 4' });
    ns('line', { x1: p.x, y1: p.y, x2: p.ex2, y2: p.ey2, stroke: '#ffffff66', 'stroke-width': 2, 'stroke-dasharray': '4 4' });
    const owned = state.myPorts && state.myPorts[p.type];
    ns('circle', { cx: p.x, cy: p.y, r: 18, fill: '#f3e9d2', stroke: owned ? '#d8a44b' : '#0a2c36', 'stroke-width': owned ? 3 : 2 });
    if (p.type === '3:1') { ns('text', { x: p.x, y: p.y, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 11, 'font-weight': 700, fill: '#2c2418' }).textContent = '3:1'; }
    else { ns('circle', { cx: p.x, cy: p.y - 4, r: 7, fill: RES_COLORS[p.type], stroke: '#0a2c36', 'stroke-width': 1 }); ns('text', { x: p.x, y: p.y + 8, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 700, fill: '#2c2418' }).textContent = '2:1'; }
  });

  // hexes + icons + tokens
  hexes.forEach((hx) => {
    const poly = ns('polygon', { points: hexPoints(hx.x, hx.y), fill: RES_COLORS[hx.resource], class: 'hex' });
    if (mode === 'robber' && isMyTurn() && state.robberStep) { poly.classList.add('hextarget'); poly.onclick = () => send('move_robber', { hexId: hx.id }); }
    resourceIcon(ns, hx);
    if (hx.number) {
      ns('circle', { cx: hx.x, cy: hx.y + 16, r: 15, class: 'numtok' });
      ns('text', { x: hx.x, y: hx.y + 13, class: 'numtxt' + (hx.number === 6 || hx.number === 8 ? ' hot' : ''), 'font-size': 16 }).textContent = hx.number;
      numberPips(ns, hx.x, hx.y + 25, hx.number, hx.number === 6 || hx.number === 8);
    }
  });

  // robber
  const rh = hexes[robber];
  if (rh) { ns('circle', { cx: rh.x - 20, cy: rh.y - 10, r: 8, class: 'robber' }); ns('rect', { x: rh.x - 26, y: rh.y - 4, width: 12, height: 18, rx: 5, class: 'robber' }); }

  // roads
  Object.entries(state.roads).forEach(([eid, owner]) => { const e = edges[eid]; ns('line', { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, stroke: playerById(owner)?.color || '#000', class: 'road' }); });

  // road targets
  if (isMyTurn() && (mode === 'road' || (state.phase === 'setup' && state.setup.expect === 'road'))) {
    edges.forEach((e) => {
      if (state.roads[e.id] !== undefined || !edgeBuildable(e)) return;
      const t = ns('line', { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, class: 'etarget show' });
      t.onclick = () => { if (state.phase === 'setup') send('setup_road', { edgeId: e.id }); else send('build_road', { edgeId: e.id }); mode = null; };
    });
  }

  // buildings
  Object.entries(state.buildings).forEach(([vid, b]) => {
    const v = vertices[vid], col = playerById(b.owner)?.color || '#000';
    const g = ns('g', { class: 'building' });
    if (b.type === 'city') { ns('rect', { x: v.x - 11, y: v.y - 6, width: 22, height: 15, rx: 3, fill: col }, g); ns('rect', { x: v.x - 11, y: v.y - 14, width: 11, height: 10, rx: 2, fill: col }, g); }
    else { ns('polygon', { points: `${v.x - 9},${v.y + 7} ${v.x - 9},${v.y - 3} ${v.x},${v.y - 11} ${v.x + 9},${v.y - 3} ${v.x + 9},${v.y + 7}`, fill: col }, g); }
    if (mode === 'city' && isMyTurn() && b.owner === meId() && b.type === 'settlement') { g.style.cursor = 'pointer'; g.onclick = () => { send('build_city', { vertexId: +vid }); mode = null; }; }
  });

  // settlement targets
  if (isMyTurn() && (mode === 'settlement' || (state.phase === 'setup' && state.setup.expect === 'settlement'))) {
    vertices.forEach((v) => {
      if (!vertexBuildable(v)) return;
      const t = ns('circle', { cx: v.x, cy: v.y, r: 11, class: 'vtarget show' });
      t.onclick = () => { if (state.phase === 'setup') send('setup_settlement', { vertexId: v.id }); else send('build_settlement', { vertexId: v.id }); mode = null; };
    });
  }
}

function hexPoints(cx, cy) { const s = 60, out = []; for (let i = 0; i < 6; i++) { const a = (Math.PI / 180) * (60 * i - 30); out.push(`${(cx + s * Math.cos(a)).toFixed(1)},${(cy + s * Math.sin(a)).toFixed(1)}`); } return out.join(' '); }

/* resource icon glyphs drawn in a darker tone, centered above the token */
function resourceIcon(ns, hx) {
  const x = hx.x, y = hx.y - 14, c = RES_DARK[hx.resource], g = ns('g', { opacity: 0.85 });
  const tri = (px, py, w, h, fill) => ns('polygon', { points: `${px},${py - h} ${px - w},${py} ${px + w},${py}`, fill }, g);
  if (hx.resource === 'wood') { tri(x - 9, y + 6, 8, 16, c); tri(x + 8, y + 8, 7, 14, c); ns('rect', { x: x - 10, y: y + 6, width: 3, height: 6, fill: '#3a2a18' }, g); ns('rect', { x: x + 7, y: y + 8, width: 3, height: 5, fill: '#3a2a18' }, g); }
  else if (hx.resource === 'brick') { [0, 1, 2].forEach((r) => { for (let cc = 0; cc < 2; cc++) ns('rect', { x: x - 12 + cc * 13 + (r % 2 ? 6 : 0), y: y - 6 + r * 7, width: 11, height: 5, rx: 1, fill: c, stroke: '#5c2410', 'stroke-width': 0.6 }, g); }); }
  else if (hx.resource === 'sheep') { ns('ellipse', { cx: x, cy: y + 2, rx: 13, ry: 9, fill: '#f4efe2', stroke: c, 'stroke-width': 1.5 }, g); ns('circle', { cx: x + 11, cy: y - 2, r: 5, fill: c }, g); ns('rect', { x: x - 8, y: y + 9, width: 2.5, height: 5, fill: c }, g); ns('rect', { x: x + 4, y: y + 9, width: 2.5, height: 5, fill: c }, g); }
  else if (hx.resource === 'wheat') { for (let i = -1; i <= 1; i++) { const sx = x + i * 8; ns('line', { x1: sx, y1: y + 12, x2: sx, y2: y - 8, stroke: c, 'stroke-width': 2 }, g); for (let k = 0; k < 3; k++) { ns('line', { x1: sx, y1: y - 6 + k * 5, x2: sx - 5, y2: y - 9 + k * 5, stroke: c, 'stroke-width': 1.6 }, g); ns('line', { x1: sx, y1: y - 6 + k * 5, x2: sx + 5, y2: y - 9 + k * 5, stroke: c, 'stroke-width': 1.6 }, g); } } }
  else if (hx.resource === 'ore') { tri(x - 8, y + 10, 11, 20, c); tri(x + 9, y + 10, 9, 16, c); ns('polygon', { points: `${x - 8},${y - 10} ${x - 12},${y - 4} ${x - 4},${y - 4}`, fill: '#eef3f6' }, g); }
  else if (hx.resource === 'desert') { ns('path', { d: `M ${x - 15} ${y + 8} Q ${x - 6} ${y - 2} ${x + 2} ${y + 6} Q ${x + 9} ${y + 12} ${x + 16} ${y + 4}`, fill: 'none', stroke: c, 'stroke-width': 2 }, g); ns('circle', { cx: x + 10, cy: y - 8, r: 5, fill: '#e8b84b' }, g); }
}

function numberPips(ns, x, y, num, hot) {
  const pipCount = { 2: 1, 12: 1, 3: 2, 11: 2, 4: 3, 10: 3, 5: 4, 9: 4, 6: 5, 8: 5 }[num] || 0;
  const total = pipCount, startX = x - (total - 1) * 2.5;
  for (let i = 0; i < total; i++) ns('circle', { cx: startX + i * 5, cy: y, r: 1.6, fill: hot ? '#b03a2e' : '#2c2418' });
}

function dieSVG(n) {
  const pos = { TL: [12, 12], TR: [28, 12], ML: [12, 20], MR: [28, 20], BL: [12, 28], BR: [28, 28], C: [20, 20] };
  const faces = { 1: ['C'], 2: ['TL', 'BR'], 3: ['TL', 'C', 'BR'], 4: ['TL', 'TR', 'BL', 'BR'], 5: ['TL', 'TR', 'C', 'BL', 'BR'], 6: ['TL', 'TR', 'ML', 'MR', 'BL', 'BR'] };
  const pips = (faces[n] || []).map((k) => `<circle cx="${pos[k][0]}" cy="${pos[k][1]}" r="3" fill="#2c2418"/>`).join('');
  return `<svg class="die" viewBox="0 0 40 40"><rect x="2" y="2" width="36" height="36" rx="8" fill="#fffdf6"/>${pips}</svg>`;
}

function vertexBuildable(v) {
  if (state.buildings[v.id]) return false;
  if (v.adj.some((n) => state.buildings[n])) return false;
  if (state.phase === 'setup') return true;
  return v.edges.some((eid) => state.roads[eid] === meId());
}
function edgeBuildable(e) {
  if (state.roads[e.id] !== undefined) return false;
  if (state.phase === 'setup') return e.v.includes(state.setup.lastVertex);
  return e.v.some((vid) => { const b = state.buildings[vid]; if (b && b.owner === meId()) return true; return state.board.vertices[vid].edges.some((eid) => state.roads[eid] === meId()); });
}

/* ---------- gain popup + event toasts ---------- */
function handleGain() {
  if (!state.gainSeq || state.gainSeq <= lastGainSeq) { lastGainSeq = Math.max(lastGainSeq, state.gainSeq || 0); return; }
  lastGainSeq = state.gainSeq;
  const g = state.yourGain; if (!g) return;
  const items = RESOURCES.filter((r) => g[r] > 0);
  if (!items.length) return;
  let pop = $('gain-pop');
  if (!pop) { pop = document.createElement('div'); pop.id = 'gain-pop'; document.body.appendChild(pop); }
  pop.innerHTML = `<div class="gain-title">You collected</div><div class="gain-cards">` +
    items.map((r) => `<span class="gain-card" style="background:${RES_COLORS[r]}"><span>${g[r]}</span>${RES_LABEL[r]}</span>`).join('') + `</div>`;
  pop.classList.remove('hidden'); pop.classList.add('show');
  clearTimeout(pop._t); pop._t = setTimeout(() => pop.classList.remove('show'), 2600);
}
function handleEvents() {
  if (!state.events || !state.events.length) return;
  const fresh = state.events.filter((e) => e.id > lastEventId);
  if (!fresh.length) return;
  lastEventId = Math.max(...state.events.map((e) => e.id));
  const last = fresh[fresh.length - 1];
  toast(last.text, last.kind);
}

/* ---------- modals ---------- */
function closeModal() { $('modal-root').innerHTML = ''; currentModal = null; }
function overlay(type) {
  $('modal-root').innerHTML = ''; currentModal = { type };
  const o = document.createElement('div'); o.className = 'overlay';
  const m = document.createElement('div'); m.className = 'modal';
  o.appendChild(m); $('modal-root').appendChild(o); return m;
}
function renderModals() {
  if (state.mustDiscard > 0) { if (!currentModal || currentModal.type !== 'discard') openDiscard(); return; }
  if (isMyTurn() && state.stealCandidates.length) { if (!currentModal || currentModal.type !== 'steal') openSteal(); return; }
  if (currentModal && (currentModal.type === 'discard' || currentModal.type === 'steal')) closeModal();
}

function openDiscard() {
  const m = overlay('discard');
  const need = state.mustDiscard, my = myPlayer();
  const sel = {}; RESOURCES.forEach((r) => (sel[r] = 0));
  m.innerHTML = `<h2>Discard ${need} cards</h2><p>You hold more than 7 cards after the 7. Choose which to discard.</p>`;
  const pickers = document.createElement('div'); pickers.className = 'res-pickers';
  RESOURCES.forEach((r) => {
    if (my.resources[r] <= 0) return;
    const rowEl = document.createElement('div'); rowEl.className = 'res-row';
    rowEl.innerHTML = `<span class="label"><span class="dot" style="background:${RES_COLORS[r]}"></span>${RES_LABEL[r]} (have ${my.resources[r]})</span>`;
    const step = document.createElement('div'); step.className = 'stepper';
    const val = document.createElement('span'); val.textContent = '0';
    step.appendChild(mkBtn('−', () => { if (sel[r] > 0) { sel[r]--; val.textContent = sel[r]; upd(); } }));
    step.appendChild(val);
    step.appendChild(mkBtn('+', () => { const t = RESOURCES.reduce((s, k) => s + sel[k], 0); if (sel[r] < my.resources[r] && t < need) { sel[r]++; val.textContent = sel[r]; upd(); } }));
    rowEl.appendChild(step); pickers.appendChild(rowEl);
  });
  m.appendChild(pickers);
  const confirm = mkBtn(`Discard (0/${need})`, () => { const t = RESOURCES.reduce((s, k) => s + sel[k], 0); if (t !== need) return toast(`Select exactly ${need}.`, 'bad'); send('discard', { sel }); });
  confirm.className = 'primary'; m.appendChild(confirm);
  function upd() { confirm.textContent = `Discard (${RESOURCES.reduce((s, k) => s + sel[k], 0)}/${need})`; }
}

function openSteal() {
  const m = overlay('steal');
  m.innerHTML = `<h2>Steal a card</h2><p>Pick a player by the robber to steal one random card.</p>`;
  const list = document.createElement('div'); list.className = 'victim-list';
  state.stealCandidates.forEach((id) => { const p = playerById(id); list.appendChild(mkBtn(`${p.name} — ${p.handCount} cards`, () => send('steal', { victimId: id }))); });
  m.appendChild(list);
}

function resSelect(val, onChange) {
  const sel = document.createElement('select'); sel.className = 'res-select';
  RESOURCES.forEach((r) => { const o = document.createElement('option'); o.value = r; o.textContent = RES_LABEL[r]; sel.appendChild(o); });
  sel.value = val; sel.onchange = () => onChange(sel.value); return sel;
}

function openBankTrade() {
  const m = overlay('bank'); let give = 'wood', want = 'brick';
  m.innerHTML = `<h2>Bank / port trade</h2>`;
  const info = document.createElement('p'); info.className = 'rate-info';
  const updRate = () => { const ratio = state.myRatios[give] || 4; info.textContent = `You give ${ratio} ${RES_LABEL[give]} → receive 1 ${RES_LABEL[want]}.`; };
  const l1 = document.createElement('label'); l1.textContent = 'Give'; l1.appendChild(resSelect(give, (v) => { give = v; updRate(); })); m.appendChild(l1);
  const l2 = document.createElement('label'); l2.textContent = 'Receive'; l2.appendChild(resSelect(want, (v) => { want = v; updRate(); })); m.appendChild(l2);
  m.appendChild(info); updRate();
  const row = document.createElement('div'); row.className = 'btn-row'; row.style.marginTop = '14px';
  row.appendChild(mkBtn('Cancel', closeModal));
  const go = mkBtn('Trade', () => { send('bank_trade', { give, want }); closeModal(); }); go.className = 'primary'; row.appendChild(go);
  m.appendChild(row);
}

function openMonopoly() {
  const m = overlay('monopoly'); let res = 'wood';
  m.innerHTML = `<h2>Monopoly</h2><p>Name a resource. Every other player hands you all of theirs.</p>`;
  const l = document.createElement('label'); l.textContent = 'Take all'; l.appendChild(resSelect(res, (v) => (res = v))); m.appendChild(l);
  const row = document.createElement('div'); row.className = 'btn-row'; row.style.marginTop = '14px';
  row.appendChild(mkBtn('Cancel', closeModal));
  const go = mkBtn('Play Monopoly', () => { send('play_monopoly', { resource: res }); closeModal(); }); go.className = 'primary'; row.appendChild(go);
  m.appendChild(row);
}

function openYearOfPlenty() {
  const m = overlay('yop'); let r1 = 'wood', r2 = 'brick';
  m.innerHTML = `<h2>Year of Plenty</h2><p>Take any two resources from the bank.</p>`;
  const l1 = document.createElement('label'); l1.textContent = 'First'; l1.appendChild(resSelect(r1, (v) => (r1 = v))); m.appendChild(l1);
  const l2 = document.createElement('label'); l2.textContent = 'Second'; l2.appendChild(resSelect(r2, (v) => (r2 = v))); m.appendChild(l2);
  const row = document.createElement('div'); row.className = 'btn-row'; row.style.marginTop = '14px';
  row.appendChild(mkBtn('Cancel', closeModal));
  const go = mkBtn('Take cards', () => { send('play_year_of_plenty', { r1, r2 }); closeModal(); }); go.className = 'primary'; row.appendChild(go);
  m.appendChild(row);
}

function openOfferModal() {
  const m = overlay('offer');
  const my = myPlayer();
  const give = {}, want = {}; RESOURCES.forEach((r) => { give[r] = 0; want[r] = 0; });
  m.innerHTML = `<h2>Offer a trade</h2><p>Propose what you give and what you want. Other players can accept, then you confirm.</p>`;
  const cols = document.createElement('div'); cols.className = 'offer-cols';

  const buildCol = (title, bag, maxFn) => {
    const col = document.createElement('div'); col.className = 'offer-col';
    col.innerHTML = `<h3>${title}</h3>`;
    RESOURCES.forEach((r) => {
      const rowEl = document.createElement('div'); rowEl.className = 'res-row';
      rowEl.innerHTML = `<span class="label"><span class="dot" style="background:${RES_COLORS[r]}"></span>${RES_LABEL[r]}</span>`;
      const step = document.createElement('div'); step.className = 'stepper';
      const val = document.createElement('span'); val.textContent = '0';
      step.appendChild(mkBtn('−', () => { if (bag[r] > 0) { bag[r]--; val.textContent = bag[r]; } }));
      step.appendChild(val);
      step.appendChild(mkBtn('+', () => { const max = maxFn ? maxFn(r) : 19; if (bag[r] < max) { bag[r]++; val.textContent = bag[r]; } }));
      rowEl.appendChild(step); col.appendChild(rowEl);
    });
    return col;
  };
  cols.appendChild(buildCol('You give', give, (r) => my.resources[r]));
  cols.appendChild(buildCol('You want', want, () => 19));
  m.appendChild(cols);

  const row = document.createElement('div'); row.className = 'btn-row'; row.style.marginTop = '14px';
  row.appendChild(mkBtn('Cancel', closeModal));
  const go = mkBtn('Send offer', () => {
    const gAny = RESOURCES.some((r) => give[r] > 0), wAny = RESOURCES.some((r) => want[r] > 0);
    if (!gAny && !wAny) return toast('Set something to trade.', 'bad');
    send('make_offer', { give, want }); closeModal();
  });
  go.className = 'primary'; row.appendChild(go);
  m.appendChild(row);
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

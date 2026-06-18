/* client.js — UI + realtime client for Hex Settlers */
const socket = io();
const $ = (id) => document.getElementById(id);

const RES_COLORS = { wood: '#3f8a4f', brick: '#c1572f', sheep: '#8fb84e', wheat: '#e3b23c', ore: '#7d8a99', desert: '#d9c79b' };
const RES_LABEL = { wood: 'Wood', brick: 'Brick', sheep: 'Sheep', wheat: 'Wheat', ore: 'Ore' };
const RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];

let state = null;
let me = null;          // { roomId, playerId }
let mode = null;        // 'road' | 'settlement' | 'city' | 'robber' | null
let SVG_NS = 'http://www.w3.org/2000/svg';

/* ---------- session persistence for reconnect ---------- */
function saveSession(s) { localStorage.setItem('hexsettle', JSON.stringify(s)); }
function loadSession() { try { return JSON.parse(localStorage.getItem('hexsettle')); } catch { return null; } }
function clearSession() { localStorage.removeItem('hexsettle'); }

/* ---------- toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}
socket.on('error_msg', (m) => toast(m));

/* ---------- lobby ---------- */
$('btn-create').onclick = () => {
  const name = $('name').value.trim();
  if (!name) return ($('lobby-error').textContent = 'Enter a name first.');
  socket.emit('create_room', { name }, (res) => {
    if (res.error) return ($('lobby-error').textContent = res.error);
    me = { roomId: res.roomId, playerId: res.playerId };
    saveSession(me);
  });
};
$('btn-join').onclick = () => {
  const name = $('name').value.trim();
  const roomId = $('room-code').value.trim().toUpperCase();
  if (!name) return ($('lobby-error').textContent = 'Enter a name first.');
  if (!roomId) return ($('lobby-error').textContent = 'Enter a room code.');
  socket.emit('join_room', { name, roomId }, (res) => {
    if (res.error) return ($('lobby-error').textContent = res.error);
    me = { roomId: res.roomId, playerId: res.playerId };
    saveSession(me);
  });
};

/* attempt reconnect on load */
socket.on('connect', () => {
  const s = loadSession();
  if (s && !me) {
    socket.emit('rejoin', s, (res) => {
      if (res && !res.error) { me = s; } else { clearSession(); }
    });
  }
});

$('copy-link').onclick = () => {
  const url = `${location.origin}/?room=${state.roomId}`;
  navigator.clipboard?.writeText(url);
  toast('Invite link copied.');
};

// Prefill room code from ?room= in URL
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('room-code').value = urlRoom.toUpperCase();

/* ---------- main state handler ---------- */
socket.on('state', (s) => {
  state = s;
  if (!me) me = { roomId: s.roomId, playerId: s.you };
  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');
  render();
});

/* ---------- helpers ---------- */
function send(type, payload) { socket.emit('action', { type, payload }); }
function meId() { return state.you; }
function isMyTurn() { return state.current === meId(); }
function playerById(id) { return state.players.find((p) => p.id === id); }

/* ---------- rendering ---------- */
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
  else if (state.phase === 'over') {
    const w = playerById(state.winner);
    banner.textContent = w ? `🏆 ${w.name} wins!` : 'Game over';
  } else {
    const cur = playerById(state.current);
    banner.textContent = isMyTurn() ? 'Your turn' : `${cur ? cur.name : '—'}'s turn`;
  }
  const dice = $('dice');
  if (state.dice) {
    dice.classList.remove('hidden');
    $('die1').textContent = state.dice[0];
    $('die2').textContent = state.dice[1];
  } else dice.classList.add('hidden');
}

function renderPlayers() {
  const el = $('players');
  el.innerHTML = '';
  state.players.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'prow' + (p.id === state.current ? ' active' : '') + (p.connected ? '' : ' off');
    row.innerHTML = `
      <span class="swatch" style="background:${p.color}"></span>
      <span class="pname">${escapeHtml(p.name)}${p.isHost ? ' ★' : ''}</span>
      <span class="pmeta">
        <span title="Victory points"><strong>${p.vp}</strong> VP</span>
        <span title="Cards in hand">🂠 ${p.handCount}</span>
        ${state.longestRoad === p.id ? '<span class="badge">Road</span>' : ''}
      </span>`;
    el.appendChild(row);
  });
}

function renderHand() {
  const el = $('hand');
  el.innerHTML = '';
  const my = playerById(meId());
  if (!my || !my.resources) { el.innerHTML = '<span class="hint">—</span>'; return; }
  let any = false;
  RESOURCES.forEach((r) => {
    const n = my.resources[r];
    if (n <= 0) return;
    any = true;
    const c = document.createElement('span');
    c.className = 'card';
    c.style.background = RES_COLORS[r] + '55';
    c.innerHTML = `<span class="dot" style="background:${RES_COLORS[r]}"></span>${RES_LABEL[r]} ${n}`;
    el.appendChild(c);
  });
  if (!any) el.innerHTML = '<span class="hint">No resources yet.</span>';
}

function renderControls() {
  const el = $('controls');
  el.innerHTML = '';
  const add = (html) => { const d = document.createElement('div'); d.innerHTML = html; while (d.firstChild) el.appendChild(d.firstChild); };

  if (state.phase === 'lobby') {
    const my = playerById(meId());
    add(`<p class="hint">Share the room code <strong>${state.roomId}</strong> with friends. ${state.players.length}/4 joined.</p>`);
    if (my && my.isHost) {
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = state.players.length < 2 ? 'Need 2+ players' : 'Start game';
      b.disabled = state.players.length < 2;
      b.onclick = () => send('start', {});
      el.appendChild(b);
    } else add('<p class="hint">Waiting for the host to start…</p>');
    return;
  }

  if (state.phase === 'over') {
    add('<p class="hint">Game over. Refresh to play again.</p>');
    return;
  }

  if (state.phase === 'setup') {
    if (isMyTurn()) {
      mode = state.setup.expect === 'settlement' ? 'settlement' : 'road';
      add(`<p class="hint">Setup: place a <strong>${state.setup.expect}</strong> on the board. ` +
          `Your second settlement collects starting resources.</p>`);
    } else { mode = null; add('<p class="hint">Waiting for other players to set up…</p>'); }
    return;
  }

  // ---- play phase ----
  if (!isMyTurn()) {
    mode = null;
    // others can still respond to an open trade offer
    if (state.offer && state.offer.from !== meId()) renderTradeResponse(el);
    else add('<p class="hint">Waiting for your turn. You still collect resources on every roll.</p>');
    return;
  }

  // It's my turn
  if (state.mustDiscard > 0) { add('<p class="hint">Discard cards to continue (see dialog).</p>'); return; }
  if (state.robberStep) { mode = 'robber'; add('<p class="hint">Move the robber: click a hex.</p>'); return; }
  if (state.stealCandidates.length) { mode = null; add('<p class="hint">Choose someone to steal from (see dialog).</p>'); return; }

  if (!state.hasRolled) {
    const b = document.createElement('button');
    b.className = 'primary'; b.textContent = '🎲 Roll dice';
    b.onclick = () => send('roll', {});
    el.appendChild(b);
    add('<p class="hint">Roll to produce resources, then build or trade.</p>');
    mode = null;
    return;
  }

  // build buttons
  add(`<div class="btn-row">
        <button class="act ${mode === 'road' ? 'on' : ''}" data-m="road">Road</button>
        <button class="act ${mode === 'settlement' ? 'on' : ''}" data-m="settlement">Settle</button>
        <button class="act ${mode === 'city' ? 'on' : ''}" data-m="city">City</button>
      </div>`);
  el.querySelectorAll('[data-m]').forEach((btn) => {
    btn.onclick = () => { mode = mode === btn.dataset.m ? null : btn.dataset.m; render(); };
  });
  add(`<p class="hint">Road: 1 wood + 1 brick · Settlement: wood+brick+sheep+wheat · City: 2 wheat + 3 ore</p>`);

  const trade = document.createElement('div');
  trade.className = 'btn-row';
  const bankBtn = mkBtn('Bank trade (4:1)', () => openBankTrade());
  const offerBtn = mkBtn('Offer trade', () => openOfferModal());
  trade.appendChild(bankBtn); trade.appendChild(offerBtn);
  el.appendChild(trade);

  if (state.offer && state.offer.from === meId()) renderOwnOffer(el);

  const endBtn = mkBtn('End turn', () => { mode = null; send('end_turn', {}); });
  endBtn.className = 'primary';
  el.appendChild(endBtn);
}

function mkBtn(label, fn, cls) {
  const b = document.createElement('button');
  b.textContent = label; b.onclick = fn; if (cls) b.className = cls;
  return b;
}

function renderOwnOffer(el) {
  const box = document.createElement('div');
  box.innerHTML = `<p class="hint">Your offer is open: give ${fmtBundle(state.offer.give)} for ${fmtBundle(state.offer.want)}.</p>`;
  const accepters = state.offer.responders;
  if (accepters.length) {
    accepters.forEach((id) => {
      const p = playerById(id);
      box.appendChild(mkBtn(`Trade with ${p.name}`, () => send('confirm_trade', { withId: id })));
    });
  } else {
    const w = document.createElement('p'); w.className = 'hint'; w.textContent = 'Waiting for someone to accept…';
    box.appendChild(w);
  }
  box.appendChild(mkBtn('Cancel offer', () => send('cancel_offer', {})));
  el.appendChild(box);
}

function renderTradeResponse(el) {
  const o = state.offer;
  const from = playerById(o.from);
  const box = document.createElement('div');
  box.innerHTML = `<p class="hint"><strong>${from.name}</strong> offers ${fmtBundle(o.give)} and wants ${fmtBundle(o.want)} from you.</p>`;
  const accepted = o.responders.includes(meId());
  box.appendChild(mkBtn(accepted ? '✓ Accepted (waiting)' : 'Accept offer', () => send('respond_offer', { accept: !accepted })));
  el.appendChild(box);
}

function fmtBundle(b) {
  const parts = Object.entries(b).filter(([, n]) => n > 0).map(([r, n]) => `${n} ${RES_LABEL[r] || r}`);
  return parts.length ? parts.join(', ') : 'nothing';
}

function renderLog() {
  const el = $('log');
  el.innerHTML = '';
  state.log.slice().reverse().forEach((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    el.appendChild(li);
  });
}

/* ---------- board ---------- */
function renderBoard() {
  const svg = $('board');
  svg.innerHTML = '';
  if (!state.board) return;
  const { hexes, vertices, edges, robber } = state.board;

  // viewBox from vertex extents
  const xs = vertices.map((v) => v.x), ys = vertices.map((v) => v.y);
  const pad = 50;
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  const w = Math.max(...xs) - minX + pad, h = Math.max(...ys) - minY + pad;
  svg.setAttribute('viewBox', `${minX} ${minY} ${w} ${h}`);

  const ns = (tag, attrs, parent) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    (parent || svg).appendChild(e);
    return e;
  };

  // hexes
  hexes.forEach((hx) => {
    const pts = hexPoints(hx.x, hx.y);
    const poly = ns('polygon', { points: pts, fill: RES_COLORS[hx.resource], class: 'hex' });
    if (mode === 'robber' && isMyTurn() && state.robberStep) {
      poly.classList.add('hextarget');
      poly.onclick = () => send('move_robber', { hexId: hx.id });
    }
    if (hx.number) {
      ns('circle', { cx: hx.x, cy: hx.y, r: 17, class: 'numtok' });
      ns('text', { x: hx.x, y: hx.y, class: 'numtxt' + (hx.number === 6 || hx.number === 8 ? ' hot' : ''), 'font-size': 18 }).textContent = hx.number;
    }
  });

  // robber
  const rh = hexes[robber];
  if (rh) {
    ns('circle', { cx: rh.x - 22, cy: rh.y + 18, r: 9, class: 'robber' });
    ns('rect', { x: rh.x - 28, y: rh.y + 24, width: 12, height: 16, rx: 4, class: 'robber' });
  }

  // roads (existing)
  Object.entries(state.roads).forEach(([eid, owner]) => {
    const e = edges[eid];
    const col = playerById(owner)?.color || '#000';
    ns('line', { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, stroke: col, class: 'road' });
  });

  // edge targets (road building / setup road)
  if (isMyTurn() && (mode === 'road' || (state.phase === 'setup' && state.setup.expect === 'road'))) {
    edges.forEach((e) => {
      if (state.roads[e.id] !== undefined) return;
      if (!edgeBuildable(e)) return;
      const t = ns('line', { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, class: 'etarget show' });
      t.onclick = () => {
        if (state.phase === 'setup') send('setup_road', { edgeId: e.id });
        else send('build_road', { edgeId: e.id });
        mode = null;
      };
    });
  }

  // buildings
  Object.entries(state.buildings).forEach(([vid, b]) => {
    const v = vertices[vid];
    const col = playerById(b.owner)?.color || '#000';
    const g = ns('g', { class: 'building' });
    if (b.type === 'city') {
      ns('rect', { x: v.x - 11, y: v.y - 7, width: 22, height: 16, rx: 3, fill: col }, g);
      ns('rect', { x: v.x - 11, y: v.y - 15, width: 11, height: 10, rx: 2, fill: col }, g);
    } else {
      ns('polygon', { points: `${v.x - 9},${v.y + 7} ${v.x - 9},${v.y - 3} ${v.x},${v.y - 11} ${v.x + 9},${v.y - 3} ${v.x + 9},${v.y + 7}`, fill: col }, g);
    }
    // city-upgrade clicks on own settlements
    if (mode === 'city' && isMyTurn() && b.owner === meId() && b.type === 'settlement') {
      g.style.cursor = 'pointer';
      g.onclick = () => { send('build_city', { vertexId: +vid }); mode = null; };
    }
  });

  // vertex targets (settlement building / setup settlement)
  if (isMyTurn() && (mode === 'settlement' || (state.phase === 'setup' && state.setup.expect === 'settlement'))) {
    vertices.forEach((v) => {
      if (!vertexBuildable(v)) return;
      const t = ns('circle', { cx: v.x, cy: v.y, r: 11, class: 'vtarget show' });
      t.onclick = () => {
        if (state.phase === 'setup') send('setup_settlement', { vertexId: v.id });
        else send('build_settlement', { vertexId: v.id });
        mode = null;
      };
    });
  }
}

function hexPoints(cx, cy) {
  const s = 60, out = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    out.push(`${(cx + s * Math.cos(a)).toFixed(1)},${(cy + s * Math.sin(a)).toFixed(1)}`);
  }
  return out.join(' ');
}

/* client-side legality (for highlighting; server is authoritative) */
function vertexBuildable(v) {
  if (state.buildings[v.id]) return false;
  if (v.adj.some((n) => state.buildings[n])) return false;        // distance rule
  if (state.phase === 'setup') return true;
  // play: must touch one of my roads
  return v.edges.some((eid) => state.roads[eid] === meId());
}

function edgeBuildable(e) {
  if (state.roads[e.id] !== undefined) return false;
  if (state.phase === 'setup') {
    return e.v.includes(state.setup.lastVertex);
  }
  // play: connect to my road or my building
  return e.v.some((vid) => {
    const b = state.buildings[vid];
    if (b && b.owner === meId()) return true;
    return state.board.vertices[vid].edges.some((eid) => state.roads[eid] === meId());
  });
}

/* ---------- modals ---------- */
function renderModals() {
  const root = $('modal-root');
  root.innerHTML = '';
  if (state.mustDiscard > 0) return discardModal(root);
  if (isMyTurn() && state.stealCandidates.length) return stealModal(root);
}

function overlay(root) {
  const o = document.createElement('div'); o.className = 'overlay';
  const m = document.createElement('div'); m.className = 'modal';
  o.appendChild(m); root.appendChild(o);
  return m;
}

function discardModal(root) {
  const m = overlay(root);
  const need = state.mustDiscard;
  const my = playerById(meId());
  const sel = {}; RESOURCES.forEach((r) => (sel[r] = 0));
  m.innerHTML = `<h2>Discard ${need} cards</h2><p>You hold more than 7 cards. Choose which to discard.</p>`;
  const pickers = document.createElement('div'); pickers.className = 'res-pickers';
  RESOURCES.forEach((r) => {
    if (my.resources[r] <= 0) return;
    const row = document.createElement('div'); row.className = 'res-row';
    row.innerHTML = `<span class="label"><span class="dot" style="background:${RES_COLORS[r]}"></span>${RES_LABEL[r]} (have ${my.resources[r]})</span>`;
    const step = document.createElement('div'); step.className = 'stepper';
    const minus = mkBtn('−', () => { if (sel[r] > 0) { sel[r]--; upd(); } });
    const val = document.createElement('span'); val.textContent = '0';
    const plus = mkBtn('+', () => {
      const total = RESOURCES.reduce((s, k) => s + sel[k], 0);
      if (sel[r] < my.resources[r] && total < need) { sel[r]++; upd(); }
    });
    step.append(minus, val, plus); row.appendChild(step); pickers.appendChild(row);
    row._val = val; row._r = r;
  });
  m.appendChild(pickers);
  const confirm = mkBtn('Discard', () => {
    const total = RESOURCES.reduce((s, k) => s + sel[k], 0);
    if (total !== need) return toast(`Select exactly ${need}.`);
    send('discard', { sel });
  });
  confirm.className = 'primary';
  m.appendChild(confirm);
  function upd() {
    pickers.querySelectorAll('.res-row').forEach((row) => { if (row._val) row._val.textContent = sel[row._r]; });
    const total = RESOURCES.reduce((s, k) => s + sel[k], 0);
    confirm.textContent = `Discard (${total}/${need})`;
  }
  upd();
}

function stealModal(root) {
  const m = overlay(root);
  m.innerHTML = `<h2>Steal a card</h2><p>Pick a player adjacent to the robber to steal one random card from.</p>`;
  const list = document.createElement('div'); list.className = 'victim-list';
  state.stealCandidates.forEach((id) => {
    const p = playerById(id);
    list.appendChild(mkBtn(`${p.name} — ${p.handCount} cards`, () => send('steal', { victimId: id })));
  });
  m.appendChild(list);
}

function openBankTrade() {
  const root = $('modal-root'); const m = overlay(root);
  let give = 'wood', want = 'brick';
  m.innerHTML = `<h2>Bank trade</h2><p>Trade 4 of one resource for 1 of another.</p>`;
  const mkSel = (label, val, onChange) => {
    const wrap = document.createElement('label'); wrap.textContent = label;
    const sel = document.createElement('select');
    sel.style.cssText = 'width:100%;margin-top:6px;padding:10px;border-radius:9px;border:1px solid var(--parchment-edge);font-family:inherit;font-size:15px;';
    RESOURCES.forEach((r) => { const o = document.createElement('option'); o.value = r; o.textContent = RES_LABEL[r]; sel.appendChild(o); });
    sel.value = val; sel.onchange = () => onChange(sel.value);
    wrap.appendChild(sel); return wrap;
  };
  m.appendChild(mkSel('Give 4 of', give, (v) => (give = v)));
  m.appendChild(mkSel('Receive 1 of', want, (v) => (want = v)));
  const row = document.createElement('div'); row.className = 'btn-row'; row.style.marginTop = '14px';
  row.appendChild(mkBtn('Cancel', () => ($('modal-root').innerHTML = '')));
  const go = mkBtn('Trade', () => { send('bank_trade', { give, want }); $('modal-root').innerHTML = ''; }); go.className = 'primary';
  row.appendChild(go); m.appendChild(row);
}

function openOfferModal() {
  const root = $('modal-root'); const m = overlay(root);
  const give = {}, want = {}; RESOURCES.forEach((r) => { give[r] = 0; want[r] = 0; });
  const my = playerById(meId());
  m.innerHTML = `<h2>Offer a trade</h2><p>Propose what you give and what you want. Others can accept; you pick who.</p>`;
  const section = (title, store, maxFn) => {
    const h = document.createElement('h3'); h.textContent = title; h.style.margin = '10px 0 6px'; m.appendChild(h);
    const pickers = document.createElement('div'); pickers.className = 'res-pickers';
    RESOURCES.forEach((r) => {
      const row = document.createElement('div'); row.className = 'res-row';
      row.innerHTML = `<span class="label"><span class="dot" style="background:${RES_COLORS[r]}"></span>${RES_LABEL[r]}</span>`;
      const step = document.createElement('div'); step.className = 'stepper';
      const val = document.createElement('span'); val.textContent = '0';
      const minus = mkBtn('−', () => { if (store[r] > 0) { store[r]--; val.textContent = store[r]; } });
      const plus = mkBtn('+', () => { const mx = maxFn ? maxFn(r) : 9; if (store[r] < mx) { store[r]++; val.textContent = store[r]; } });
      step.append(minus, val, plus); row.appendChild(step); pickers.appendChild(row);
    });
    m.appendChild(pickers);
  };
  section('You give', give, (r) => (my.resources ? my.resources[r] : 0));
  section('You want', want, () => 9);
  const row = document.createElement('div'); row.className = 'btn-row'; row.style.marginTop = '8px';
  row.appendChild(mkBtn('Cancel', () => ($('modal-root').innerHTML = '')));
  const go = mkBtn('Send offer', () => { send('make_offer', { give, want }); $('modal-root').innerHTML = ''; }); go.className = 'primary';
  row.appendChild(go); m.appendChild(row);
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

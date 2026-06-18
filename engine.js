// engine.js — server-authoritative game logic (v2)
// Adds: development cards, largest army, harbors/ports, resource-gain events.
// No external deps. Exports the Room class used by server.js.

const SIZE = 60;
const COLORS = ['#c0392b', '#2f6fb0', '#3f8a4f', '#d9852f'];
const RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];

const COST = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  dev: { ore: 1, sheep: 1, wheat: 1 },
};

function makeDevDeck() {
  return shuffle([
    ...Array(14).fill('knight'),
    ...Array(5).fill('vp'),
    ...Array(2).fill('road_building'),
    ...Array(2).fill('monopoly'),
    ...Array(2).fill('year_of_plenty'),
  ]);
}

// 9 harbors: 4 generic (3:1) + one 2:1 per resource
const PORT_POOL = ['3:1', '3:1', '3:1', '3:1', 'wood', 'brick', 'sheep', 'wheat', 'ore'];

function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function hexCenter(q, r) { return { x: SIZE * Math.sqrt(3) * (q + r / 2), y: SIZE * 1.5 * r }; }
function hexCorners(c) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 180) * (60 * i - 30);
    pts.push({ x: c.x + SIZE * Math.cos(ang), y: c.y + SIZE * Math.sin(ang) });
  }
  return pts;
}

function createBoard() {
  const coords = [];
  for (let q = -2; q <= 2; q++)
    for (let r = -2; r <= 2; r++)
      if (Math.abs(q + r) <= 2) coords.push({ q, r });

  const landPool = shuffle([
    ...Array(4).fill('wood'), ...Array(4).fill('sheep'), ...Array(4).fill('wheat'),
    ...Array(3).fill('brick'), ...Array(3).fill('ore'), 'desert',
  ]);
  const numberPool = shuffle([2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12]);

  const hexes = coords.map((c, i) => {
    const center = hexCenter(c.q, c.r);
    return { id: i, q: c.q, r: c.r, x: Math.round(center.x), y: Math.round(center.y), resource: landPool[i], number: null };
  });
  let np = 0;
  hexes.forEach((h) => { if (h.resource !== 'desert') h.number = numberPool[np++]; });

  const vMap = {}, vertices = [], eMap = {}, edges = [];
  const key = (p) => `${Math.round(p.x)},${Math.round(p.y)}`;
  hexes.forEach((h) => {
    const corners = hexCorners({ x: h.x, y: h.y });
    const cornerIds = corners.map((p) => {
      const k = key(p);
      if (vMap[k] === undefined) {
        vMap[k] = vertices.length;
        vertices.push({ id: vertices.length, x: Math.round(p.x), y: Math.round(p.y), hexes: [], adj: [], edges: [] });
      }
      const id = vMap[k];
      if (!vertices[id].hexes.includes(h.id)) vertices[id].hexes.push(h.id);
      return id;
    });
    for (let i = 0; i < 6; i++) {
      const a = cornerIds[i], b = cornerIds[(i + 1) % 6];
      const ek = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (eMap[ek] === undefined) {
        const id = edges.length;
        eMap[ek] = id;
        edges.push({ id, v: [a, b], x1: vertices[a].x, y1: vertices[a].y, x2: vertices[b].x, y2: vertices[b].y });
      }
    }
  });
  edges.forEach((e) => {
    vertices[e.v[0]].adj.push(e.v[1]); vertices[e.v[1]].adj.push(e.v[0]);
    vertices[e.v[0]].edges.push(e.id); vertices[e.v[1]].edges.push(e.id);
  });

  // harbors along the coastline
  const sharedHexes = (e) => vertices[e.v[0]].hexes.filter((h) => vertices[e.v[1]].hexes.includes(h));
  const perimeter = edges.filter((e) => sharedHexes(e).length === 1);
  perimeter.forEach((e) => { const mx = (e.x1 + e.x2) / 2, my = (e.y1 + e.y2) / 2; e._ang = Math.atan2(my, mx); e._mx = mx; e._my = my; });
  perimeter.sort((a, b) => a._ang - b._ang);
  const portTypes = shuffle(PORT_POOL);
  const ports = [];
  for (let i = 0; i < 9; i++) {
    const e = perimeter[Math.floor((i * perimeter.length) / 9)];
    const out = 1.32;
    ports.push({
      id: i, type: portTypes[i], vertices: e.v.slice(),
      x: Math.round(e._mx * out), y: Math.round(e._my * out),
      ex1: e.x1, ey1: e.y1, ex2: e.x2, ey2: e.y2,
    });
  }

  const robber = hexes.findIndex((h) => h.resource === 'desert');
  return { hexes, vertices, edges, ports, robber };
}

function emptyHand() { return { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 }; }
function emptyDev() { return { knight: 0, vp: 0, road_building: 0, monopoly: 0, year_of_plenty: 0 }; }

class Room {
  constructor(id) {
    this.id = id;
    this.players = [];
    this.phase = 'lobby';
    this.board = null;
    this.buildings = {};
    this.roads = {};
    this.current = 0;
    this.dice = null;
    this.hasRolled = false;
    this.setup = null;
    this.pendingDiscards = {};
    this.robberStep = false;
    this.stealCandidates = [];
    this.offer = null;
    this.longestRoadHolder = null;
    this.largestArmyHolder = null;
    this.devDeck = [];
    this.freeRoads = 0;
    this.winner = null;
    this.log = [];
    this.events = [];
    this.eventId = 1;
    this.gainSeq = 0;
    this.lastGain = null;
  }

  addPlayer(name, socketId) {
    if (this.phase !== 'lobby') return { error: 'Game already started.' };
    if (this.players.length >= 4) return { error: 'Room is full (max 4).' };
    if (this.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) return { error: 'Name already taken in this room.' };
    const id = 'p' + Math.random().toString(36).slice(2, 9);
    this.players.push({
      id, name, socketId, connected: true,
      color: COLORS[this.players.length],
      resources: emptyHand(), dev: emptyDev(), devNew: emptyDev(),
      knightsPlayed: 0, playedDev: false,
      isHost: this.players.length === 0,
    });
    this.pushLog(`${name} joined.`);
    return { player: this.players[this.players.length - 1] };
  }
  reconnect(playerId, socketId) {
    const p = this.byId(playerId); if (!p) return false;
    p.socketId = socketId; p.connected = true; this.pushLog(`${p.name} reconnected.`); return true;
  }
  byId(id) { return this.players.find((p) => p.id === id); }
  curPlayer() { return this.players[this.current]; }
  pushLog(msg) { this.log.push(msg); if (this.log.length > 60) this.log.shift(); }
  notify(to, text, kind) { this.events.push({ id: this.eventId++, to, text, kind: kind || 'info' }); if (this.events.length > 200) this.events.shift(); }

  start(playerId) {
    const p = this.byId(playerId);
    if (!p || !p.isHost) return { error: 'Only the host can start.' };
    if (this.players.length < 2) return { error: 'Need at least 2 players.' };
    this.board = createBoard();
    this.devDeck = makeDevDeck();
    this.phase = 'setup';
    const order = this.players.map((_, i) => i);
    this.setup = { order: [...order, ...order.slice().reverse()], step: 0, expect: 'settlement', lastVertex: null };
    this.current = this.setup.order[0];
    this.pushLog('Game started. Place your first settlement.');
    return { ok: true };
  }

  busy() { return this.robberStep || this.stealCandidates.length > 0 || Object.keys(this.pendingDiscards).length > 0; }

  placeSetupSettlement(playerId, vertexId) {
    if (this.phase !== 'setup' || this.setup.expect !== 'settlement') return { error: 'Not time to place a settlement.' };
    if (this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    const v = this.board.vertices[vertexId];
    if (!v) return { error: 'Invalid spot.' };
    if (this.buildings[vertexId]) return { error: 'That spot is taken.' };
    if (v.adj.some((n) => this.buildings[n])) return { error: 'Too close to another settlement.' };
    this.buildings[vertexId] = { owner: playerId, type: 'settlement' };
    this.setup.lastVertex = vertexId;
    this.setup.expect = 'road';
    if (this.setup.step >= this.players.length) {
      const got = emptyHand(); let any = false;
      v.hexes.forEach((hid) => { const h = this.board.hexes[hid]; if (h.resource !== 'desert') { this.byId(playerId).resources[h.resource]++; got[h.resource]++; any = true; } });
      if (any) { this.gainSeq++; this.lastGain = { seq: this.gainSeq, gains: { [playerId]: got } }; }
    }
    this.pushLog(`${this.byId(playerId).name} placed a settlement.`);
    return { ok: true };
  }

  placeSetupRoad(playerId, edgeId) {
    if (this.phase !== 'setup' || this.setup.expect !== 'road') return { error: 'Not time to place a road.' };
    if (this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    const e = this.board.edges[edgeId];
    if (!e) return { error: 'Invalid road.' };
    if (this.roads[edgeId] !== undefined) return { error: 'That road exists.' };
    if (!e.v.includes(this.setup.lastVertex)) return { error: 'Road must touch your new settlement.' };
    this.roads[edgeId] = playerId;
    this.pushLog(`${this.byId(playerId).name} placed a road.`);
    this.setup.step++;
    if (this.setup.step >= this.setup.order.length) {
      this.phase = 'play';
      this.current = this.setup.order[this.setup.order.length - 1];
      this.hasRolled = false;
      this.updateLongestRoad();
      this.pushLog('Setup complete. Roll the dice!');
    } else { this.setup.expect = 'settlement'; this.current = this.setup.order[this.setup.step]; }
    return { ok: true };
  }

  rollDice(playerId) {
    if (this.phase !== 'play') return { error: 'Not in play.' };
    if (this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (this.hasRolled) return { error: 'You already rolled.' };
    if (this.busy()) return { error: 'Resolve the robber first.' };
    const d1 = 1 + Math.floor(Math.random() * 6), d2 = 1 + Math.floor(Math.random() * 6);
    this.dice = [d1, d2]; this.hasRolled = true;
    const total = d1 + d2;
    this.pushLog(`${this.curPlayer().name} rolled ${total}.`);
    if (total === 7) {
      this.pendingDiscards = {};
      this.players.forEach((p) => { const n = this.handSize(p); if (n > 7) this.pendingDiscards[p.id] = Math.floor(n / 2); });
      if (Object.keys(this.pendingDiscards).length === 0) this.robberStep = true;
      this.pushLog('Rolled a 7 — the robber stirs.');
    } else this.distribute(total);
    return { ok: true };
  }

  distribute(total) {
    const gains = {};
    this.players.forEach((p) => (gains[p.id] = emptyHand()));
    this.board.hexes.forEach((h) => {
      if (h.number !== total || this.board.robber === h.id) return;
      this.board.vertices.forEach((v) => {
        if (!v.hexes.includes(h.id)) return;
        const b = this.buildings[v.id]; if (!b) return;
        const amt = b.type === 'city' ? 2 : 1;
        this.byId(b.owner).resources[h.resource] += amt;
        gains[b.owner][h.resource] += amt;
      });
    });
    const trimmed = {};
    Object.entries(gains).forEach(([pid, g]) => { if (RESOURCES.some((r) => g[r] > 0)) trimmed[pid] = g; });
    this.gainSeq++; this.lastGain = { seq: this.gainSeq, gains: trimmed };
  }

  handSize(p) { return RESOURCES.reduce((s, r) => s + p.resources[r], 0); }
  devCount(p) { return Object.values(p.dev).reduce((a, b) => a + b, 0) + Object.values(p.devNew).reduce((a, b) => a + b, 0); }

  submitDiscard(playerId, sel) {
    const need = this.pendingDiscards[playerId];
    if (!need) return { error: 'You do not need to discard.' };
    const total = RESOURCES.reduce((s, r) => s + (sel[r] || 0), 0);
    if (total !== need) return { error: `Select exactly ${need} cards.` };
    const p = this.byId(playerId);
    for (const r of RESOURCES) if ((sel[r] || 0) > p.resources[r]) return { error: 'You do not have those cards.' };
    for (const r of RESOURCES) p.resources[r] -= (sel[r] || 0);
    delete this.pendingDiscards[playerId];
    this.pushLog(`${p.name} discarded ${need} cards.`);
    if (Object.keys(this.pendingDiscards).length === 0) this.robberStep = true;
    return { ok: true };
  }

  moveRobber(playerId, hexId) {
    if (this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (!this.robberStep) return { error: 'Not time to move the robber.' };
    if (hexId === this.board.robber) return { error: 'Move the robber to a new hex.' };
    if (!this.board.hexes[hexId]) return { error: 'Invalid hex.' };
    this.board.robber = hexId; this.robberStep = false;
    const victims = new Set();
    this.board.vertices.forEach((v) => {
      if (!v.hexes.includes(hexId)) return;
      const b = this.buildings[v.id];
      if (b && b.owner !== playerId && this.handSize(this.byId(b.owner)) > 0) victims.add(b.owner);
    });
    this.stealCandidates = [...victims];
    this.pushLog(`${this.byId(playerId).name} moved the robber.`);
    if (this.stealCandidates.length === 0) this.pushLog('No one to steal from.');
    return { ok: true };
  }

  steal(playerId, victimId) {
    if (this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (!this.stealCandidates.includes(victimId)) return { error: 'Cannot steal from them.' };
    const victim = this.byId(victimId), pool = [];
    RESOURCES.forEach((r) => { for (let i = 0; i < victim.resources[r]; i++) pool.push(r); });
    if (pool.length) {
      const r = pool[Math.floor(Math.random() * pool.length)];
      victim.resources[r]--; this.byId(playerId).resources[r]++;
      this.pushLog(`${this.byId(playerId).name} stole a card from ${victim.name}.`);
      this.notify(victimId, `${this.byId(playerId).name} stole 1 ${r} from you.`, 'bad');
      this.notify(playerId, `You stole 1 ${r} from ${victim.name}.`, 'good');
    }
    this.stealCandidates = [];
    return { ok: true };
  }

  canAfford(p, cost) { return Object.entries(cost).every(([r, n]) => p.resources[r] >= n); }
  pay(p, cost) { Object.entries(cost).forEach(([r, n]) => (p.resources[r] -= n)); }

  buildRoad(playerId, edgeId) {
    if (this.phase !== 'play' || this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (!this.hasRolled) return { error: 'Roll the dice first.' };
    if (this.busy()) return { error: 'Resolve the robber first.' };
    const e = this.board.edges[edgeId];
    if (!e || this.roads[edgeId] !== undefined) return { error: 'Cannot build there.' };
    const connected = e.v.some((vid) => {
      const b = this.buildings[vid];
      if (b && b.owner === playerId) return true;
      return this.board.vertices[vid].edges.some((eid) => this.roads[eid] === playerId);
    });
    if (!connected) return { error: 'Road must connect to your network.' };
    const p = this.byId(playerId);
    const free = this.freeRoads > 0;
    if (!free && !this.canAfford(p, COST.road)) return { error: 'Not enough resources (need 1 wood, 1 brick).' };
    if (free) this.freeRoads--; else this.pay(p, COST.road);
    this.roads[edgeId] = playerId;
    this.pushLog(`${p.name} built a road${free ? ' (free)' : ''}.`);
    this.updateLongestRoad();
    this.checkWin();
    return { ok: true };
  }

  buildSettlement(playerId, vertexId) {
    if (this.phase !== 'play' || this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (!this.hasRolled) return { error: 'Roll the dice first.' };
    if (this.busy()) return { error: 'Resolve the robber first.' };
    const v = this.board.vertices[vertexId];
    if (!v || this.buildings[vertexId]) return { error: 'Cannot build there.' };
    if (v.adj.some((n) => this.buildings[n])) return { error: 'Too close to another building.' };
    if (!v.edges.some((eid) => this.roads[eid] === playerId)) return { error: 'Must connect to your own road.' };
    const p = this.byId(playerId);
    if (!this.canAfford(p, COST.settlement)) return { error: 'Not enough resources.' };
    this.pay(p, COST.settlement);
    this.buildings[vertexId] = { owner: playerId, type: 'settlement' };
    this.pushLog(`${p.name} built a settlement.`);
    this.updateLongestRoad();
    this.checkWin();
    return { ok: true };
  }

  buildCity(playerId, vertexId) {
    if (this.phase !== 'play' || this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (!this.hasRolled) return { error: 'Roll the dice first.' };
    if (this.busy()) return { error: 'Resolve the robber first.' };
    const b = this.buildings[vertexId];
    if (!b || b.owner !== playerId || b.type !== 'settlement') return { error: 'Upgrade your own settlement.' };
    const p = this.byId(playerId);
    if (!this.canAfford(p, COST.city)) return { error: 'Not enough resources (need 2 wheat, 3 ore).' };
    this.pay(p, COST.city); b.type = 'city';
    this.pushLog(`${p.name} upgraded to a city.`);
    this.checkWin();
    return { ok: true };
  }

  portRatio(playerId, resource) {
    let ratio = 4;
    this.board.ports.forEach((port) => {
      const owns = port.vertices.some((vid) => this.buildings[vid] && this.buildings[vid].owner === playerId);
      if (!owns) return;
      if (port.type === '3:1') ratio = Math.min(ratio, 3);
      else if (port.type === resource) ratio = Math.min(ratio, 2);
    });
    return ratio;
  }
  portsFor(playerId) {
    const set = {};
    this.board.ports.forEach((port) => { if (port.vertices.some((vid) => this.buildings[vid] && this.buildings[vid].owner === playerId)) set[port.type] = true; });
    return set;
  }

  bankTrade(playerId, give, want) {
    if (this.phase !== 'play' || this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (!this.hasRolled) return { error: 'Roll the dice first.' };
    if (this.busy()) return { error: 'Resolve the robber first.' };
    if (!RESOURCES.includes(give) || !RESOURCES.includes(want)) return { error: 'Invalid trade.' };
    const p = this.byId(playerId);
    const ratio = this.portRatio(playerId, give);
    if (p.resources[give] < ratio) return { error: `Need ${ratio} ${give} to trade.` };
    p.resources[give] -= ratio; p.resources[want] += 1;
    this.pushLog(`${p.name} traded ${ratio} ${give} for 1 ${want}.`);
    return { ok: true };
  }

  makeOffer(playerId, give, want) {
    if (this.phase !== 'play' || this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (!this.hasRolled) return { error: 'Roll the dice first.' };
    if (this.busy()) return { error: 'Resolve the robber first.' };
    const clean = (o) => { const r = {}; RESOURCES.forEach((k) => { if (o[k] > 0) r[k] = o[k]; }); return r; };
    give = clean(give); want = clean(want);
    if (!Object.keys(give).length && !Object.keys(want).length) return { error: 'Empty offer.' };
    if (!this.canAfford(this.byId(playerId), give)) return { error: 'You do not have what you offered.' };
    this.offer = { from: playerId, give, want, responders: [] };
    this.pushLog(`${this.byId(playerId).name} proposed a trade.`);
    return { ok: true };
  }
  respondOffer(playerId, accept) {
    if (!this.offer) return { error: 'No active offer.' };
    if (playerId === this.offer.from) return { error: 'Cannot respond to your own offer.' };
    this.offer.responders = this.offer.responders.filter((r) => r !== playerId);
    if (accept) {
      if (!this.canAfford(this.byId(playerId), this.offer.want)) return { error: 'You lack the requested cards.' };
      this.offer.responders.push(playerId);
    }
    return { ok: true };
  }
  confirmTrade(playerId, withId) {
    if (!this.offer || this.offer.from !== playerId) return { error: 'No offer to confirm.' };
    if (!this.offer.responders.includes(withId)) return { error: 'That player has not accepted.' };
    const a = this.byId(playerId), b = this.byId(withId);
    if (!this.canAfford(a, this.offer.give) || !this.canAfford(b, this.offer.want)) return { error: 'Resources changed; trade invalid.' };
    Object.entries(this.offer.give).forEach(([r, n]) => { a.resources[r] -= n; b.resources[r] += n; });
    Object.entries(this.offer.want).forEach(([r, n]) => { b.resources[r] -= n; a.resources[r] += n; });
    this.pushLog(`${a.name} traded with ${b.name}.`);
    this.notify(withId, `Trade complete with ${a.name}.`, 'good');
    this.offer = null;
    return { ok: true };
  }
  cancelOffer(playerId) { if (this.offer && this.offer.from === playerId) { this.offer = null; return { ok: true }; } return { error: 'No offer to cancel.' }; }

  buyDev(playerId) {
    if (this.phase !== 'play' || this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (!this.hasRolled) return { error: 'Roll the dice first.' };
    if (this.busy()) return { error: 'Resolve the robber first.' };
    if (this.devDeck.length === 0) return { error: 'No development cards left.' };
    const p = this.byId(playerId);
    if (!this.canAfford(p, COST.dev)) return { error: 'Need 1 ore, 1 sheep, 1 wheat.' };
    this.pay(p, COST.dev);
    const card = this.devDeck.pop();
    if (card === 'vp') { p.dev.vp++; this.notify(playerId, 'You drew a Victory Point card!', 'good'); }
    else { p.devNew[card]++; this.notify(playerId, `You drew a ${devName(card)} card — playable next turn.`, 'good'); }
    this.pushLog(`${p.name} bought a development card.`);
    this.checkWin();
    return { ok: true };
  }

  playKnight(playerId) {
    const p = this.byId(playerId);
    if (this.phase !== 'play' || this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (!this.hasRolled) return { error: 'Roll the dice first.' };
    if (this.busy()) return { error: 'Resolve the current action first.' };
    if (p.playedDev) return { error: 'You already played a development card this turn.' };
    if (p.dev.knight < 1) return { error: 'No Knight card available.' };
    p.dev.knight--; p.knightsPlayed++; p.playedDev = true;
    this.updateLargestArmy(); this.robberStep = true;
    this.pushLog(`${p.name} played a Knight.`);
    this.checkWin();
    return { ok: true };
  }

  playRoadBuilding(playerId) {
    const p = this.byId(playerId);
    if (this.phase !== 'play' || this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (!this.hasRolled) return { error: 'Roll the dice first.' };
    if (this.busy()) return { error: 'Resolve the current action first.' };
    if (p.playedDev) return { error: 'You already played a development card this turn.' };
    if (p.dev.road_building < 1) return { error: 'No Road Building card available.' };
    p.dev.road_building--; p.playedDev = true; this.freeRoads = 2;
    this.pushLog(`${p.name} played Road Building (2 free roads).`);
    return { ok: true };
  }

  playMonopoly(playerId, resource) {
    const p = this.byId(playerId);
    if (this.phase !== 'play' || this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (!this.hasRolled) return { error: 'Roll the dice first.' };
    if (this.busy()) return { error: 'Resolve the current action first.' };
    if (p.playedDev) return { error: 'You already played a development card this turn.' };
    if (p.dev.monopoly < 1) return { error: 'No Monopoly card available.' };
    if (!RESOURCES.includes(resource)) return { error: 'Pick a resource.' };
    p.dev.monopoly--; p.playedDev = true;
    let total = 0;
    this.players.forEach((o) => {
      if (o.id === playerId) return;
      const n = o.resources[resource];
      if (n > 0) { o.resources[resource] -= n; total += n; this.notify(o.id, `${p.name} monopolised ${resource} — you lost ${n}.`, 'bad'); }
    });
    p.resources[resource] += total;
    this.pushLog(`${p.name} played Monopoly on ${resource} (+${total}).`);
    this.notify(playerId, `Monopoly: you collected ${total} ${resource}.`, 'good');
    return { ok: true };
  }

  playYearOfPlenty(playerId, r1, r2) {
    const p = this.byId(playerId);
    if (this.phase !== 'play' || this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (!this.hasRolled) return { error: 'Roll the dice first.' };
    if (this.busy()) return { error: 'Resolve the current action first.' };
    if (p.playedDev) return { error: 'You already played a development card this turn.' };
    if (p.dev.year_of_plenty < 1) return { error: 'No Year of Plenty card available.' };
    if (!RESOURCES.includes(r1) || !RESOURCES.includes(r2)) return { error: 'Pick two resources.' };
    p.dev.year_of_plenty--; p.playedDev = true;
    p.resources[r1]++; p.resources[r2]++;
    this.pushLog(`${p.name} played Year of Plenty.`);
    return { ok: true };
  }

  endTurn(playerId) {
    if (this.phase !== 'play' || this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (!this.hasRolled) return { error: 'Roll before ending your turn.' };
    if (this.busy()) return { error: 'Resolve the robber first.' };
    this.freeRoads = 0;
    const p = this.byId(playerId);
    Object.keys(p.devNew).forEach((k) => { p.dev[k] += p.devNew[k]; p.devNew[k] = 0; });
    p.playedDev = false;
    this.offer = null;
    this.current = (this.current + 1) % this.players.length;
    this.hasRolled = false; this.dice = null;
    this.pushLog(`It is now ${this.curPlayer().name}'s turn.`);
    return { ok: true };
  }

  vpFor(playerId, includeHidden) {
    let vp = 0;
    Object.values(this.buildings).forEach((b) => { if (b.owner === playerId) vp += b.type === 'city' ? 2 : 1; });
    if (this.longestRoadHolder === playerId) vp += 2;
    if (this.largestArmyHolder === playerId) vp += 2;
    if (includeHidden) vp += this.byId(playerId).dev.vp;
    return vp;
  }

  updateLargestArmy() {
    let best = { n: 0, owner: null };
    this.players.forEach((p) => { if (p.knightsPlayed > best.n) best = { n: p.knightsPlayed, owner: p.id }; });
    if (best.n >= 3) { const cur = this.largestArmyHolder; if (!cur || this.byId(cur).knightsPlayed < best.n) this.largestArmyHolder = best.owner; }
  }

  updateLongestRoad() {
    let best = { len: 0, owner: null };
    this.players.forEach((p) => { const len = this.longestRoadLength(p.id); if (len > best.len) best = { len, owner: p.id }; });
    if (best.len >= 5) { const cur = this.longestRoadHolder; if (!cur || this.longestRoadLength(cur) < best.len) this.longestRoadHolder = best.owner; }
    else this.longestRoadHolder = null;
  }

  longestRoadLength(playerId) {
    const ownEdges = Object.entries(this.roads).filter(([, o]) => o === playerId).map(([e]) => +e);
    if (!ownEdges.length) return 0;
    const adj = {};
    ownEdges.forEach((eid) => {
      const e = this.board.edges[eid];
      (adj[e.v[0]] = adj[e.v[0]] || []).push({ to: e.v[1], edge: eid });
      (adj[e.v[1]] = adj[e.v[1]] || []).push({ to: e.v[0], edge: eid });
    });
    const blocked = (vid) => { const b = this.buildings[vid]; return b && b.owner !== playerId; };
    let max = 0;
    const dfs = (v, used) => {
      if (blocked(v)) return 0;
      let local = 0;
      for (const { to, edge } of adj[v]) { if (used.has(edge)) continue; used.add(edge); local = Math.max(local, 1 + dfs(to, used)); used.delete(edge); }
      return local;
    };
    Object.keys(adj).forEach((v) => { max = Math.max(max, dfs(+v, new Set())); });
    return max;
  }

  checkWin() {
    const p = this.curPlayer();
    if (this.vpFor(p.id, true) >= 10) { this.phase = 'over'; this.winner = p.id; this.pushLog(`${p.name} wins with ${this.vpFor(p.id, true)} victory points!`); }
  }

  stateForPlayer(playerId) {
    const myGain = this.lastGain && this.lastGain.gains[playerId] ? this.lastGain.gains[playerId] : null;
    return {
      roomId: this.id, phase: this.phase, you: playerId,
      board: this.board, buildings: this.buildings, roads: this.roads,
      current: this.players[this.current] ? this.players[this.current].id : null,
      dice: this.dice, hasRolled: this.hasRolled,
      setup: this.setup ? { expect: this.setup.expect, lastVertex: this.setup.lastVertex } : null,
      robberStep: this.robberStep, stealCandidates: this.stealCandidates,
      mustDiscard: this.pendingDiscards[playerId] || 0,
      pendingDiscards: Object.keys(this.pendingDiscards),
      offer: this.offer,
      longestRoad: this.longestRoadHolder, largestArmy: this.largestArmyHolder,
      freeRoads: this.curPlayer() && this.curPlayer().id === playerId ? this.freeRoads : 0,
      devDeckLeft: this.devDeck.length,
      winner: this.winner,
      log: this.log.slice(-12),
      gainSeq: this.gainSeq, yourGain: myGain,
      events: this.events.filter((e) => e.to === playerId).slice(-12),
      myPorts: this.board ? this.portsFor(playerId) : {},
      myRatios: this.board ? Object.fromEntries(RESOURCES.map((r) => [r, this.portRatio(playerId, r)])) : {},
      players: this.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, connected: p.connected, isHost: p.isHost,
        handCount: this.handSize(p), devCount: this.devCount(p), knights: p.knightsPlayed,
        vp: p.id === playerId ? this.vpFor(p.id, true) : this.vpFor(p.id, false),
        resources: p.id === playerId ? p.resources : null,
        dev: p.id === playerId ? p.dev : null,
        devNew: p.id === playerId ? p.devNew : null,
        playedDev: p.id === playerId ? p.playedDev : null,
      })),
    };
  }
}

function devName(c) {
  return { knight: 'Knight', vp: 'Victory Point', road_building: 'Road Building', monopoly: 'Monopoly', year_of_plenty: 'Year of Plenty' }[c] || c;
}

module.exports = { Room, createBoard, RESOURCES, COST, devName };

// engine.js — server-authoritative game logic for a hex settlers game.
// No external deps. Exports the Room class used by server.js.

const SIZE = 60; // hex radius in px (center -> corner)
const COLORS = ['#c0392b', '#2f6fb0', '#3f8a4f', '#d9852f']; // red, blue, green, orange
const RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];

// Cost tables
const COST = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
};

function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function hexCenter(q, r) {
  return {
    x: SIZE * Math.sqrt(3) * (q + r / 2),
    y: SIZE * 1.5 * r,
  };
}

function hexCorners(c) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 180) * (60 * i - 30); // pointy-top
    pts.push({ x: c.x + SIZE * Math.cos(ang), y: c.y + SIZE * Math.sin(ang) });
  }
  return pts;
}

// Build the standard 19-hex board with vertices and edges derived geometrically.
function createBoard() {
  const coords = [];
  for (let q = -2; q <= 2; q++)
    for (let r = -2; r <= 2; r++)
      if (Math.abs(q + r) <= 2) coords.push({ q, r });
  // coords.length === 19

  // Resource land distribution (standard): 4 wood, 4 sheep, 4 wheat, 3 brick, 3 ore, 1 desert
  const landPool = shuffle([
    ...Array(4).fill('wood'),
    ...Array(4).fill('sheep'),
    ...Array(4).fill('wheat'),
    ...Array(3).fill('brick'),
    ...Array(3).fill('ore'),
    'desert',
  ]);
  const numberPool = shuffle([2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12]);

  const hexes = coords.map((c, i) => {
    const center = hexCenter(c.q, c.r);
    return {
      id: i, q: c.q, r: c.r,
      x: Math.round(center.x), y: Math.round(center.y),
      resource: landPool[i],
      number: null,
    };
  });
  // Assign numbers to non-desert hexes
  let np = 0;
  hexes.forEach((h) => { if (h.resource !== 'desert') h.number = numberPool[np++]; });

  // Derive vertices + edges by geometric dedup of hex corners
  const vMap = {};
  const vertices = [];
  const eMap = {};
  const edges = [];
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

  // vertex adjacency from edges
  edges.forEach((e) => {
    vertices[e.v[0]].adj.push(e.v[1]);
    vertices[e.v[1]].adj.push(e.v[0]);
    vertices[e.v[0]].edges.push(e.id);
    vertices[e.v[1]].edges.push(e.id);
  });

  const robberHex = hexes.findIndex((h) => h.resource === 'desert');
  return { hexes, vertices, edges, robber: robberHex };
}

class Room {
  constructor(id) {
    this.id = id;
    this.players = []; // {id, name, color, resources, socketId, connected, isHost}
    this.phase = 'lobby'; // lobby | setup | play | over
    this.board = null;
    this.buildings = {}; // vertexId -> { owner: playerId, type: 'settlement'|'city' }
    this.roads = {}; // edgeId -> playerId
    this.current = 0; // index into players
    this.dice = null; // [d1, d2]
    this.hasRolled = false;
    this.setup = null; // { order: [...idx], step: int, expect: 'settlement'|'road', lastVertex }
    this.pendingDiscards = {}; // playerId -> count required
    this.robberStep = false; // current player must move robber
    this.stealCandidates = []; // playerIds you may steal from
    this.offer = null; // active trade offer
    this.longestRoadHolder = null;
    this.winner = null;
    this.log = [];
  }

  addPlayer(name, socketId) {
    if (this.phase !== 'lobby') return { error: 'Game already started.' };
    if (this.players.length >= 4) return { error: 'Room is full (max 4).' };
    if (this.players.some((p) => p.name.toLowerCase() === name.toLowerCase()))
      return { error: 'Name already taken in this room.' };
    const id = 'p' + Math.random().toString(36).slice(2, 9);
    const player = {
      id, name, socketId, connected: true,
      color: COLORS[this.players.length],
      resources: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 },
      isHost: this.players.length === 0,
    };
    this.players.push(player);
    this.pushLog(`${name} joined.`);
    return { player };
  }

  reconnect(playerId, socketId) {
    const p = this.players.find((x) => x.id === playerId);
    if (!p) return false;
    p.socketId = socketId; p.connected = true;
    this.pushLog(`${p.name} reconnected.`);
    return true;
  }

  byId(id) { return this.players.find((p) => p.id === id); }
  curPlayer() { return this.players[this.current]; }
  pushLog(msg) { this.log.push(msg); if (this.log.length > 60) this.log.shift(); }

  start(playerId) {
    const p = this.byId(playerId);
    if (!p || !p.isHost) return { error: 'Only the host can start.' };
    if (this.players.length < 2) return { error: 'Need at least 2 players.' };
    this.board = createBoard();
    this.phase = 'setup';
    const order = this.players.map((_, i) => i);
    this.setup = { order: [...order, ...order.slice().reverse()], step: 0, expect: 'settlement', lastVertex: null };
    this.current = this.setup.order[0];
    this.pushLog('Game started. Place your first settlement.');
    return { ok: true };
  }

  // ---- Setup phase ----
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
    // Second settlement (second half of snake) grants starting resources
    if (this.setup.step >= this.players.length) {
      v.hexes.forEach((hid) => {
        const h = this.board.hexes[hid];
        if (h.resource !== 'desert') this.byId(playerId).resources[h.resource]++;
      });
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
    // advance setup
    this.setup.step++;
    if (this.setup.step >= this.setup.order.length) {
      this.phase = 'play';
      this.current = this.setup.order[this.setup.order.length - 1]; // last placer starts
      this.hasRolled = false;
      this.updateLongestRoad();
      this.pushLog('Setup complete. Roll the dice!');
    } else {
      this.setup.expect = 'settlement';
      this.current = this.setup.order[this.setup.step];
    }
    return { ok: true };
  }

  // ---- Play phase ----
  rollDice(playerId) {
    if (this.phase !== 'play') return { error: 'Not in play.' };
    if (this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (this.hasRolled) return { error: 'You already rolled.' };
    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    this.dice = [d1, d2];
    this.hasRolled = true;
    const total = d1 + d2;
    this.pushLog(`${this.curPlayer().name} rolled ${total} (${d1}+${d2}).`);
    if (total === 7) {
      // discard for anyone with >7 cards
      this.pendingDiscards = {};
      this.players.forEach((p) => {
        const n = this.handSize(p);
        if (n > 7) this.pendingDiscards[p.id] = Math.floor(n / 2);
      });
      if (Object.keys(this.pendingDiscards).length === 0) this.robberStep = true;
      this.pushLog('Rolled a 7 — robber on the move.');
    } else {
      this.distribute(total);
    }
    return { ok: true };
  }

  distribute(total) {
    this.board.hexes.forEach((h) => {
      if (h.number !== total) return;
      if (this.board.robber === h.id) return;
      this.board.vertices.forEach((v) => {
        if (!v.hexes.includes(h.id)) return;
        const b = this.buildings[v.id];
        if (!b) return;
        const amt = b.type === 'city' ? 2 : 1;
        this.byId(b.owner).resources[h.resource] += amt;
      });
    });
  }

  handSize(p) { return RESOURCES.reduce((s, r) => s + p.resources[r], 0); }

  submitDiscard(playerId, sel) {
    const need = this.pendingDiscards[playerId];
    if (!need) return { error: 'You do not need to discard.' };
    const total = RESOURCES.reduce((s, r) => s + (sel[r] || 0), 0);
    if (total !== need) return { error: `Select exactly ${need} cards.` };
    const p = this.byId(playerId);
    for (const r of RESOURCES) {
      if ((sel[r] || 0) > p.resources[r]) return { error: 'You do not have those cards.' };
    }
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
    this.board.robber = hexId;
    this.robberStep = false;
    // who can be stolen from?
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
    const victim = this.byId(victimId);
    const pool = [];
    RESOURCES.forEach((r) => { for (let i = 0; i < victim.resources[r]; i++) pool.push(r); });
    if (pool.length) {
      const r = pool[Math.floor(Math.random() * pool.length)];
      victim.resources[r]--;
      this.byId(playerId).resources[r]++;
      this.pushLog(`${this.byId(playerId).name} stole a card from ${victim.name}.`);
    }
    this.stealCandidates = [];
    return { ok: true };
  }

  canAfford(p, cost) { return Object.entries(cost).every(([r, n]) => p.resources[r] >= n); }
  pay(p, cost) { Object.entries(cost).forEach(([r, n]) => (p.resources[r] -= n)); }

  buildRoad(playerId, edgeId) {
    if (this.phase !== 'play' || this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (!this.hasRolled) return { error: 'Roll the dice first.' };
    if (this.robberStep || this.stealCandidates.length || Object.keys(this.pendingDiscards).length)
      return { error: 'Resolve the robber first.' };
    const e = this.board.edges[edgeId];
    if (!e || this.roads[edgeId] !== undefined) return { error: 'Cannot build there.' };
    // must connect to own road or own building at either endpoint
    const connected = e.v.some((vid) => {
      const b = this.buildings[vid];
      if (b && b.owner === playerId) return true;
      return this.board.vertices[vid].edges.some((eid) => this.roads[eid] === playerId);
    });
    if (!connected) return { error: 'Road must connect to your network.' };
    const p = this.byId(playerId);
    if (!this.canAfford(p, COST.road)) return { error: 'Not enough resources (need 1 wood, 1 brick).' };
    this.pay(p, COST.road);
    this.roads[edgeId] = playerId;
    this.pushLog(`${p.name} built a road.`);
    this.updateLongestRoad();
    this.checkWin();
    return { ok: true };
  }

  buildSettlement(playerId, vertexId) {
    if (this.phase !== 'play' || this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (!this.hasRolled) return { error: 'Roll the dice first.' };
    const v = this.board.vertices[vertexId];
    if (!v || this.buildings[vertexId]) return { error: 'Cannot build there.' };
    if (v.adj.some((n) => this.buildings[n])) return { error: 'Too close to another building.' };
    const ownsRoad = v.edges.some((eid) => this.roads[eid] === playerId);
    if (!ownsRoad) return { error: 'Must connect to your own road.' };
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
    const b = this.buildings[vertexId];
    if (!b || b.owner !== playerId || b.type !== 'settlement') return { error: 'Upgrade your own settlement.' };
    const p = this.byId(playerId);
    if (!this.canAfford(p, COST.city)) return { error: 'Not enough resources (need 2 wheat, 3 ore).' };
    this.pay(p, COST.city);
    b.type = 'city';
    this.pushLog(`${p.name} upgraded to a city.`);
    this.checkWin();
    return { ok: true };
  }

  bankTrade(playerId, give, want) {
    if (this.phase !== 'play' || this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (!this.hasRolled) return { error: 'Roll the dice first.' };
    if (!RESOURCES.includes(give) || !RESOURCES.includes(want)) return { error: 'Invalid trade.' };
    const p = this.byId(playerId);
    if (p.resources[give] < 4) return { error: `Need 4 ${give} to trade.` };
    p.resources[give] -= 4;
    p.resources[want] += 1;
    this.pushLog(`${p.name} traded 4 ${give} for 1 ${want} with the bank.`);
    return { ok: true };
  }

  // ---- Player trading ----
  makeOffer(playerId, give, want) {
    if (this.phase !== 'play' || this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (!this.hasRolled) return { error: 'Roll the dice first.' };
    const clean = (o) => { const r = {}; RESOURCES.forEach((k) => { if (o[k] > 0) r[k] = o[k]; }); return r; };
    give = clean(give); want = clean(want);
    if (!Object.keys(give).length && !Object.keys(want).length) return { error: 'Empty offer.' };
    const p = this.byId(playerId);
    if (!this.canAfford(p, give)) return { error: 'You do not have what you offered.' };
    this.offer = { from: playerId, give, want, responders: [] };
    this.pushLog(`${p.name} proposed a trade.`);
    return { ok: true };
  }

  respondOffer(playerId, accept) {
    if (!this.offer) return { error: 'No active offer.' };
    if (playerId === this.offer.from) return { error: 'Cannot respond to your own offer.' };
    this.offer.responders = this.offer.responders.filter((r) => r !== playerId);
    if (accept) {
      // only valid if responder can pay what offerer wants
      if (!this.canAfford(this.byId(playerId), this.offer.want)) return { error: 'You lack the requested cards.' };
      this.offer.responders.push(playerId);
    }
    return { ok: true };
  }

  confirmTrade(playerId, withId) {
    if (!this.offer || this.offer.from !== playerId) return { error: 'No offer to confirm.' };
    if (!this.offer.responders.includes(withId)) return { error: 'That player has not accepted.' };
    const a = this.byId(playerId), b = this.byId(withId);
    if (!this.canAfford(a, this.offer.give) || !this.canAfford(b, this.offer.want))
      return { error: 'Resources changed; trade no longer valid.' };
    Object.entries(this.offer.give).forEach(([r, n]) => { a.resources[r] -= n; b.resources[r] += n; });
    Object.entries(this.offer.want).forEach(([r, n]) => { b.resources[r] -= n; a.resources[r] += n; });
    this.pushLog(`${a.name} traded with ${b.name}.`);
    this.offer = null;
    return { ok: true };
  }

  cancelOffer(playerId) {
    if (this.offer && this.offer.from === playerId) { this.offer = null; return { ok: true }; }
    return { error: 'No offer to cancel.' };
  }

  endTurn(playerId) {
    if (this.phase !== 'play' || this.curPlayer().id !== playerId) return { error: "It's not your turn." };
    if (!this.hasRolled) return { error: 'Roll before ending your turn.' };
    if (this.robberStep || this.stealCandidates.length || Object.keys(this.pendingDiscards).length)
      return { error: 'Resolve the robber first.' };
    this.offer = null;
    this.current = (this.current + 1) % this.players.length;
    this.hasRolled = false;
    this.dice = null;
    this.pushLog(`It is now ${this.curPlayer().name}'s turn.`);
    return { ok: true };
  }

  // ---- Scoring ----
  vpFor(playerId) {
    let vp = 0;
    Object.values(this.buildings).forEach((b) => {
      if (b.owner === playerId) vp += b.type === 'city' ? 2 : 1;
    });
    if (this.longestRoadHolder === playerId) vp += 2;
    return vp;
  }

  updateLongestRoad() {
    let best = { len: 0, owner: null };
    this.players.forEach((p) => {
      const len = this.longestRoadLength(p.id);
      if (len > best.len) best = { len, owner: p.id };
    });
    if (best.len >= 5) {
      // keep current holder on ties
      const cur = this.longestRoadHolder;
      if (!cur || this.longestRoadLength(cur) < best.len) this.longestRoadHolder = best.owner;
    } else {
      this.longestRoadHolder = null;
    }
  }

  longestRoadLength(playerId) {
    // longest trail (no repeated edges) over this player's roads, broken at opponents' buildings
    const ownEdges = Object.entries(this.roads).filter(([, o]) => o === playerId).map(([e]) => +e);
    if (!ownEdges.length) return 0;
    const adj = {}; // vertex -> [{to, edge}]
    ownEdges.forEach((eid) => {
      const e = this.board.edges[eid];
      adj[e.v[0]] = adj[e.v[0]] || []; adj[e.v[1]] = adj[e.v[1]] || [];
      adj[e.v[0]].push({ to: e.v[1], edge: eid });
      adj[e.v[1]].push({ to: e.v[0], edge: eid });
    });
    const blocked = (vid) => { const b = this.buildings[vid]; return b && b.owner !== playerId; };
    let max = 0;
    const dfs = (v, used) => {
      let local = 0;
      for (const { to, edge } of adj[v]) {
        if (used.has(edge)) continue;
        if (blocked(v)) continue; // cannot pass through an opponent's building
        used.add(edge);
        local = Math.max(local, 1 + dfs(to, used));
        used.delete(edge);
      }
      return local;
    };
    Object.keys(adj).forEach((v) => { max = Math.max(max, dfs(+v, new Set())); });
    return max;
  }

  checkWin() {
    const p = this.curPlayer();
    if (this.vpFor(p.id) >= 10) {
      this.phase = 'over';
      this.winner = p.id;
      this.pushLog(`${p.name} wins with ${this.vpFor(p.id)} victory points!`);
    }
  }

  // ---- State serialization (per-player view) ----
  stateForPlayer(playerId) {
    return {
      roomId: this.id,
      phase: this.phase,
      you: playerId,
      board: this.board,
      buildings: this.buildings,
      roads: this.roads,
      current: this.players[this.current] ? this.players[this.current].id : null,
      dice: this.dice,
      hasRolled: this.hasRolled,
      setup: this.setup ? { expect: this.setup.expect, lastVertex: this.setup.lastVertex } : null,
      robberStep: this.robberStep,
      stealCandidates: this.stealCandidates,
      mustDiscard: this.pendingDiscards[playerId] || 0,
      pendingDiscards: Object.keys(this.pendingDiscards),
      offer: this.offer,
      longestRoad: this.longestRoadHolder,
      winner: this.winner,
      log: this.log.slice(-12),
      players: this.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, connected: p.connected, isHost: p.isHost,
        handCount: this.handSize(p),
        vp: this.vpFor(p.id),
        // private: only reveal full hand to the owner
        resources: p.id === playerId ? p.resources : null,
      })),
    };
  }
}

module.exports = { Room, createBoard, RESOURCES, COST };

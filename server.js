// server.js — serves the client and runs realtime game rooms over Socket.IO.
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Room } = require('./engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map(); // roomId -> Room
const sockets = new Map(); // socketId -> { roomId, playerId }

function genRoomId() {
  let id;
  do { id = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (rooms.has(id));
  return id;
}

// Broadcast personalized state to every connected player in a room.
function broadcast(room) {
  room.players.forEach((p) => {
    if (p.connected && p.socketId) io.to(p.socketId).emit('state', room.stateForPlayer(p.id));
  });
}

io.on('connection', (socket) => {
  // Reply helper that also re-broadcasts on success
  const handle = (room, result) => {
    if (result && result.error) { socket.emit('error_msg', result.error); return false; }
    if (room) broadcast(room);
    return true;
  };

  socket.on('create_room', ({ name }, cb) => {
    name = (name || '').trim().slice(0, 16);
    if (!name) return cb && cb({ error: 'Enter a name.' });
    const id = genRoomId();
    const room = new Room(id);
    rooms.set(id, room);
    const { player, error } = room.addPlayer(name, socket.id);
    if (error) return cb && cb({ error });
    sockets.set(socket.id, { roomId: id, playerId: player.id });
    cb && cb({ roomId: id, playerId: player.id });
    broadcast(room);
  });

  socket.on('join_room', ({ name, roomId }, cb) => {
    roomId = (roomId || '').trim().toUpperCase();
    name = (name || '').trim().slice(0, 16);
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: 'Room not found.' });
    if (!name) return cb && cb({ error: 'Enter a name.' });
    const { player, error } = room.addPlayer(name, socket.id);
    if (error) return cb && cb({ error });
    sockets.set(socket.id, { roomId, playerId: player.id });
    cb && cb({ roomId, playerId: player.id });
    broadcast(room);
  });

  socket.on('rejoin', ({ roomId, playerId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: 'Room no longer exists.' });
    if (!room.reconnect(playerId, socket.id)) return cb && cb({ error: 'Slot not found.' });
    sockets.set(socket.id, { roomId, playerId });
    cb && cb({ roomId, playerId });
    broadcast(room);
  });

  // All gameplay actions resolve through a single dispatcher.
  socket.on('action', ({ type, payload }) => {
    const ctx = sockets.get(socket.id);
    if (!ctx) return socket.emit('error_msg', 'Not in a room.');
    const room = rooms.get(ctx.roomId);
    if (!room) return socket.emit('error_msg', 'Room gone.');
    const pid = ctx.playerId;
    payload = payload || {};
    let r;
    switch (type) {
      case 'start': r = room.start(pid); break;
      case 'setup_settlement': r = room.placeSetupSettlement(pid, payload.vertexId); break;
      case 'setup_road': r = room.placeSetupRoad(pid, payload.edgeId); break;
      case 'roll': r = room.rollDice(pid); break;
      case 'discard': r = room.submitDiscard(pid, payload.sel || {}); break;
      case 'move_robber': r = room.moveRobber(pid, payload.hexId); break;
      case 'steal': r = room.steal(pid, payload.victimId); break;
      case 'build_road': r = room.buildRoad(pid, payload.edgeId); break;
      case 'build_settlement': r = room.buildSettlement(pid, payload.vertexId); break;
      case 'build_city': r = room.buildCity(pid, payload.vertexId); break;
      case 'bank_trade': r = room.bankTrade(pid, payload.give, payload.want); break;
      case 'make_offer': r = room.makeOffer(pid, payload.give || {}, payload.want || {}); break;
      case 'respond_offer': r = room.respondOffer(pid, payload.accept); break;
      case 'confirm_trade': r = room.confirmTrade(pid, payload.withId); break;
      case 'cancel_offer': r = room.cancelOffer(pid); break;
      case 'end_turn': r = room.endTurn(pid); break;
      default: r = { error: 'Unknown action.' };
    }
    handle(room, r);
  });

  socket.on('disconnect', () => {
    const ctx = sockets.get(socket.id);
    if (!ctx) return;
    const room = rooms.get(ctx.roomId);
    sockets.delete(socket.id);
    if (!room) return;
    const p = room.byId(ctx.playerId);
    if (p) { p.connected = false; room.pushLog(`${p.name} disconnected.`); }
    // If room is empty and still in lobby, clean it up
    if (room.phase === 'lobby' && room.players.every((x) => !x.connected)) {
      rooms.delete(ctx.roomId);
    } else {
      broadcast(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Hex Settlers running on http://localhost:${PORT}`));

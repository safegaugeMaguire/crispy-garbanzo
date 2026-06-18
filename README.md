# Hex Settlers

A self-hostable, real-time **online multiplayer** strategy game with Catan-style
mechanics: settle a hex island, collect resources on dice rolls, build roads,
settlements, and cities, trade with the bank or other players, move the robber,
and race to **10 victory points**.

This is an original implementation (game mechanics only) under a generic name with
original visuals — rename and re-theme it however you like for private play.

---

## Quick start (local)

You need **Node.js 18+**.

```bash
npm install
npm start
```

Open `http://localhost:3000`. Click **Create a new game**, share the 4-letter room
code (or the "Copy invite" link), and have friends join from their own browsers.

## Hosting on your server

1. Copy this whole folder to your server.
2. `npm install --omit=dev`
3. Set a port if you want: `PORT=8080 npm start` (defaults to 3000).
4. Put it behind a reverse proxy (nginx/Caddy) for HTTPS. WebSockets must be
   allowed to pass through. Example nginx location block:

   ```nginx
   location / {
       proxy_pass http://localhost:3000;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
   }
   ```

5. To keep it running, use a process manager such as `pm2`:
   ```bash
   npm install -g pm2
   pm2 start server.js --name hex-settlers
   ```

## How to play

- **2–4 players.** The host starts the game once everyone has joined.
- **Setup:** each player places two settlements and two roads in snake order
  (1→2→3→4→4→3→2→1). Your second settlement grants its surrounding resources.
- **On your turn:** roll the dice. Every player collects resources from hexes
  matching the roll (1 per settlement, 2 per city) — even on others' turns.
- **Roll a 7:** anyone holding more than 7 cards discards half, then the roller
  moves the robber and steals a random card from a player on that hex.
- **Build** (click a build button, then a highlighted spot):
  - Road — 1 wood + 1 brick
  - Settlement — 1 wood + 1 brick + 1 sheep + 1 wheat (must connect to your road,
    and can't be adjacent to another building)
  - City — 2 wheat + 3 ore (upgrades one of your settlements; worth 2 points)
- **Trade:** 4-for-1 with the bank, or propose an offer to other players who can
  accept (you choose who to finalize with).
- **Longest road:** first to a continuous road of 5+ holds a +2 point bonus until
  someone beats it.
- **Win:** reach 10 victory points on your turn.

Disconnected players keep their seat and can rejoin (the browser remembers the
room). Refresh to recover a dropped connection.

## Project layout

```
server.js   Express + Socket.IO server, room management, event dispatch
engine.js   Authoritative game logic: board generation, rules, scoring, state
public/
  index.html  Lobby + game shell
  style.css   "Cartographer's table" theme
  client.js   Board rendering (SVG), interaction modes, modals, socket client
```

## Extending it

The engine is the single source of truth — add features there and the client
renders whatever state it receives. Natural next additions:

- **Development cards** (knight, road building, monopoly, year of plenty, victory
  point) and the **largest army** bonus.
- **Harbors/ports** with 2:1 and 3:1 trade ratios (vertices already know which
  hexes they touch; mark coastal vertices as ports).
- **5–6 player** board (extend `createBoard` to a larger hex radius and the
  number/resource pools accordingly).
- The official rule that red numbers (6 and 8) can't sit adjacent — currently
  numbers are randomized.

All building/placement rules are validated server-side, so the client's
highlighting is only a convenience and can't be used to cheat.

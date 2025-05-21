
const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname + "/../client"));

const port = process.env.PORT || 3000;
http.listen(port, () => {
  console.log("Server is listening on port " + port);
});

// --- Types ---
type NodeType = -1 | 0 | 1 | 2 | 3;

interface IServerConfig {
  virusMaxMass: number;
  virusMass: number;
  ejectMass: number;
  foodMass: number;
  playerStartMass: number;
  playerMinMassForSplit: number;
  playerMinMassForEject: number;
  playerMaxMass: number;
  playerMaxSplit: number;
  rangeWidth: number;
  rangeHeight: number;
  baseTime: number;
  width: number;
  height: number;
}

// --- Game Classes ---
class GameBlob {
  server: GameServer;
  nodeId: number;
  nodeType: NodeType;
  team: any;
  isAgitated: boolean;
  sendId: number;
  x: number;
  y: number;
  mass: number;
  time: number;
  _mass: number;
  nick: string;
  parent: Player | null;
  hue: number;
  boostDistance: number;
  boostEngine: { x: number; y: number; angle: number };

  constructor(server: GameServer, nodeId: number, x: number, y: number, mass: number, parent: Player | null) {
    this.server = server;
    this.nodeId = nodeId;
    this.nodeType = -1;
    this.team = null;
    this.isAgitated = false;
    this.sendId = Math.random();
    this.x = x;
    this.y = y;
    this.mass = mass;
    this.time = Date.now();
    this._mass = mass;
    this.nick = "";
    this.parent = parent;
    this.hue = Math.random() * 360;
    this.boostDistance = 0;
    this.boostEngine = { x: 0, y: 0, angle: 0 };
  }

  getSpeed(): number {
    return 25 * 1.6 / Math.pow(this.mass, 0.22);
  }
  getBoostSpeed(): number {
    return 15 * 2.6 * Math.pow(this.mass, 0.0422);
  }
  getSize(): number {
    return Math.sqrt(this.mass) * 10;
  }
  setBoost(angle: number) {
    const speed = this.getBoostSpeed();
    this.boostEngine = {
      x: Math.cos(angle) * speed,
      y: Math.sin(angle) * speed,
      angle: angle,
    };
  }
  getBoostAngle(): number {
    return this.boostEngine.angle;
  }
  boostMove(delta: number) {
    this.x += this.boostEngine.x * delta;
    this.y += this.boostEngine.y * delta;
    this.boostEngine.x -= this.boostEngine.x * 0.05 * delta;
    this.boostEngine.y -= this.boostEngine.y * 0.05 * delta;
  }
  isBoosting(): boolean {
    return Math.hypot(this.boostEngine.x, this.boostEngine.y) > 15;
  }
  borderCheck() {
    const xStart = 0;
    const xEnd = this.server.config.width;
    const yStart = 0;
    const yEnd = this.server.config.width;
    this.x = Math.min(xEnd, Math.max(this.x, xStart));
    this.y = Math.min(yEnd, Math.max(this.y, yStart));
  }

  // Hooks
  canCombine(): boolean {
    return false;
  }
  onEat(prey: GameBlob) {
    this.mass += prey.mass;
  }
  onEaten(_eater: GameBlob) {
    this.server.removeNode(this);
  }
  move(_delta: number) {}
  eat() {}
}

class PlayerBlob extends GameBlob {
  constructor(server: GameServer, nodeId: number, x: number, y: number, mass: number, parent: Player) {
    super(server, nodeId, x, y, mass, parent);
    this.nodeType = 0;
  }
  decayMass(delta: number) {
    this.mass -= this.mass * 0.00005 * delta;
  }
  move(delta: number) {
    if (!this.parent) return;
    const mouse = this.parent.getMouse(this.x, this.y);
    const angle = mouse.angle;
    const vx = mouse.vx / (this.getSize() * 0.11);
    const vy = mouse.vy / (this.getSize() * 0.11);
    const speed = this.getSpeed();
    this.x += Math.cos(angle) * speed * Math.min(Math.pow(vx, 2), 1) * delta;
    this.y += Math.sin(angle) * speed * Math.min(Math.pow(vy, 2), 1) * delta;
  }
  eat() {
    if (!this.parent) return;
    const nodes = this.server.getNodesInRange(this.x, this.y);
    const selfParentId = this.parent.id;
    const ejectNodes = nodes.filter(a => a.nodeType === 0 ? (a.parent && a.parent.id !== selfParentId) : true);
    for (const check of ejectNodes) {
      if (this.server.collisionHandler.canEat(this, check)) {
        this.onEat(check);
        check.onEaten(this);
      }
    }
  }
  canCombine(): boolean {
    if (!this.server) return false;
    const required = 0.15 * this.mass + this.server.config.baseTime;
    return Date.now() - this.time >= required;
  }
}

class Virus extends GameBlob {
  /**
   * Creation d'un virus
   * @param server Le serveur de jeu
   * @param nodeId L'ID du noeud
   * @param x La position X du virus 
   * @param y La position Y du virus
   * @param mass La masse du virus
   * @param parent Le joueur parent (null pour un virus autonome)
   * @param hue La couleur du virus
   */
  constructor(server: GameServer, nodeId: number, x: number, y: number, mass: number) {
    super(server, nodeId, x, y, mass, null);
    this.nodeType = 1;
    this.isAgitated = true;
    this.hue = 0xffffff;
  }
  onEat(prey: GameBlob) {
    this.mass += prey.mass;
    if (this.mass > this.server.config.virusMaxMass) {
      this.server.shootVirus(this, prey.getBoostAngle());
    }
  }
  eat() {
    const nodes = this.server.getNodesInRange(this.x, this.y);
    const ejectNodes = nodes.filter(a => a.nodeType === 3);
    for (const check of ejectNodes) {
      if (this.server.collisionHandler.canEat(this, check)) {
        this.onEat(check);
        check.onEaten(this);
      }
    }
  }
  onEaten(eater: PlayerBlob) {
    super.onEaten(eater);
    this.server.addVirus(1);

    let numSplits = this.server.config.playerMaxSplit - eater.parent!.blobs.length;
    let massLeft = eater.mass;

    if (numSplits <= 0) return;

    if (massLeft < 466) {
      let splitAmount = 1;
      while (massLeft > 36) {
        splitAmount *= 2;
        massLeft = eater.mass - splitAmount * 36;
      }
      const splitMass = eater.mass / splitAmount;
      for (let i = 0; i < Math.min(splitAmount, numSplits); i++) {
        const angle = Math.random() * 6.28;
        if (eater.mass <= 36) break;
        this.server.createPlayerBlob(
          eater.x, eater.y, splitMass, angle, eater, eater.parent!
        );
      }
    } else {
      const beginMass = eater.mass;
      const smallMass = 19;
      let splitMass = beginMass * 0.44 - smallMass * numSplits;
      while (eater.mass > beginMass * 0.5 && splitMass > smallMass) {
        numSplits--;
        const angle = Math.random() * 6.28;
        this.server.createPlayerBlob(
          eater.x, eater.y, splitMass, angle, eater, eater.parent!
        );
        splitMass *= 0.55;
      }
      for (let i = 0; i < numSplits; i++) {
        const angle = Math.random() * 6.28;
        this.server.createPlayerBlob(
          eater.x, eater.y, smallMass, angle, eater, eater.parent!
        );
      }
    }
  }
}

class Food extends GameBlob {
  constructor(server: GameServer, nodeId: number, x: number, y: number, mass: number) {
    super(server, nodeId, x, y, mass, null);
    this.nodeType = 2;
  }
  onEaten(_eater: GameBlob) {
    super.onEaten(_eater);
    this.server.addFood(1);
  }
}

class Eject extends GameBlob {
  constructor(server: GameServer, nodeId: number, x: number, y: number, mass: number) {
    super(server, nodeId, x, y, mass, null);
    this.nodeType = 3;
  }
  // Optionally implement onEaten
}

class Player {
  server: GameServer;
  blobs: PlayerBlob[] = [];
  visibleNodes: GameBlob[] = [];
  movingVisibleNodes: GameBlob[] = [];
  addedVisibleNodes: GameBlob[] = [];
  removedVisibleNodes: GameBlob[] = [];
  nick: string = "";
  drawZoom: number = 1;
  centerX: number = 0;
  centerY: number = 0;
  rawMouseX: number = 0;
  rawMouseY: number = 0;
  screenWidth: number = 1920;
  screenHeight: number = 1080;
  id: string = "";
  joined: boolean = false;
  lastHeartbeat: number = Date.now(); 

  constructor(server: GameServer) {
    this.server = server;
  }
  setNick(n: string) { this.nick = n; }
  getNick(): string { return this.nick === "" ? "Neuille" : this.nick; }
  onMouseMove(x: number, y: number) {
    this.rawMouseX = x;
    this.rawMouseY = y;
  }
onKeyDown(key: number) {
  if (key === 87) {
    for (const blob of this.blobs) {
      this.server.addEject(blob);
    }
  }
  if (key === 32) {
    // Only split blobs that are eligible, and don't split new blobs in the same tick
    const blobsToSplit = this.blobs.filter(
      blob =>
        blob.mass >= this.server.config.playerMinMassForSplit &&
        this.blobs.length < this.server.config.playerMaxSplit
    );
    for (const blob of blobsToSplit) {
      this.server.splitPlayerBlob(blob);
      // After splitting, check if we've reached the max split
      if (this.blobs.length >= this.server.config.playerMaxSplit) break;
    }
  }
}
  onKeyUp(_key: number) {}
  getMouse(x: number, y: number) {
    const relX = (this.centerX - x) * this.drawZoom;
    const relY = (this.centerY - y) * this.drawZoom;
    const mx = relX + this.rawMouseX - this.screenWidth / 2;
    const my = relY + this.rawMouseY - this.screenHeight / 2;
    return {
      angle: Math.atan2(my, mx),
      vx: mx,
      vy: my,
    };
  }
  updateCenter(delta: number) {
    let totalX = 0, totalY = 0, totalSize = 0;
    const len = this.blobs.length;
    if (len === 0) return;
    for (const blob of this.blobs) {
      totalX += blob.x;
      totalY += blob.y;
      totalSize += blob.getSize();
    }
    this.centerX = totalX / len;
    this.centerY = totalY / len;
    this.drawZoom = 1 / (Math.sqrt(totalSize) / Math.log(totalSize));
    const nodes = this.server.getNodesInRange(this.centerX, this.centerY);

    nodes.forEach(n => {
      if (!this.visibleNodes.includes(n)) {
        this.addedVisibleNodes.push(n);
        this.visibleNodes.push(n);
      }
      this.visibleNodes.forEach((m, j) => {
        if (!nodes.includes(m)) {
          this.removedVisibleNodes.push(m);
          this.visibleNodes.splice(j, 1);
        }
      });
    });

    this.movingVisibleNodes = nodes.filter(n => n.nodeType === 0 || n.nodeType === 1 || n.nodeType === 3);
  }
}

class GameServer {
  collisionHandler: CollisionHandler = new CollisionHandler();
  nodes: GameBlob[] = [];
  players: Player[] = [];
  config: IServerConfig = {
    virusMaxMass: 180,
    virusMass: 100,
    ejectMass: 10,
    foodMass: 5,
    playerStartMass: 1302,
    playerMinMassForSplit: 20,
    playerMinMassForEject: 20,
    playerMaxMass: 20000,
    playerMaxSplit: 16,
    rangeWidth: 10000 ,
    rangeHeight: 10000 ,
    baseTime: 60000,
    width: 10000,
    height: 10000,
  };
  lastUpdateTime: number = Date.now();

  createPlayer(id: string, nick: string): Player {
    const player = new Player(this);
    player.setNick(nick);
    player.id = id;
    this.createPlayerBlob(
      Math.random() * this.config.width,
      Math.random() * this.config.height,
      this.config.playerStartMass,
      0, null, player
    );
    this.players.push(player);
    return player;
  }
  createPlayerBlob(x: number, y: number, mass: number, angle: number, parentBlob: GameBlob | null, parent: Player): PlayerBlob {
    const playerBlob = new PlayerBlob(this, parent.blobs.length, x, y, mass, parent);
    if (parentBlob) {
      playerBlob.hue = parentBlob.hue;
      parentBlob.mass -= mass;
      playerBlob.setBoost(angle);
    }
    playerBlob.nick = parent.getNick();
    parent.blobs.push(playerBlob);
    return playerBlob;
  }
  splitPlayerBlob(blob: PlayerBlob) {
    const numSplit = this.config.playerMaxSplit - blob.parent!.blobs.length;
    if (numSplit <= 0 || blob.mass < this.config.playerMinMassForSplit) return false;
    const angle = blob.parent!.getMouse(blob.x, blob.y).angle;
    this.createPlayerBlob(
      blob.x, blob.y, blob.mass * 0.5, angle, blob, blob.parent!
    );
  }
  shootVirus(virus: Virus, angle: number) {
    const shoot = new Virus(
      this,
      this.nodes.length,
      virus.x,
      virus.y,
      this.config.virusMass
    );
    shoot.hue = virus.hue;
    virus.mass = this.config.virusMass;
    shoot.setBoost(angle);
    this.nodes.push(shoot);
  }
  addFood(number: number) {
    for (let i = 0; i < number; i++) {
      const blob = new Food(
        this,
        this.nodes.length,
        Math.random() * this.config.width,
        Math.random() * this.config.height,
        this.config.foodMass
      );
      this.nodes.push(blob);
    }
  }
  addVirus(number: number) {
    for (let i = 0; i < number; i++) {
      const blob = new Virus(
        this,
        this.nodes.length,
        Math.random() * this.config.width,
        Math.random() * this.config.height,
        this.config.virusMass
      );
      this.nodes.push(blob);
    }
  }
  addEject(blob: PlayerBlob) {
    if (blob.mass < this.config.playerMinMassForEject) return;
    const space = 50;
    const angle = blob.parent!.getMouse(blob.x, blob.y).angle;
    const radius = blob.getSize();
    const ejectBlob = new Eject(
      this,
      this.nodes.length,
      blob.x + Math.cos(angle) * (radius + space),
      blob.y + Math.sin(angle) * (radius + space),
      this.config.ejectMass
    );
    blob.mass -= this.config.ejectMass;
    ejectBlob.hue = blob.hue;
    ejectBlob.setBoost(angle);
    this.nodes.push(ejectBlob);
  }
  removePlayer(player: Player) {
    const index = this.players.indexOf(player);
    if (index > -1) this.players.splice(index, 1);
  }
  removeNode(node: GameBlob) {
    if (node.nodeType !== 0) {
      this.nodes.splice(node.nodeId, 1);
      for (let i = 0; i < this.nodes.length; i++) {
        this.nodes[i].nodeId = i;
      }
    } else if (node.parent) {
      node.parent.blobs.splice(node.nodeId, 1);
      for (let i = 0; i < node.parent.blobs.length; i++) {
        node.parent.blobs[i].nodeId = i;
      }
    }
  }
  getNodesInRange(x: number, y: number): GameBlob[] {
    const xStart = x - this.config.rangeWidth / 2;
    const xEnd = x + this.config.rangeWidth / 2;
    const yStart = y - this.config.rangeHeight / 2;
    const yEnd = y + this.config.rangeHeight / 2;
    let allNodes: GameBlob[] = [...this.nodes];
    for (const plyr of this.players) {
      allNodes = allNodes.concat(plyr.blobs);
    }
    return allNodes.filter(a => a.x > xStart && a.x < xEnd && a.y > yStart && a.y < yEnd);
  }
  getLeaders(): string[] {
    const masses = this.players.map(player => ({
      nick: player.getNick(),
      mass: player.blobs.reduce((sum, b) => sum + b.mass, 0)
    }));
    return masses.sort((a, b) => b.mass - a.mass).slice(0, 10).map(c => c.nick);
  }
  getDelta(): number {
    return Date.now() - this.lastUpdateTime;
  }
  update() {
    const currDelta = this.getDelta() / 16;
    for (const player of this.players) {
      player.updateCenter(currDelta);
      for (const blob of player.blobs) {
        if (blob.mass >= this.config.playerMaxMass) {
          this.createPlayerBlob(
            blob.x, blob.y, blob.mass / 2, Math.random() * 2 * Math.PI, blob, blob.parent!
          );
        }
        blob.borderCheck();
        blob.eat();
        (blob as PlayerBlob).decayMass?.(currDelta);
        blob.move(currDelta);
        blob.boostMove(currDelta);
      }
      for (let j = 0; j < player.blobs.length; j++) {
        for (let k = 0; k < player.blobs.length; k++) {
          const blobA = player.blobs[j];
          const blobB = player.blobs[k];
          if (k !== j) {
            this.collisionHandler.pushApart(blobA, blobB, currDelta);
            this.collisionHandler.combinePlayer(blobA, blobB);
          }
        }
      }
    }
    for (const node of this.nodes) {
      node.borderCheck();
      node.eat();
      node.boostMove(currDelta);
      node.move(currDelta);
    }
    this.lastUpdateTime = Date.now();
  }
}

class CollisionHandler {
  eatMassFactor = 0.2;
  eatDistFactor = 1;
  isOverlapping(blob: GameBlob, check: GameBlob) {
    if (!blob || !check) return;
    const x = check.x - blob.x;
    const y = check.y - blob.y;
    const distance = Math.hypot(x, y);
    const maxDistance = blob.getSize() + check.getSize();
    if (distance < maxDistance) {
      return {
        x, y, distance, maxDistance, squared: x * x + y * y
      };
    }
    return false;
  }
  canEat(eater: GameBlob, check: GameBlob) {
    if (!eater || !check) return false;
    const overlap = this.isOverlapping(eater, check);
    if (!overlap) return false;
    const maxDistance = Math.pow(eater.mass + check.mass, 0.498888) * 10;
    const minMass = 1.15 * check.mass;
    const eatDistance = eater.getSize() - check.getSize() / 3;
    if (overlap.squared <= eatDistance * eatDistance) {
      if (eater.mass > minMass) return true;
      else return false;
    }
    return false;
  }
  pushApart(blobA: GameBlob, blobB: GameBlob, delta: number) {
    if (!blobA || !blobB) return;
    const overlap = this.isOverlapping(blobA, blobB);
    if (!overlap) return;
    const p = overlap.maxDistance - overlap.distance;
    if (p <= 0) return;
    const px = overlap.x / overlap.distance * p;
    const py = overlap.y / overlap.distance * p;
    const totalMass = blobA.getSize() + blobB.getSize();
    const invTotalMass = 1 / totalMass;
    const impulseA = blobA.getSize() * invTotalMass;
    const impulseB = blobB.getSize() * invTotalMass;
    const isBoosting = blobA.isBoosting() || blobB.isBoosting();
    const canCombine = blobA.canCombine() && blobB.canCombine();
    if (!isBoosting && !canCombine) {
      blobA.x -= px * impulseB * 0.1 * delta;
      blobA.y -= py * impulseB * 0.1 * delta;
      blobB.x += px * impulseA * 0.1 * delta;
      blobB.y += py * impulseA * 0.1 * delta;
    }
  }
  combinePlayer(blobA: GameBlob, blobB: GameBlob) {
    if (!blobA || !blobB) return;
    const overlap = this.isOverlapping(blobA, blobB);
    if (!overlap) return;
    const maxDistance = Math.pow(blobA.mass + blobB.mass, 0.498888) * 10;
    const isBoosting = blobA.isBoosting() || blobB.isBoosting();
    const canCombine = blobA.canCombine() && blobB.canCombine();
    if (overlap.distance < maxDistance && !isBoosting && canCombine) {
      if (blobA.mass > blobB.mass) {
        blobA.onEat(blobB);
        blobB.onEaten(blobA);
      } else {
        blobB.onEat(blobA);
        blobA.onEaten(blobB);
      }
    }
  }
}

const server = new GameServer();
const sockets: { [id: string]: Socket } = {};
const players = new Map<string, Player>();

// Clean inactive players
setInterval(() => {
  const now = Date.now();
  for (const [id, player] of players.entries()) {
    if (player.lastHeartbeat && now - player.lastHeartbeat > 10000) {
      const socket = sockets[id];
      if (socket) socket.disconnect(true);
      server.removePlayer(player);
      players.delete(id);
      delete sockets[id];
      io.sockets.emit("msg", ["server", "", `${escapeHtml(player.getNick())} a été déconnecté pour inactivité.`]);
    }
  }
}, 2000);

server.addFood(150);
server.addVirus(10);

function escapeHtml(unsafe: string) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

io.on("connection", (socket) => {
  sockets[socket.id] = socket;

  const player = new Player(server);
  player.id = socket.id;
  player.joined = false;
  players.set(socket.id, player);
  server.players.push(player);

  console.log("New connection: " + socket.id);

  socket.on("heartbeat", () => {
    player.lastHeartbeat = Date.now();
  });

  socket.on("join game", (d: [string, string, string]) => {
    if (player.joined) return;

    const [servKey, nick] = d;

    player.setNick(nick);
    player.joined = true;
    socket.compress(true).emit("joined");

    socket.on("msg", (m: string) => {
      if (typeof m === "string" && m.startsWith("-setmass ")) {
        const parts = m.split(" ");
        const newMass = parseFloat(parts[1]);
        if (!isNaN(newMass) && newMass > 0) {
          for (const blob of player.blobs) blob.mass = newMass;
          socket.compress(true).emit("msg", ["server", "", `Your mass was set to ${newMass}`]);
          return;
        }
      }

      const d = ["client", escapeHtml(player.getNick()), escapeHtml(m)];
      io.sockets.emit("msg", d);
    });

    server.createPlayerBlob(
      Math.random() * server.config.width,
      Math.random() * server.config.height,
      server.config.playerStartMass,
      0, null, player
    );

    socket.broadcast.emit("msg", ["game", "", `${escapeHtml(player.getNick())} joined the game.`]);

    const init = player.visibleNodes.map(b => [
      b.sendId,
      Math.round(b.x),
      Math.round(b.y),
      b.nick,
      Math.round(Math.sqrt(b.mass) * 10),
      Math.round(b.hue),
      b.isAgitated,
      b.nodeType
    ]);
    socket.compress(true).emit("init blobs", init);

    console.log("connected");
    console.log("players: " + players.size);
  });

  socket.on("disconnect", () => {
    socket.broadcast.emit("msg", ["game", "", `${escapeHtml(player.getNick())} left the game.`]);
    delete sockets[socket.id];
    players.delete(socket.id);
    server.removePlayer(player);
  });

  socket.on("width and height", ([w, h]) => {
    player.screenWidth = w;
    player.screenHeight = h;
  });

  socket.on("input mouse", ([x, y]) => player.onMouseMove(x, y));
  socket.on("input keyup", (key) => player.onKeyUp(key));
  socket.on("input keydown", (key) => player.onKeyDown(key));
});

// Update leaders every 500ms instead of every tick
let lastLeaderUpdate = 0;

setInterval(() => {
  server.update();

  const now = Date.now();
  const updateLeaders = now - lastLeaderUpdate > 500;
  if (updateLeaders) lastLeaderUpdate = now;

  for (const id in sockets) {
    const socket = sockets[id];
    const player = players.get(id);
    if (!player) continue;

    const add = player.addedVisibleNodes.map(b => [
      b.sendId,
      Math.round(b.x),
      Math.round(b.y),
      b.nick,
      Math.round(Math.sqrt(b.mass) * 10),
      Math.round(b.hue),
      b.isAgitated,
      b.nodeType
    ]);
    socket.compress(true).emit("add blobs", add);
    player.addedVisibleNodes = [];

    const remove = player.removedVisibleNodes.map(b => b.sendId);
    socket.compress(true).emit("remove blobs", remove);
    player.removedVisibleNodes = [];

    const move = player.movingVisibleNodes.map(b => [
      b.sendId,
      Math.round(b.x),
      Math.round(b.y),
      Math.round(Math.sqrt(b.mass) * 10)
    ]);
    socket.compress(true).emit("move blobs", move);
    player.movingVisibleNodes = [];

    if (updateLeaders) {
      socket.compress(true).emit("leaders", server.getLeaders());
    }

    if (player.blobs.length === 0 && player.joined) {
      socket.compress(true).emit("dead");
      player.joined = false;
      continue;
    }

    const translateX = player.centerX * player.drawZoom - player.screenWidth / 2;
    const translateY = player.centerY * player.drawZoom - player.screenHeight / 2;
    socket.compress(true).emit("center and zoom", [
      Math.round(translateX),
      Math.round(translateY),
      player.drawZoom
    ]);
  }
}, 1000 / 25); // 40ms (25 FPS)

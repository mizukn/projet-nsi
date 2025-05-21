// --- Dépendances et initialisation du serveur Express/Socket.io ---
const express = require("express");
const app = express();
const http = require("http").Server(app);
const io = require("socket.io")(http);

// Sert les fichiers statiques du dossier client
app.use(express.static(__dirname + "/../client"));

const port = process.env.PORT || 3000;
http.listen(port, () => {
    console.log("Le serv ecoute sur le port " + port);
});

// --- Types ---
type NodeType = -1 | 0 | 1 | 2 | 3;

// Interface de configuration du serveur de jeu
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

// --- Classes principales du jeu ---

/**
 * Classe de base pour tous les blobs (cellules, virus, nourriture, eject)
 */
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

    constructor(
        server: GameServer,
        nodeId: number,
        x: number,
        y: number,
        mass: number,
        parent: Player | null
    ) {
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

    // Calcule la vitesse de déplacement en fonction de la masse
    getSpeed(): number {
        return (25 * 1.6) / Math.pow(this.mass, 0.22);
    }
    // Vitesse lors d'un boost (split, eject, etc.)
    getBoostSpeed(): number {
        return 15 * 2.6 * Math.pow(this.mass, 0.0422);
    }
    // Rayon graphique du blob
    getSize(): number {
        return Math.sqrt(this.mass) * 10;
    }
    // Applique un boost dans une direction
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
    // Déplacement boosté (après split, eject, etc.)
    boostMove(delta: number) {
        this.x += this.boostEngine.x * delta;
        this.y += this.boostEngine.y * delta;
        this.boostEngine.x -= this.boostEngine.x * 0.05 * delta;
        this.boostEngine.y -= this.boostEngine.y * 0.05 * delta;
    }
    // Indique si le blob est encore en boost
    isBoosting(): boolean {
        return Math.hypot(this.boostEngine.x, this.boostEngine.y) > 15;
    }
    // Empêche de sortir de la map
    borderCheck() {
        const xStart = 0;
        const xEnd = this.server.config.width;
        const yStart = 0;
        const yEnd = this.server.config.width;
        this.x = Math.min(xEnd, Math.max(this.x, xStart));
        this.y = Math.min(yEnd, Math.max(this.y, yStart));
    }

    // Hooks pour héritage
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

/**
 * Classe pour les blobs des joueurs
 */
class PlayerBlob extends GameBlob {
    constructor(
        server: GameServer,
        nodeId: number,
        x: number,
        y: number,
        mass: number,
        parent: Player
    ) {
        super(server, nodeId, x, y, mass, parent);
        this.nodeType = 0;
    }
    // Perte de masse progressive
    decayMass(delta: number) {
        this.mass -= this.mass * 0.00005 * delta;
    }
    // Déplacement vers la souris
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
    // Manger les autres blobs dans la zone
    eat() {
        if (!this.parent) return;
        const nodes = this.server.getNodesInRange(this.x, this.y);
        const selfParentId = this.parent.id;
        const ejectNodes = nodes.filter((a) =>
            a.nodeType === 0 ? a.parent && a.parent.id !== selfParentId : true
        );
        for (const check of ejectNodes) {
            if (this.server.collisionHandler.canEat(this, check)) {
                this.onEat(check);
                check.onEaten(this);
            }
        }
    }
    // Peut fusionner avec un autre blob ?
    canCombine(): boolean {
        if (!this.server) return false;
        const required = 0.15 * this.mass + this.server.config.baseTime;
        return Date.now() - this.time >= required;
    }
}

/**
 * Classe pour les virus
 */
class Virus extends GameBlob {
    constructor(server: GameServer, nodeId: number, x: number, y: number, mass: number) {
        super(server, nodeId, x, y, mass, null);
        this.nodeType = 1;
        this.isAgitated = true;
        this.hue = 0xffffff;
    }
    // Quand le virus mange un blob
    onEat(prey: GameBlob) {
        this.mass += prey.mass;
        if (this.mass > this.server.config.virusMaxMass) {
            this.server.shootVirus(this, prey.getBoostAngle());
        }
    }
    // Peut manger les ejects
    eat() {
        const nodes = this.server.getNodesInRange(this.x, this.y);
        const ejectNodes = nodes.filter((a) => a.nodeType === 3);
        for (const check of ejectNodes) {
            if (this.server.collisionHandler.canEat(this, check)) {
                this.onEat(check);
                check.onEaten(this);
            }
        }
    }
    // Quand un joueur mange le virus
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
                    eater.x,
                    eater.y,
                    splitMass,
                    angle,
                    eater,
                    eater.parent!
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
                    eater.x,
                    eater.y,
                    splitMass,
                    angle,
                    eater,
                    eater.parent!
                );
                splitMass *= 0.55;
            }
            for (let i = 0; i < numSplits; i++) {
                const angle = Math.random() * 6.28;
                this.server.createPlayerBlob(
                    eater.x,
                    eater.y,
                    smallMass,
                    angle,
                    eater,
                    eater.parent!
                );
            }
        }
    }
}

/**
 * Classe pour la nourriture
 */
class Food extends GameBlob {
    constructor(server: GameServer, nodeId: number, x: number, y: number, mass: number) {
        super(server, nodeId, x, y, mass, null);
        this.nodeType = 2;
    }
    // Quand la nourriture est mangée, on en respawn une autre
    onEaten(_eater: GameBlob) {
        super.onEaten(_eater);
        this.server.addFood(1);
    }
}

/**
 * Classe pour les ejects (morceaux éjectés)
 */
class Eject extends GameBlob {
    constructor(server: GameServer, nodeId: number, x: number, y: number, mass: number) {
        super(server, nodeId, x, y, mass, null);
        this.nodeType = 3;
    }
    // Optionnel : comportement quand mangé
}

/**
 * Classe représentant un joueur
 */
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
    setNick(n: string) {
        this.nick = n;
    }
    getNick(): string {
        return this.nick === "" ? "Neuille" : this.nick;
    }
    onMouseMove(x: number, y: number) {
        this.rawMouseX = x;
        this.rawMouseY = y;
    }
    // Gestion des touches (split, eject)
    onKeyDown(key: number) {
        if (key === 87) {
            for (const blob of this.blobs) {
                this.server.addEject(blob);
            }
        }
        if (key === 32) {
            // Split : on ne split que les blobs éligibles, une seule fois par tick
            const blobsToSplit = this.blobs.filter(
                (blob) =>
                    blob.mass >= this.server.config.playerMinMassForSplit &&
                    this.blobs.length < this.server.config.playerMaxSplit
            );
            for (const blob of blobsToSplit) {
                this.server.splitPlayerBlob(blob);
                if (this.blobs.length >= this.server.config.playerMaxSplit) break;
            }
        }
    }
    onKeyUp(_key: number) {}
    // Calcule la direction de la souris
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
    // Met à jour la position centrale du joueur et la liste des blobs visibles
    updateCenter(delta: number) {
        let totalX = 0,
            totalY = 0,
            totalSize = 0;
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

        // Gestion des blobs visibles/ajoutés/retirés
        nodes.forEach((n) => {
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

        this.movingVisibleNodes = nodes.filter(
            (n) => n.nodeType === 0 || n.nodeType === 1 || n.nodeType === 3
        );
    }
}

/**
 * Classe principale du serveur de jeu
 */
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
        rangeWidth: 10000, // Largeur de la zone visible par joueur (à réduire pour moins de lag)
        rangeHeight: 10000,
        baseTime: 60000,
        width: 10000,
        height: 10000,
    };
    lastUpdateTime: number = Date.now();

    // Crée un nouveau joueur
    createPlayer(id: string, nick: string): Player {
        const player = new Player(this);
        player.setNick(nick);
        player.id = id;
        this.createPlayerBlob(
            Math.random() * this.config.width,
            Math.random() * this.config.height,
            this.config.playerStartMass,
            0,
            null,
            player
        );
        this.players.push(player);
        return player;
    }
    // Crée un blob pour un joueur
    createPlayerBlob(
        x: number,
        y: number,
        mass: number,
        angle: number,
        parentBlob: GameBlob | null,
        parent: Player
    ): PlayerBlob {
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
    // Split un blob joueur
    splitPlayerBlob(blob: PlayerBlob) {
        const numSplit = this.config.playerMaxSplit - blob.parent!.blobs.length;
        if (numSplit <= 0 || blob.mass < this.config.playerMinMassForSplit) return false;
        const angle = blob.parent!.getMouse(blob.x, blob.y).angle;
        this.createPlayerBlob(blob.x, blob.y, blob.mass * 0.5, angle, blob, blob.parent!);
    }
    // Tire un virus
    shootVirus(virus: Virus, angle: number) {
        const shoot = new Virus(this, this.nodes.length, virus.x, virus.y, this.config.virusMass);
        shoot.hue = virus.hue;
        virus.mass = this.config.virusMass;
        shoot.setBoost(angle);
        this.nodes.push(shoot);
    }
    // Ajoute de la nourriture
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
    // Ajoute des virus
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
    // Ajoute un eject
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
    // Retire un joueur du serveur
    removePlayer(player: Player) {
        const index = this.players.indexOf(player);
        if (index > -1) this.players.splice(index, 1);
    }
    // Retire un blob du serveur
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
    // Retourne les blobs dans la zone visible autour d'un point
    getNodesInRange(x: number, y: number): GameBlob[] {
        const xStart = x - this.config.rangeWidth / 2;
        const xEnd = x + this.config.rangeWidth / 2;
        const yStart = y - this.config.rangeHeight / 2;
        const yEnd = y + this.config.rangeHeight / 2;
        let allNodes: GameBlob[] = [...this.nodes];
        for (const plyr of this.players) {
            allNodes = allNodes.concat(plyr.blobs);
        }
        return allNodes.filter((a) => a.x > xStart && a.x < xEnd && a.y > yStart && a.y < yEnd);
    }
    // Retourne le classement (top 10)
    getLeaders(): string[] {
        const masses = this.players.map((player) => ({
            nick: player.getNick(),
            mass: player.blobs.reduce((sum, b) => sum + b.mass, 0),
        }));
        return masses
            .sort((a, b) => b.mass - a.mass)
            .slice(0, 10)
            .map((c) => c.nick);
    }
    // Retourne le temps écoulé depuis la dernière update
    getDelta(): number {
        return Date.now() - this.lastUpdateTime;
    }
    // Boucle principale du serveur (update du jeu)
    update() {
        const currDelta = this.getDelta() / 16;
        for (const player of this.players) {
            player.updateCenter(currDelta);
            for (const blob of player.blobs) {
                if (blob.mass >= this.config.playerMaxMass) {
                    this.createPlayerBlob(
                        blob.x,
                        blob.y,
                        blob.mass / 2,
                        Math.random() * 2 * Math.PI,
                        blob,
                        blob.parent!
                    );
                }
                blob.borderCheck();
                blob.eat();
                (blob as PlayerBlob).decayMass?.(currDelta);
                blob.move(currDelta);
                blob.boostMove(currDelta);
            }
            // Gestion des collisions/fusions entre blobs du même joueur
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
        // Update des autres blobs (nourriture, virus, ejects)
        for (const node of this.nodes) {
            node.borderCheck();
            node.eat();
            node.boostMove(currDelta);
            node.move(currDelta);
        }
        this.lastUpdateTime = Date.now();
    }
}

/**
 * Classe pour la gestion des collisions et des interactions
 */
class CollisionHandler {
    eatMassFactor = 0.2;
    eatDistFactor = 1;
    // Vérifie si deux blobs se chevauchent
    isOverlapping(blob: GameBlob, check: GameBlob) {
        if (!blob || !check) return;
        const x = check.x - blob.x;
        const y = check.y - blob.y;
        const distance = Math.hypot(x, y);
        const maxDistance = blob.getSize() + check.getSize();
        if (distance < maxDistance) {
            return {
                x,
                y,
                distance,
                maxDistance,
                squared: x * x + y * y,
            };
        }
        return false;
    }
    // Peut-on manger ce blob ?
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
    // Repousse deux blobs qui se chevauchent
    pushApart(blobA: GameBlob, blobB: GameBlob, delta: number) {
        if (!blobA || !blobB) return;
        const overlap = this.isOverlapping(blobA, blobB);
        if (!overlap) return;
        const p = overlap.maxDistance - overlap.distance;
        if (p <= 0) return;
        const px = (overlap.x / overlap.distance) * p;
        const py = (overlap.y / overlap.distance) * p;
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
    // Fusionne deux blobs du même joueur si possible
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

// --- Instance du serveur et gestion des sockets ---
const server = new GameServer();

// Vérifie les joueurs inactifs (heartbeat)
setInterval(() => {
    const now = Date.now();
    for (const player of server.players.slice()) {
        if ((player as any).lastHeartbeat && now - (player as any).lastHeartbeat > 10000) {
            // 10 secondes sans heartbeat = déconnexion du neuille
            const socket = sockets[player.id];
            if (socket) {
                socket.disconnect(true);
            }
            server.removePlayer(player);
            delete sockets[player.id];
            io.sockets.emit("msg", [
                "server",
                "",
                `${escapeHtml(player.getNick())} a été déconnecté pour inactivité.`,
            ]);
        }
    }
}, 2000);

// Ajoute la nourriture et les virus au démarrage
server.addFood(150);
server.addVirus(10);

// Dictionnaire des sockets connectés
const sockets: { [id: string]: Socket } = {};

// Fonction utilitaire pour échapper le HTML dans les pseudos/messages
function escapeHtml(unsafe: string) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Gestion des connexions Socket.io
io.on("connection", (socket) => {
    sockets[socket.id] = socket;

    const player = new Player(server);
    player.joined = false;
    player.id = socket.id;
    server.players.push(player);
    let joined = false;

    console.log("New connection: " + socket.id);

    // Heartbeat pour détecter les joueurs inactifs
    socket.on("heartbeat", () => {
        player.lastHeartbeat = Date.now();
    });

    // Quand un joueur rejoint la partie
    socket.on("join game", (d: [string, string, string]) => {
        if (player.joined) return;

        const servKey = d[0];
        const nick = d[1];

        player.setNick(nick);
        player.joined = true;
        socket.compress(true).emit("joined");

        // Gestion du chat et des commandes spéciales
        socket.on("msg", (m: string) => {
            if (typeof m === "string" && m.startsWith("-setmass ")) {
                const parts = m.split(" ");
                const newMass = parseFloat(parts[1]);
                if (!isNaN(newMass) && newMass > 0) {
                    for (const blob of player.blobs) {
                        blob.mass = newMass;
                    }
                    socket
                        .compress(true)
                        .emit("msg", ["server", "", `Votre masse a été changée à ${newMass}.`]);
                    return;
                }
            }
            const d = ["client", escapeHtml(player.getNick()), escapeHtml(m)];
            io.sockets.emit("msg", d);
        });
        // Spawn du joueur
        server.createPlayerBlob(
            Math.random() * server.config.width,
            Math.random() * server.config.height,
            server.config.playerStartMass,
            0,
            null,
            player
        );

        const m = ["game", "", `${escapeHtml(player.getNick())} a rejoint le jeu.`];
        socket.broadcast.emit("msg", m);

        // Envoie la liste initiale des blobs visibles
        const init: any[] = [];
        player.visibleNodes.forEach((b) => {
            init.push([
                b.sendId,
                Math.round(b.x),
                Math.round(b.y),
                b.nick,
                Math.round(Math.sqrt(b.mass) * 10),
                Math.round(b.hue),
                b.isAgitated,
                b.nodeType,
            ]);
        });
        socket.compress(true).emit("init blobs", init);

        console.log("connected");
        console.log("players: " + server.players.length);
    });

    // Déconnexion d'un joueur
    socket.on("disconnect", () => {
        const d = ["game", "", `${escapeHtml(player.getNick())} a quitté le jeu.`];
        socket.broadcast.emit("msg", d);

        delete sockets[socket.id];
        player.server.removePlayer(player);
    });

    // Mise à jour de la taille de l'écran du joueur
    socket.on("width and height", (d: [number, number]) => {
        player.screenWidth = d[0];
        player.screenHeight = d[1];
    });
    // Mouvement de la souris
    socket.on("input mouse", (data: [number, number]) => {
        player.onMouseMove(data[0], data[1]);
    });
    // Gestion des touches
    socket.on("input keyup", (data: number) => {
        player.onKeyUp(data);
    });
    socket.on("input keydown", (data: number) => {
        player.onKeyDown(data);
    });
});

// --- Boucle principale du jeu (tick serveur) ---
setInterval(() => {
    server.update();

    for (const key in sockets) {
        const socket = sockets[key];
        const player = server.players.find((a) => a.id === socket.id);
        if (!player) continue;

        // Blobs à ajouter
        const add: any[] = [];
        player.addedVisibleNodes.forEach((b) => {
            add.push([
                b.sendId,
                Math.round(b.x),
                Math.round(b.y),
                b.nick,
                Math.round(Math.sqrt(b.mass) * 10),
                Math.round(b.hue),
                b.isAgitated,
                b.nodeType,
            ]);
        });
        socket.compress(true).emit("add blobs", add);
        player.addedVisibleNodes = [];

        // Blobs à retirer
        const remove: any[] = [];
        player.removedVisibleNodes.forEach((b) => {
            remove.push(b.sendId);
        });
        socket.compress(true).emit("remove blobs", remove);
        player.removedVisibleNodes = [];

        // Blobs à déplacer
        const move: any[] = [];
        player.movingVisibleNodes.forEach((b) => {
            move.push([
                b.sendId,
                Math.round(b.x),
                Math.round(b.y),
                Math.round(Math.sqrt(b.mass) * 10),
            ]);
        });
        socket.compress(true).emit("move blobs", move);
        socket.compress(true).emit("leaders", server.getLeaders());

        // Si le joueur est mort (plus de blobs)
        if (player.blobs.length === 0 && player.joined === true) {
            socket.compress(true).emit("dead");
            (socket as any).joined = false;
            continue;
        }

        // Envoie la position de la caméra et le zoom
        const translateX = player.centerX * player.drawZoom - player.screenWidth / 2;
        const translateY = player.centerY * player.drawZoom - player.screenHeight / 2;
        const d = [Math.round(translateX), Math.round(translateY), player.drawZoom];
        socket.compress(true).emit("center and zoom", d);
    }
}, 1000 / 25); // 25 FPS (ajuster pour la perf)

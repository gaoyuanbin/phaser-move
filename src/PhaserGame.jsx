import { useEffect, useRef, useState, useCallback } from 'react';
import Phaser from 'phaser';
import * as Colyseus from 'colyseus.js';
import styles from './buttons.module.css';
const COLYSEUS_URL = import.meta.env.VITE_COLYSEUS_URL || 'ws://localhost:2567';
const ARENAS_URL = import.meta.env.VITE_ARENAS_URL || COLYSEUS_URL.replace(/^ws/, 'http') + '/arenas';
const ATTACKS_URL = import.meta.env.VITE_ATTACKS_URL || COLYSEUS_URL.replace(/^ws/, 'http') + '/attacks';

const SELF_COLOR = 0x00ffff;
const OTHER_COLOR = 0xff4444;
const IT_COLOR = 0xffff00;

const DASH_SPEED = 12;
const DASH_DURATION_MS = 150;
const DASH_END_LAG_MS = 250;

const HP_BAR_WIDTH = 50;
const HP_BAR_HEIGHT = 6;
const HP_BAR_OFFSET_Y = 35;

const ENERGY_BAR_WIDTH = 50;
const ENERGY_BAR_HEIGHT = 4;
const ENERGY_BAR_OFFSET_Y = HP_BAR_OFFSET_Y + HP_BAR_HEIGHT + 4;
const MAX_ENERGY = 100;

const POINTER_OFFSET = 50;

// Ported from PygameFighting's data/game_settings.json ("music_volume": 0.4)
// and assets/bg.png + assets/bgm.mp3.
const MUSIC_VOLUME = 0.4;

class HelloWorldScene extends Phaser.Scene {
  constructor() {
    super({ key: 'HelloWorldScene' });
  }

  init(data) {
    this.room = data.room;
    this.roomKind = data.roomKind;
    this.onDoor = data.onDoor;
    // Attack stats/visuals come from the server's data/attacks/*.json,
    // fetched once before this scene is created - nothing attack-specific
    // is hardcoded in the client.
    this.attacks = data.attacks || {};
  }

  preload() {
    this.load.image('bg', '/game/bg.png');
    this.load.audio('bgm', '/game/bgm.mp3');
  }

  create() {
    const { width, height } = this.scale;

    this.add.image(width / 2, height / 2, 'bg').setDisplaySize(width, height).setDepth(-1);

    this.bgm = this.sound.add('bgm', { loop: true, volume: MUSIC_VOLUME });
    this.bgm.play();
    this.events.once('shutdown', () => this.bgm.stop());

    this.doorTriggered = false;
    const doorIsToArenas = this.roomKind === 'main';
    this.door = this.add.rectangle(width - 50, height / 2, 60, 120, doorIsToArenas ? 0xffaa00 : 0x4488ff, 0.85);
    this.add.text(
      width - 130,
      height / 2 - 70,
      doorIsToArenas ? 'Door -> Arenas' : 'Door -> Main Lobby',
      { fontSize: '10px', color: '#ffffff' }
    );

    this.hpbar = this.add.rectangle(width / 2, height / 2 + HP_BAR_OFFSET_Y, HP_BAR_WIDTH, HP_BAR_HEIGHT, 0x222222);
    this.curhp = this.add.rectangle(width / 2, height / 2 + HP_BAR_OFFSET_Y, HP_BAR_WIDTH, HP_BAR_HEIGHT, 0x22ff22);
    this.energybar = this.add.rectangle(width / 2, height / 2 + ENERGY_BAR_OFFSET_Y, ENERGY_BAR_WIDTH, ENERGY_BAR_HEIGHT, 0x222222);
    this.curenergy = this.add.rectangle(width / 2, height / 2 + ENERGY_BAR_OFFSET_Y, ENERGY_BAR_WIDTH, ENERGY_BAR_HEIGHT, 0xffc800);

    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd = this.input.keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    });
    this.attackleft = this.input.keyboard.addKeys({
      basic: Phaser.Input.Keyboard.KeyCodes.E,
      super: Phaser.Input.Keyboard.KeyCodes.R,
    })
    this.attackright = this.input.keyboard.addKeys({
      basic: Phaser.Input.Keyboard.KeyCodes.FORWARD_SLASH,
      super: Phaser.Input.Keyboard.KeyCodes.PERIOD,
    })
    this.dashKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.dashKeyL = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.Q);
    this.dashKeyR = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);
    this.otherPlayers = {};
    this.player = this.add.rectangle(width / 2, height / 2, 50, 50, SELF_COLOR);
    this.pointer = this.add.triangle(width / 2, height / 2, 10, 0, 20, 20, 0, 20, 0xff0000);

    this.statusText = this.add.text(10, 10, 'Connecting...', { fontSize: '14px', color: '#ffff00' });

    this.facing = 'right';
    this.pointer.rotation = this.facingAngle();
    this.pointer.x = this.player.x + this.facingVector().x * POINTER_OFFSET;
    this.pointer.y = this.player.y + this.facingVector().y * POINTER_OFFSET;
    this.maxHp = 100;
    this.nextAttackTime = 0;
    this.dashEndTime = 0;
    this.actionLockEndTime = 0;
    this.dashDirection = 1;
    this.itSessionId = null;

    if (this.room) {
      this.setupRoom(this.room);
    }
  }

  tryAttack(attackId, time) {
    if (!this.room || this.roomKind !== 'arena') return;
    const attack = this.attacks[attackId];
    if (!attack) return;
    this.nextAttackTime = time + attack.cooldownMs;
    this.room.send('attack', { attackId, direction: this.facing });
    this.showAttackEffect(attackId, this.player.x, this.player.y, this.facing);
  }

  showAttackEffect(attackId, x, y, direction) {
    const attack = this.attacks[attackId];
    if (!attack) return;
    const fx = attack.effect;
    const offset = direction === 'left' ? -fx.offsetFromPlayer : fx.offsetFromPlayer;
    const swing = this.add.rectangle(x + offset, y, fx.width, fx.height, Number(fx.color), fx.alpha);
    this.tweens.add({
      targets: swing,
      alpha: 0,
      duration: fx.durationMs,
      onComplete: () => swing.destroy(),
    });
  }

  showDashEffect(x, y) {
    const trail = this.add.rectangle(x, y, 50, 50, 0x66ccff, 0.5);
    this.tweens.add({
      targets: trail,
      alpha: 0,
      duration: DASH_END_LAG_MS,
      onComplete: () => trail.destroy(),
    });
  }

  facingAngle() {
    // Triangle vertices (10,0),(20,20),(0,20) point "up" at rotation 0,
    // so left/right are +-90 degrees from there. Up/down can slot in as
    // 0 and Math.PI once those directions exist.
    switch (this.facing) {
      case 'left': return -Math.PI / 2;
      case 'right': return Math.PI / 2;
      case 'up': return 0;
      case 'down': return Math.PI;
      default: return Math.PI / 2;
    }
  }

  facingVector() {
    switch (this.facing) {
      case 'left': return { x: -1, y: 0 };
      case 'right': return { x: 1, y: 0 };
      case 'up': return { x: 0, y: -1 };
      case 'down': return { x: 0, y: 1 };
      default: return { x: 1, y: 0 };
    }
  }

  setHpBar(hp) {
    this.curhp.setDisplaySize(HP_BAR_WIDTH * (hp / this.maxHp), HP_BAR_HEIGHT);
  }

  setEnergyBar(energy) {
    this.curenergy.setDisplaySize(ENERGY_BAR_WIDTH * (energy / MAX_ENERGY), ENERGY_BAR_HEIGHT);
  }

  colorForPlayer(sessionId) {
    if (sessionId === this.itSessionId) return IT_COLOR;
    return sessionId === this.room?.sessionId ? SELF_COLOR : OTHER_COLOR;
  }

  updateItColors() {
    this.player.fillColor = this.colorForPlayer(this.room?.sessionId);
    for (const [sessionId, other] of Object.entries(this.otherPlayers)) {
      other.rect.fillColor = this.colorForPlayer(sessionId);
    }
  }

  createOtherPlayer(sessionId, x, y) {
    const rect = this.add.rectangle(x, y, 50, 50, this.colorForPlayer(sessionId));
    const hpBg = this.add.rectangle(x, y + HP_BAR_OFFSET_Y, HP_BAR_WIDTH, HP_BAR_HEIGHT, 0x222222);
    const hpFill = this.add.rectangle(x, y + HP_BAR_OFFSET_Y, HP_BAR_WIDTH, HP_BAR_HEIGHT, 0x22ff22);
    const other = { rect, hpBg, hpFill };
    this.otherPlayers[sessionId] = other;
    return other;
  }

  positionOtherPlayer(other, x, y) {
    other.rect.x = x;
    other.rect.y = y;
    other.hpBg.x = x;
    other.hpBg.y = y + HP_BAR_OFFSET_Y;
    other.hpFill.y = y + HP_BAR_OFFSET_Y;
    other.hpFill.x = x - (HP_BAR_WIDTH - other.hpFill.displayWidth) / 2;
  }

  setOtherPlayerHp(other, hp) {
    other.hpFill.setDisplaySize(HP_BAR_WIDTH * (hp / this.maxHp), HP_BAR_HEIGHT);
    other.hpFill.x = other.rect.x - (HP_BAR_WIDTH - other.hpFill.displayWidth) / 2;
  }

  setupRoom(room) {
    this.room = room;
    this.statusText.setText('Connected');
    this.room.onMessage("imroom", (data) => {
      this.roomKind = data.roomtype;
    })
    this.room.onMessage('playerJoined', ({ sessionId }) => {
      if (sessionId === this.room.sessionId) return;
      if (!this.otherPlayers[sessionId]) {
        this.createOtherPlayer(sessionId, this.scale.width / 2, this.scale.height / 2);
        this.room.send('sayHi', { x: this.player.x, y: this.player.y });
      }
      console.log('players:', [this.room.sessionId, ...Object.keys(this.otherPlayers)]);
    });

    this.room.onMessage('playerSaidHi', ({ sessionId, x, y }) => {
      if (sessionId === this.room.sessionId) return;
      if (!this.otherPlayers[sessionId]) {
        this.createOtherPlayer(sessionId, x, y);
      } else {
        this.positionOtherPlayer(this.otherPlayers[sessionId], x, y);
      }
    });

    this.room.onMessage('playerMoved', ({ sessionId, x, y }) => {
      if (sessionId === this.room.sessionId) return;
      const other = this.otherPlayers[sessionId] || this.createOtherPlayer(sessionId, this.scale.width / 2, this.scale.height / 2);
      this.positionOtherPlayer(other, x, y);
    });

    this.room.onMessage('playerLeft', ({ sessionId }) => {
      const other = this.otherPlayers[sessionId];
      if (other) {
        other.rect.destroy();
        other.hpBg.destroy();
        other.hpFill.destroy();
        delete this.otherPlayers[sessionId];
      }
    });

    this.room.onMessage('itStatus', ({ sessionId }) => {
      this.itSessionId = sessionId;
      this.updateItColors();
    });

    this.room.onMessage('itChanged', ({ sessionId }) => {
      this.itSessionId = sessionId;
      this.updateItColors();
    });

    this.room.onMessage('playerAttacked', ({ sessionId, attackId, direction }) => {
      if (sessionId === this.room.sessionId) return;
      const other = this.otherPlayers[sessionId];
      if (other) this.showAttackEffect(attackId, other.rect.x, other.rect.y, direction);
    });

    this.room.onMessage('playerHit', ({ sessionId, hp }) => {
      if (sessionId === this.room.sessionId) {
        this.setHpBar(hp);
      } else if (this.otherPlayers[sessionId]) {
        this.setOtherPlayerHp(this.otherPlayers[sessionId], hp);
      }
    });

    this.room.onMessage('playerRespawned', ({ sessionId, x, y, hp }) => {
      if (sessionId === this.room.sessionId) {
        this.player.x = x;
        this.player.y = y;
        this.setHpBar(hp);
      } else if (this.otherPlayers[sessionId]) {
        const other = this.otherPlayers[sessionId];
        this.positionOtherPlayer(other, x, y);
        this.setOtherPlayerHp(other, hp);
      }
    });

    // Energy is private to each client - the server only ever sends us our own.
    this.room.onMessage('energyUpdate', ({ energy }) => {
      this.setEnergyBar(energy);
    });

    // Announce ourselves now that our handlers are mounted, so the server can
    // reply directly with everyone already in the room (see HelloRoom's "sayHi" handler) -
    // waiting on other clients to react to our "playerJoined" broadcast is racy,
    // since that can arrive before our own handlers are ready.
    this.room.send('sayHi', { x: this.player.x, y: this.player.y });
  }

  update(time) {
    let moved = false;
    const dashing = time < this.dashEndTime;
    const locked = time < this.actionLockEndTime;

    if (dashing) {
      this.player.x += DASH_SPEED * this.dashDirection;
      moved = true;
    } else if (!locked) {
      if (this.cursors.left.isDown || this.wasd.left.isDown) { this.player.x -= 3; moved = true; this.facing = 'left'; }
      if (this.cursors.right.isDown || this.wasd.right.isDown) { this.player.x += 3; moved = true; this.facing = 'right'; }
      if (this.cursors.up.isDown || this.wasd.up.isDown) { this.player.y -= 3; moved = true; this.facing = "up"}
      if (this.cursors.down.isDown || this.wasd.down.isDown) { this.player.y += 3; moved = true; this.facing = "down"}
    }
    const hw = this.player.width / 2;
    const hh = this.player.height / 2;
    this.player.x = Phaser.Math.Clamp(this.player.x, hw, this.scale.width - hw);
    this.player.y = Phaser.Math.Clamp(this.player.y, hh, this.scale.height - hh);

    const facingVec = this.facingVector();
    this.pointer.x = this.player.x + facingVec.x * POINTER_OFFSET;
    this.pointer.y = this.player.y + facingVec.y * POINTER_OFFSET;
    this.pointer.rotation = this.facingAngle();

    const hpBarY = this.player.y + HP_BAR_OFFSET_Y;
    this.hpbar.x = this.player.x;
    this.hpbar.y = hpBarY;
    this.curhp.y = hpBarY;
    this.curhp.x = this.player.x - (HP_BAR_WIDTH - this.curhp.displayWidth) / 2;

    const energyBarY = this.player.y + ENERGY_BAR_OFFSET_Y;
    this.energybar.x = this.player.x;
    this.energybar.y = energyBarY;
    this.curenergy.y = energyBarY;
    this.curenergy.x = this.player.x - (ENERGY_BAR_WIDTH - this.curenergy.displayWidth) / 2;

    if (moved && this.room) {
      this.room.send('move', { x: this.player.x, y: this.player.y });
    }
    const attackPressed = Phaser.Input.Keyboard.JustDown(this.attackleft.basic) || Phaser.Input.Keyboard.JustDown(this.attackright.basic);
    const superPressed = Phaser.Input.Keyboard.JustDown(this.attackleft.super) || Phaser.Input.Keyboard.JustDown(this.attackright.super)
    if (attackPressed && !locked && time > this.nextAttackTime) {
      this.tryAttack('attack', time);
    } else if (!attackPressed && superPressed && !locked && time > this.nextAttackTime) {
      this.tryAttack('superAttack', time);
    }

    if (!locked && (Phaser.Input.Keyboard.JustDown(this.dashKey)||Phaser.Input.Keyboard.JustDown(this.dashKeyL)||Phaser.Input.Keyboard.JustDown(this.dashKeyR))) {
      this.dashDirection = this.facing === 'left' ? -1 : 1;
      this.dashEndTime = time + DASH_DURATION_MS;
      this.actionLockEndTime = this.dashEndTime + DASH_END_LAG_MS;
      this.showDashEffect(this.player.x, this.player.y);
    }

    if (!this.doorTriggered && this.onDoor && Phaser.Geom.Intersects.RectangleToRectangle(this.player.getBounds(), this.door.getBounds())) {
      this.doorTriggered = true;
      this.onDoor();
    }
  }
}

export default function PhaserGame() {
  const containerRef = useRef(null);
  const gameRef = useRef(null);
  const [client] = useState(() => new Colyseus.Client(COLYSEUS_URL));

  const [room, setRoom] = useState(null);
  const [roomKind, setRoomKind] = useState(null); // 'main' | 'arena'
  const [arenas, setArenas] = useState([]);
  const [attacks, setAttacks] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Attack stats/visuals are data-driven (colyseus-server/data/attacks/*.json),
  // fetched once on load rather than hardcoded in this component.
  useEffect(() => {
    let ignore = false;
    fetch(ATTACKS_URL)
      .then((res) => res.json())
      .then((data) => { if (!ignore) setAttacks(data); })
      .catch((e) => console.error('Failed to load attack data:', e));
    return () => { ignore = true; };
  }, []);

  const fetchArenas = useCallback(async () => {
    try {
      const res = await fetch(ARENAS_URL);
      return await res.json();
    } catch (e) {
      console.error('Failed to list arenas:', e);
      return null;
    }
  }, []);

  const refreshArenas = async () => {
    const rooms = await fetchArenas();
    if (rooms) setArenas(rooms);
  };

  // Poll the arena list while sitting in the menu.
  useEffect(() => {
    if (room) return;
    let ignore = false;

    async function poll() {
      const rooms = await fetchArenas();
      if (!ignore && rooms) setArenas(rooms);
    }

    poll();
    const interval = setInterval(poll, 2000);
    return () => { ignore = true; clearInterval(interval); };
  }, [room, fetchArenas]);

  const joinMainLobby = async () => {
    setBusy(true); setError('');
    try {
      setRoom(await client.joinOrCreate('hello_room'));
      setRoomKind('main');
    } catch (e) {
      console.error('Failed to join main lobby:', e);
      setError('Could not join the main lobby.');
    } finally {
      setBusy(false);
    }
  };

  const createArena = async () => {
    setBusy(true); setError('');
    try {
      setRoom(await client.create('arena_room'));
      setRoomKind('arena');
    } catch (e) {
      console.error('Failed to create arena:', e);
      setError('Could not create an arena.');
    } finally {
      setBusy(false);
    }
  };

  const joinTagGame = async () => {
    setBusy(true); setError('');
    try {
      setRoom(await client.joinOrCreate('tag_room'));
      setRoomKind('tag');
    } catch (e) {
      console.error('Failed to join tag game:', e);
      setError('Could not join the tag game.');
    } finally {
      setBusy(false);
    }
  };

  const joinArena = async (roomId) => {
    setBusy(true); setError('');
    try {
      setRoom(await client.joinById(roomId));
      setRoomKind('arena');
    } catch (e) {
      console.error('Failed to join arena:', e);
      setError('Could not join that arena — it may be full or gone.');
      refreshArenas();
    } finally {
      setBusy(false);
    }
  };

  // Door in hello_room leads to the arena browser; door in arena_room leads straight back to the main lobby.
  const handleDoor = useCallback(async () => {
    if (roomKind === 'main') {
      setRoom(null);
      setRoomKind(null);
      return;
    }
    try {
      const newRoom = await client.joinOrCreate('hello_room');
      setRoomKind('main');
      setRoom(newRoom);
    } catch (e) {
      console.error('Failed to return to main lobby:', e);
    }
  }, [roomKind, client]);

  // Mount the Phaser game once a room has been picked/created and attack data has loaded.
  useEffect(() => {
    if (!room || !attacks) return;

    gameRef.current = new Phaser.Game({
      type: Phaser.AUTO,
      width: 1000,
      height: 600,
      backgroundColor: '#1a1a2e',
      parent: containerRef.current,
    });
    gameRef.current.scene.add('HelloWorldScene', HelloWorldScene, true, { room, roomKind, onDoor: handleDoor, attacks });

    setTimeout(() => {
      const canvas = containerRef.current?.querySelector('canvas');
      if (canvas) { canvas.tabIndex = 1; canvas.focus(); }
    }, 500);

    return () => {
      room.leave();
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, [room, roomKind, attacks, handleDoor]);

  if (!room) {
    return (
      <div style={{ color: '#fff', fontFamily: 'sans-serif', padding: 20, maxWidth: 480 }}>
        <h2>Main Lobby</h2>
        <p style={{ opacity: 0.7, fontSize: 14 }}>One shared room. Attacking is disabled here.</p>
        <button className = {styles.menu} disabled={busy || !attacks} onClick={joinMainLobby}>{busy ? 'Connecting…' : 'Join Main Lobby'}</button>

        <h2 style={{ marginTop: 32 }}>Tag</h2>
        <p style={{ opacity: 0.7, fontSize: 14 }}>One shared room. Whoever's "it" (yellow) tags the next by touch.</p>
        <button className={styles.menu} disabled={busy || !attacks} onClick={joinTagGame}>{busy ? 'Connecting…' : 'Join Tag Game'}</button>

        <h2 style={{ marginTop: 32 }}>Arenas</h2>
        <p style={{ opacity: 0.7, fontSize: 14 }}>Small rooms, up to 8 players, attacking enabled. Anyone can create one.</p>
        <button className={styles.menu} disabled={busy || !attacks} onClick={createArena}>{busy ? 'Connecting…' : 'Create New Arena'}</button>
        <button className={styles.menu} disabled={busy || !attacks} onClick={refreshArenas} style={{ marginLeft: 8 }}>Refresh</button>
        {busy && <p style={{ opacity: 0.7, fontSize: 13, marginTop: 8 }}>Connecting to server… this can take up to 30s if it's been idle.</p>}

        <ul style={{ paddingLeft: 20 }}>
          {arenas.map((a) => (
            <li key={a.roomId} style={{ marginBottom: 6 }}>
              {a.name || 'Arena'} ({a.roomId.slice(0, 6)}) — {a.clients}/{a.maxClients} players
              <button
                  className={styles.menu}
                style={{ marginLeft: 8 }}
                disabled={busy || a.clients >= a.maxClients}
                onClick={() => joinArena(a.roomId)}
              >
                {busy ? 'Connecting…' : 'Join'}
              </button>
            </li>
          ))}
          {arenas.length === 0 && <li>No open arenas — create one!</li>}
        </ul>

        {!attacks && <p style={{ opacity: 0.7, fontSize: 13, marginTop: 8 }}>Loading attack data…</p>}
        {error && <p style={{ color: 'salmon' }}>{error}</p>}
      </div>
    );
  }

  return <div ref={containerRef} />;
}

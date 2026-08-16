import { useEffect, useRef, useState, useCallback } from 'react';
import Phaser from 'phaser';
import * as Colyseus from 'colyseus.js';
import styles from './buttons.module.css';
const COLYSEUS_URL = import.meta.env.VITE_COLYSEUS_URL || 'ws://localhost:2567';
const ARENAS_URL = import.meta.env.VITE_ARENAS_URL || COLYSEUS_URL.replace(/^ws/, 'http') + '/arenas';

const SELF_COLOR = 0x00ffff;
const OTHER_COLOR = 0xff4444;
const IT_COLOR = 0xffff00;

const DASH_SPEED = 12;
const DASH_DURATION_MS = 150;
const DASH_END_LAG_MS = 250;

const SUPER_ATTACK_COOLDOWN_MS = 3000;

const HP_BAR_WIDTH = 50;
const HP_BAR_HEIGHT = 6;
const HP_BAR_OFFSET_Y = 35;

class HelloWorldScene extends Phaser.Scene {
  constructor() {
    super({ key: 'HelloWorldScene' });
  }

  init(data) {
    this.room = data.room;
    this.roomKind = data.roomKind;
    this.onDoor = data.onDoor;
  }

  create() {
    const { width, height } = this.scale;

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
    this.statusText = this.add.text(10, 10, 'Connecting...', { fontSize: '14px', color: '#ffff00' });

    this.facing = 'right';
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

  showAttackEffect(x, y, direction) {
    const offset = direction === 'left' ? -40 : 40;
    const swing = this.add.rectangle(x + offset, y, 40, 50, 0xffff00, 0.6);
    this.tweens.add({
      targets: swing,
      alpha: 0,
      duration: 150,
      onComplete: () => swing.destroy(),
    });
  }

  showSuperEffect(x, y, direction) {
    const offset = direction === 'left' ? -100 : 100;
    const swing = this.add.rectangle(x+offset, y, 100, 70, 0xffff22, 0.65)
    this.tweens.add({
      targets: swing,
      alpha: 0,
      duration: 200,
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

  setHpBar(hp) {
    this.curhp.setDisplaySize(HP_BAR_WIDTH * (hp / this.maxHp), HP_BAR_HEIGHT);
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

    this.room.onMessage('playerAttacked', ({ sessionId, direction }) => {
      if (sessionId === this.room.sessionId) return;
      const other = this.otherPlayers[sessionId];
      if (other) this.showAttackEffect(other.rect.x, other.rect.y, direction);
    });

    this.room.onMessage('playerSuperAttacked', ({ sessionId, direction }) => {
      if (sessionId === this.room.sessionId) return;
      const other = this.otherPlayers[sessionId];
      if (other) this.showSuperEffect(other.rect.x, other.rect.y, direction);
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
      if (this.cursors.up.isDown || this.wasd.up.isDown) { this.player.y -= 3; moved = true; }
      if (this.cursors.down.isDown || this.wasd.down.isDown) { this.player.y += 3; moved = true; }
    }
    const hw = this.player.width / 2;
    const hh = this.player.height / 2;
    this.player.x = Phaser.Math.Clamp(this.player.x, hw, this.scale.width - hw);
    this.player.y = Phaser.Math.Clamp(this.player.y, hh, this.scale.height - hh);

    const hpBarY = this.player.y + HP_BAR_OFFSET_Y;
    this.hpbar.x = this.player.x;
    this.hpbar.y = hpBarY;
    this.curhp.y = hpBarY;
    this.curhp.x = this.player.x - (HP_BAR_WIDTH - this.curhp.displayWidth) / 2;

    if (moved && this.room) {
      this.room.send('move', { x: this.player.x, y: this.player.y });
    }

    const attackPressed = Phaser.Input.Keyboard.JustDown(this.attackleft.basic) || Phaser.Input.Keyboard.JustDown(this.attackright.basic);
    const superPressed = Phaser.Input.Keyboard.JustDown(this.attackleft.super) || Phaser.Input.Keyboard.JustDown(this.attackright.super)
    if (attackPressed && this.room && !locked && time > this.nextAttackTime && this.roomKind === "arena") {
      this.nextAttackTime = time + 500;
      this.room.send('attack', { direction: this.facing });
      this.showAttackEffect(this.player.x, this.player.y, this.facing);
    }
    if (!attackPressed && superPressed && this.room && !locked && time > this.nextAttackTime && this.roomKind === "arena") {
      this.nextAttackTime = time + SUPER_ATTACK_COOLDOWN_MS;
      this.room.send('superAttack', { direction: this.facing });
      this.showSuperEffect(this.player.x, this.player.y, this.facing);
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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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

  // Mount the Phaser game once a room has been picked/created.
  useEffect(() => {
    if (!room) return;

    gameRef.current = new Phaser.Game({
      type: Phaser.AUTO,
      width: 1000,
      height: 600,
      backgroundColor: '#1a1a2e',
      parent: containerRef.current,
    });
    gameRef.current.scene.add('HelloWorldScene', HelloWorldScene, true, { room, roomKind, onDoor: handleDoor });

    setTimeout(() => {
      const canvas = containerRef.current?.querySelector('canvas');
      if (canvas) { canvas.tabIndex = 1; canvas.focus(); }
    }, 500);

    return () => {
      room.leave();
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, [room, roomKind, handleDoor]);

  if (!room) {
    return (
      <div style={{ color: '#fff', fontFamily: 'sans-serif', padding: 20, maxWidth: 480 }}>
        <h2>Main Lobby</h2>
        <p style={{ opacity: 0.7, fontSize: 14 }}>One shared room. Attacking is disabled here.</p>
        <button className = {styles.menu} disabled={busy} onClick={joinMainLobby}>{busy ? 'Connecting…' : 'Join Main Lobby'}</button>

        <h2 style={{ marginTop: 32 }}>Tag</h2>
        <p style={{ opacity: 0.7, fontSize: 14 }}>One shared room. Whoever's "it" (yellow) tags the next by touch.</p>
        <button className={styles.menu} disabled={busy} onClick={joinTagGame}>{busy ? 'Connecting…' : 'Join Tag Game'}</button>

        <h2 style={{ marginTop: 32 }}>Arenas</h2>
        <p style={{ opacity: 0.7, fontSize: 14 }}>Small rooms, up to 8 players, attacking enabled. Anyone can create one.</p>
        <button className={styles.menu} disabled={busy} onClick={createArena}>{busy ? 'Connecting…' : 'Create New Arena'}</button>
        <button className={styles.menu} disabled={busy} onClick={refreshArenas} style={{ marginLeft: 8 }}>Refresh</button>
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

        {error && <p style={{ color: 'salmon' }}>{error}</p>}
      </div>
    );
  }

  return <div ref={containerRef} />;
}

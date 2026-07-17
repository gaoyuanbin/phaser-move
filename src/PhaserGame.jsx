import { useEffect, useRef, useState, useCallback } from 'react';
import Phaser from 'phaser';
import * as Colyseus from 'colyseus.js';

const COLYSEUS_URL = import.meta.env.VITE_COLYSEUS_URL || 'ws://localhost:2567';
const ARENAS_URL = import.meta.env.VITE_ARENAS_URL || COLYSEUS_URL.replace(/^ws/, 'http') + '/arenas';

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

    this.hpbar = this.add.rectangle(25, 300, 50, 500, 0x222222);
    this.curhp = this.add.rectangle(25, 300, 50, 500, 0x22ff22);
    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd = this.input.keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    });
    this.attackleft = this.input.keyboard.addKeys({
      basic: Phaser.Input.Keyboard.KeyCodes.E,
    })
    this.attackright = this.input.keyboard.addKeys({
      basic: Phaser.Input.Keyboard.KeyCodes.FORWARD_SLASH,
    })
    this.otherPlayers = {};
    this.player = this.add.rectangle(width / 2, height / 2, 50, 50, 0x00ffff);
    this.statusText = this.add.text(10, 10, 'Connecting...', { fontSize: '14px', color: '#ffff00' });

    this.facing = 'right';
    this.maxHp = 100;
    this.nextAttackTime = 0;

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

  setHpBar(hp) {
    const bottomY = 550;
    const newHeight = 500 * (hp / this.maxHp);
    this.curhp.height = newHeight;
    this.curhp.y = bottomY - newHeight / 2;
  }

  setupRoom(room) {
    this.room = room;
    this.roomKind = 'default';
    this.statusText.setText('Connected');
    this.room.onMessage("imroom", (data) => {
      this.roomKind = data.roomtype;
    })
    this.room.onMessage('playerJoined', ({ sessionId }) => {
      if (sessionId === this.room.sessionId) return;
      if (!this.otherPlayers[sessionId]) {
        this.otherPlayers[sessionId] = this.add.rectangle(this.scale.width / 2, this.scale.height / 2, 50, 50, 0xff4444);
        this.room.send('sayHi', { x: this.player.x, y: this.player.y });
      }
      console.log('players:', [this.room.sessionId, ...Object.keys(this.otherPlayers)]);
    });

    this.room.onMessage('playerSaidHi', ({ sessionId, x, y }) => {
      if (sessionId === this.room.sessionId) return;
      if (!this.otherPlayers[sessionId]) {
        this.otherPlayers[sessionId] = this.add.rectangle(x, y, 50, 50, 0xff4444);
      }
    });

    this.room.onMessage('playerMoved', ({ sessionId, x, y }) => {
      if (sessionId === this.room.sessionId) return;
      if (!this.otherPlayers[sessionId]) {
        this.otherPlayers[sessionId] = this.add.rectangle(this.scale.width / 2, this.scale.height / 2, 50, 50, 0xff4444);
      }
      this.otherPlayers[sessionId].x = x;
      this.otherPlayers[sessionId].y = y;
    });

    this.room.onMessage('playerLeft', ({ sessionId }) => {
      if (this.otherPlayers[sessionId]) {
        this.otherPlayers[sessionId].destroy();
        delete this.otherPlayers[sessionId];
      }
    });

    this.room.onMessage('playerAttacked', ({ sessionId, direction }) => {
      if (sessionId === this.room.sessionId) return;
      const other = this.otherPlayers[sessionId];
      if (other) this.showAttackEffect(other.x, other.y, direction);
    });

    this.room.onMessage('playerHit', ({ sessionId, hp }) => {
      if (sessionId === this.room.sessionId) {
        this.setHpBar(hp);
      }
    });

    this.room.onMessage('playerRespawned', ({ sessionId, x, y, hp }) => {
      if (sessionId === this.room.sessionId) {
        this.player.x = x;
        this.player.y = y;
        this.setHpBar(hp);
      } else if (this.otherPlayers[sessionId]) {
        this.otherPlayers[sessionId].x = x;
        this.otherPlayers[sessionId].y = y;
      }
    });
  }

  update(time) {
    let moved = false;

    if (this.cursors.left.isDown || this.wasd.left.isDown) { this.player.x -= 3; moved = true; this.facing = 'left'; }
    if (this.cursors.right.isDown || this.wasd.right.isDown) { this.player.x += 3; moved = true; this.facing = 'right'; }
    if (this.cursors.up.isDown || this.wasd.up.isDown) { this.player.y -= 3; moved = true; }
    if (this.cursors.down.isDown || this.wasd.down.isDown) { this.player.y += 3; moved = true; }
    const hw = this.player.width / 2;
    const hh = this.player.height / 2;
    this.player.x = Phaser.Math.Clamp(this.player.x, hw, this.scale.width - hw);
    this.player.y = Phaser.Math.Clamp(this.player.y, hh, this.scale.height - hh);

    if (moved && this.room) {
      this.room.send('move', { x: this.player.x, y: this.player.y });
    }

    const attackPressed = Phaser.Input.Keyboard.JustDown(this.attackleft.basic) || Phaser.Input.Keyboard.JustDown(this.attackright.basic);
    if (attackPressed && this.room && time > this.nextAttackTime && this.roomKind === "arena") {
      this.nextAttackTime = time + 500;
      this.room.send('attack', { direction: this.facing });
      this.showAttackEffect(this.player.x, this.player.y, this.facing);
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
        <button disabled={busy} onClick={joinMainLobby}>Join Main Lobby</button>

        <h2 style={{ marginTop: 32 }}>Arenas</h2>
        <p style={{ opacity: 0.7, fontSize: 14 }}>Small rooms, up to 8 players, attacking enabled. Anyone can create one.</p>
        <button disabled={busy} onClick={createArena}>Create New Arena</button>
        <button disabled={busy} onClick={refreshArenas} style={{ marginLeft: 8 }}>Refresh</button>

        <ul style={{ paddingLeft: 20 }}>
          {arenas.map((a) => (
            <li key={a.roomId} style={{ marginBottom: 6 }}>
              {a.name || 'Arena'} ({a.roomId.slice(0, 6)}) — {a.clients}/{a.maxClients} players
              <button
                style={{ marginLeft: 8 }}
                disabled={busy || a.clients >= a.maxClients}
                onClick={() => joinArena(a.roomId)}
              >
                Join
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

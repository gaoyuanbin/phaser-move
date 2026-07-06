import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import * as Colyseus from 'colyseus.js';

class HelloWorldScene extends Phaser.Scene {
  constructor() {
    super({ key: 'HelloWorldScene' });
  }

  create() {
    const { width, height } = this.scale;

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
  }

  setupRoom(room) {
    this.room = room;
    this.statusText.setText('Connected');

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
  }

  update() {
    let moved = false;

    if (this.cursors.left.isDown || this.wasd.left.isDown) { this.player.x -= 3; moved = true; }
    if (this.cursors.right.isDown || this.wasd.right.isDown) { this.player.x += 3; moved = true; }
    if (this.cursors.up.isDown || this.wasd.up.isDown) { this.player.y -= 3; moved = true; }
    if (this.cursors.down.isDown || this.wasd.down.isDown) { this.player.y += 3; moved = true; }

    const hw = this.player.width / 2;
    const hh = this.player.height / 2;
    this.player.x = Phaser.Math.Clamp(this.player.x, hw, this.scale.width - hw);
    this.player.y = Phaser.Math.Clamp(this.player.y, hh, this.scale.height - hh);

    if (moved && this.room) {
      this.room.send('move', { x: this.player.x, y: this.player.y });
    }
  }
}

export default function PhaserGame() {
  const containerRef = useRef(null);
  const gameRef = useRef(null);

  useEffect(() => {
    if (gameRef.current) return;

    let room = null;
    let cancelled = false;

    gameRef.current = new Phaser.Game({
      type: Phaser.AUTO,
      width: 1000,
      height: 600,
      backgroundColor: '#1a1a2e',
      scene: HelloWorldScene,
      parent: containerRef.current,

    });

    setTimeout(() => {
      const canvas = containerRef.current?.querySelector('canvas');
      if (canvas) { canvas.tabIndex = 1; canvas.focus(); }
    }, 500);

    (async () => {
      try {
        const client = new Colyseus.Client(import.meta.env.VITE_COLYSEUS_URL || 'ws://localhost:2567');
        room = await client.joinOrCreate('hello_room');
        if (cancelled) { room.leave(); return; }
        const scene = gameRef.current?.scene.getScene('HelloWorldScene');
        if (scene) {
          scene.setupRoom(room);
        } else {
          room.leave();
        }
      } catch (e) {
        console.error('Colyseus connection failed:', e);
        const scene = gameRef.current?.scene.getScene('HelloWorldScene');
        if (scene) scene.statusText.setText('Server offline — playing locally');
      }
    })();

    return () => {
      cancelled = true;
      room?.leave();
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, []);

  return <div ref={containerRef} />;
}

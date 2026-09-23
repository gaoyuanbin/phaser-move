import { useEffect, useRef, useState, useCallback } from 'react';
import Phaser from 'phaser';
import * as Colyseus from 'colyseus.js';
import styles from './buttons.module.css';
const COLYSEUS_URL = import.meta.env.VITE_COLYSEUS_URL || 'ws://localhost:2567';
const ARENAS_URL = import.meta.env.VITE_ARENAS_URL || COLYSEUS_URL.replace(/^ws/, 'http') + '/arenas';
const CHARACTERS_URL = import.meta.env.VITE_CHARACTERS_URL || COLYSEUS_URL.replace(/^ws/, 'http') + '/characters';

const OTHER_COLOR = 0xff4444;
const IT_COLOR = 0xffff00;
const DEFAULT_MOVE_SPEED = 3;
const DEFAULT_MAX_HP = 100;
const DEFAULT_MAX_ENERGY = 100;

const DASH_SPEED = 12;
const DASH_DURATION_MS = 150;
const DASH_END_LAG_MS = 250;

const HP_BAR_WIDTH = 50;
const HP_BAR_HEIGHT = 6;
const HP_BAR_OFFSET_Y = 35;

const ENERGY_BAR_WIDTH = 50;
const ENERGY_BAR_HEIGHT = 4;
const ENERGY_BAR_OFFSET_Y = HP_BAR_OFFSET_Y + HP_BAR_HEIGHT + 4;

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
    // Character stats/visuals (speed, hp/energy caps, and each one's own
    // attack/superAttack/dash movesets) come from the server's
    // data/characters/*.json, fetched once before this scene is created -
    // nothing character- or attack-specific is hardcoded in the client.
    this.characters = data.characters || {};
    this.myCharacter = data.character;
    this.attacks = this.characters[this.myCharacter]?.attacks || {};
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
    this.helpKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.H);
    this.buildHelpOverlay(width, height);
    this.otherPlayers = {};
    this.player = this.add.rectangle(width / 2, height / 2, 50, 50, this.characterColor(this.myCharacter));
    this.player.setStrokeStyle(3, 0xffffff, 0.9);
    this.pointer = this.add.triangle(width / 2, height / 2, 10, 0, 20, 20, 0, 20, 0xff0000);

    this.statusText = this.add.text(10, 10, 'Connecting...', { fontSize: '14px', color: '#ffff00' });

    this.facing = 'right';
    this.pointer.rotation = this.facingAngle();
    this.pointer.x = this.player.x + this.facingVector().x * POINTER_OFFSET;
    this.pointer.y = this.player.y + this.facingVector().y * POINTER_OFFSET;
    const myCharacterData = this.characters[this.myCharacter];
    this.maxHp = myCharacterData?.maxHp ?? DEFAULT_MAX_HP;
    this.maxEnergy = myCharacterData?.maxEnergy ?? DEFAULT_MAX_ENERGY;
    this.moveSpeed = myCharacterData?.speed ?? DEFAULT_MOVE_SPEED;
    this.nextAttackTime = 0;
    this.dashEndTime = 0;
    this.actionLockEndTime = 0;
    this.dashDirection = 1;
    this.itSessionId = null;
    this.activeEffects = [];

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
    this.showAttackEffect(attackId, this.player, this.facing);
  }

  // `target` is a live game object (this.player, or a remote player's rect) -
  // the swing box re-reads its x/y every frame in update() so it keeps
  // following the attacker instead of staying pinned to where they were
  // standing when the attack fired. `attacksSource` defaults to our own
  // moveset, but callers showing another player's attack pass that
  // player's own character's attacks, since movesets differ per character.
  showAttackEffect(attackId, target, direction, attacksSource = this.attacks) {
    const attack = attacksSource[attackId];
    if (!attack) return;
    const fx = attack.effect;
    const offset = direction === 'left' ? -fx.offsetFromPlayer : fx.offsetFromPlayer;
    const swing = this.add.rectangle(target.x + offset, target.y, fx.width, fx.height, Number(fx.color), fx.alpha);
    this.activeEffects.push({ swing, target, offset });
    this.tweens.add({
      targets: swing,
      alpha: 0,
      duration: fx.durationMs,
      onComplete: () => {
        this.activeEffects = this.activeEffects.filter((e) => e.swing !== swing);
        swing.destroy();
      },
    });
  }

  roomTip() {
    switch (this.roomKind) {
      case 'arena': return 'Reduce another player\'s HP to zero to respawn them. Attacking costs energy, which regenerates over time.';
      case 'tag': return 'The yellow player is "it" - touch another player to pass it on to them. Just-tagged players are briefly immune.';
      default: return 'A shared hub with no combat. Walk into the glowing door to head to the Arena browser.';
    }
  }

  buildHelpOverlay(width, height) {
    this.helpVisible = false;
    this.helpHint = this.add.text(width - 10, 10, 'H - Help', { fontSize: '12px', color: '#aaaaaa' })
      .setOrigin(1, 0)
      .setDepth(100);

    const lines = [
      'CONTROLS',
      'Move:         WASD or Arrow Keys',
      'Attack:       E  or  /',
      'Super Attack: R  or  .',
      'Dash:         Space, Q, or Shift (deals damage in Arenas)',
      '',
      this.roomTip(),
      '',
      'Press H to close',
    ];

    const panelWidth = 460;
    const panelHeight = 240;
    this.helpPanel = this.add.container(width / 2, height / 2).setDepth(101).setVisible(false);
    const bg = this.add.rectangle(0, 0, panelWidth, panelHeight, 0x000000, 0.8).setStrokeStyle(2, 0xffffff, 0.5);
    const text = this.add.text(0, 0, lines.join('\n'), {
      fontSize: '15px',
      color: '#ffffff',
      align: 'left',
      lineSpacing: 6,
      wordWrap: { width: panelWidth - 40 },
    }).setOrigin(0.5);
    this.helpPanel.add([bg, text]);
  }

  toggleHelp() {
    this.helpVisible = !this.helpVisible;
    this.helpPanel.setVisible(this.helpVisible);
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
    this.curenergy.setDisplaySize(ENERGY_BAR_WIDTH * (energy / this.maxEnergy), ENERGY_BAR_HEIGHT);
  }

  characterColor(characterId) {
    const color = this.characters[characterId]?.color;
    return color !== undefined ? Number(color) : OTHER_COLOR;
  }

  colorForPlayer(sessionId) {
    if (sessionId === this.itSessionId) return IT_COLOR;
    if (sessionId === this.room?.sessionId) return this.characterColor(this.myCharacter);
    return this.characterColor(this.otherPlayers[sessionId]?.character);
  }

  updateItColors() {
    this.player.fillColor = this.colorForPlayer(this.room?.sessionId);
    for (const [sessionId, other] of Object.entries(this.otherPlayers)) {
      other.rect.fillColor = this.colorForPlayer(sessionId);
    }
  }

  createOtherPlayer(sessionId, x, y, character) {
    const other = { character };
    this.otherPlayers[sessionId] = other;
    const rect = this.add.rectangle(x, y, 50, 50, this.colorForPlayer(sessionId));
    const hpBg = this.add.rectangle(x, y + HP_BAR_OFFSET_Y, HP_BAR_WIDTH, HP_BAR_HEIGHT, 0x222222);
    const hpFill = this.add.rectangle(x, y + HP_BAR_OFFSET_Y, HP_BAR_WIDTH, HP_BAR_HEIGHT, 0x22ff22);
    Object.assign(other, { rect, hpBg, hpFill });
    return other;
  }

  // playerMoved's fallback creates an other-player before we know its character
  // (undefined, so it renders in OTHER_COLOR). This lets a later 'playerJoined'/
  // 'playerSaidHi' - which do carry the character - fill that in retroactively.
  setOtherPlayerCharacter(sessionId, character) {
    const other = this.otherPlayers[sessionId];
    if (!other || other.character === character) return;
    other.character = character;
    other.rect.fillColor = this.colorForPlayer(sessionId);
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
    const maxHp = this.characters[other.character]?.maxHp ?? DEFAULT_MAX_HP;
    other.hpFill.setDisplaySize(HP_BAR_WIDTH * (hp / maxHp), HP_BAR_HEIGHT);
    other.hpFill.x = other.rect.x - (HP_BAR_WIDTH - other.hpFill.displayWidth) / 2;
  }

  setupRoom(room) {
    this.room = room;
    this.statusText.setText('Connected');
    this.room.onMessage("imroom", (data) => {
      this.roomKind = data.roomtype;
    })
    this.room.onMessage('playerJoined', ({ sessionId, character }) => {
      if (sessionId === this.room.sessionId) return;
      if (!this.otherPlayers[sessionId]) {
        this.createOtherPlayer(sessionId, this.scale.width / 2, this.scale.height / 2, character);
        this.room.send('sayHi', { x: this.player.x, y: this.player.y });
      } else {
        this.setOtherPlayerCharacter(sessionId, character);
      }
      console.log('players:', [this.room.sessionId, ...Object.keys(this.otherPlayers)]);
    });

    this.room.onMessage('playerSaidHi', ({ sessionId, x, y, character }) => {
      if (sessionId === this.room.sessionId) return;
      if (!this.otherPlayers[sessionId]) {
        this.createOtherPlayer(sessionId, x, y, character);
      } else {
        this.positionOtherPlayer(this.otherPlayers[sessionId], x, y);
        this.setOtherPlayerCharacter(sessionId, character);
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
      if (other) {
        const theirAttacks = this.characters[other.character]?.attacks || {};
        this.showAttackEffect(attackId, other.rect, direction, theirAttacks);
      }
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
    if (Phaser.Input.Keyboard.JustDown(this.helpKey)) {
      this.toggleHelp();
    }

    for (const { swing, target, offset } of this.activeEffects) {
      swing.x = target.x + offset;
      swing.y = target.y;
    }

    let moved = false;
    const dashing = time < this.dashEndTime;
    const locked = time < this.actionLockEndTime;

    if (dashing) {
      this.player.x += DASH_SPEED * this.dashDirection;
      moved = true;
    } else if (!locked) {
      if (this.cursors.left.isDown || this.wasd.left.isDown) { this.player.x -= this.moveSpeed; moved = true; this.facing = 'left'; }
      if (this.cursors.right.isDown || this.wasd.right.isDown) { this.player.x += this.moveSpeed; moved = true; this.facing = 'right'; }
      if (this.cursors.up.isDown || this.wasd.up.isDown) { this.player.y -= this.moveSpeed; moved = true; this.facing = "up"}
      if (this.cursors.down.isDown || this.wasd.down.isDown) { this.player.y += this.moveSpeed; moved = true; this.facing = "down"}
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
      // Dashing through an opponent only deals damage in arenas - ArenaRoom is the
      // only room that registers an "attack" handler, so this is a no-op elsewhere.
      if (this.room && this.roomKind === 'arena') {
        this.room.send('attack', { attackId: 'dash', direction: this.facing });
        // The trail above is centered on the player; also show the actual
        // front-offset hitbox from dash.json, same as tryAttack() does for
        // the other attacks, so the dasher can see the region that can hit.
        this.showAttackEffect('dash', this.player, this.facing);
      }
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
  const [character, setCharacter] = useState(null);
  const [arenas, setArenas] = useState([]);
  const [characters, setCharacters] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Character stats/visuals (speed, hp/energy caps, attacks) are data-driven
  // (colyseus-server/data/characters/*.json), fetched once on load rather
  // than hardcoded in this component. Defaults the selection to whichever
  // character comes back first.
  useEffect(() => {
    let ignore = false;
    fetch(CHARACTERS_URL)
      .then((res) => res.json())
      .then((data) => {
        if (ignore) return;
        setCharacters(data);
        setCharacter((current) => current ?? Object.keys(data)[0]);
      })
      .catch((e) => console.error('Failed to load character data:', e));
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
      setRoom(await client.joinOrCreate('hello_room', { character }));
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
      setRoom(await client.create('arena_room', { character }));
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
      setRoom(await client.joinOrCreate('tag_room', { character }));
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
      setRoom(await client.joinById(roomId, { character }));
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
      const newRoom = await client.joinOrCreate('hello_room', { character });
      setRoomKind('main');
      setRoom(newRoom);
    } catch (e) {
      console.error('Failed to return to main lobby:', e);
    }
  }, [roomKind, client, character]);

  // Mount the Phaser game once a room has been picked/created and character data has loaded.
  useEffect(() => {
    if (!room || !characters) return;

    gameRef.current = new Phaser.Game({
      type: Phaser.AUTO,
      width: 1000,
      height: 600,
      backgroundColor: '#1a1a2e',
      parent: containerRef.current,
    });
    gameRef.current.scene.add('HelloWorldScene', HelloWorldScene, true, { room, roomKind, onDoor: handleDoor, characters, character });

    setTimeout(() => {
      const canvas = containerRef.current?.querySelector('canvas');
      if (canvas) { canvas.tabIndex = 1; canvas.focus(); }
    }, 500);

    return () => {
      room.leave();
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, [room, roomKind, characters, handleDoor, character]);

  if (!room) {
    return (
      <div style={{ color: '#fff', fontFamily: 'sans-serif', padding: 20, maxWidth: 480 }}>
        <div style={{ background: '#22222e', border: '1px solid #444', borderRadius: 8, padding: 16 }}>
          <h2 style={{ marginTop: 0 }}>How to Play</h2>
          <p style={{ opacity: 0.85, fontSize: 14, margin: '4px 0' }}><strong>Move:</strong> WASD or Arrow Keys</p>
          <p style={{ opacity: 0.85, fontSize: 14, margin: '4px 0' }}><strong>Attack:</strong> E or /  &nbsp; <strong>Super Attack:</strong> R or .</p>
          <p style={{ opacity: 0.85, fontSize: 14, margin: '4px 0' }}><strong>Dash:</strong> Space, Q, or Shift &nbsp; (deals damage if it hits someone in an Arena)</p>
          <p style={{ opacity: 0.85, fontSize: 14, margin: '4px 0' }}>Walk into the glowing door in a room to move between the main lobby and the arena browser.</p>
          <p style={{ opacity: 0.7, fontSize: 13, margin: '8px 0 0' }}>Once you're in a game, press <strong>H</strong> anytime for an in-game reminder of the controls.</p>
        </div>

        <h2 style={{ marginTop: 24 }}>Character</h2>
        <div style={{ display: 'flex', gap: 10 }}>
          {characters && Object.values(characters).map((c) => (
            <button
              key={c.id}
              onClick={() => setCharacter(c.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                background: character === c.id ? '#3a3a4e' : '#22222e',
                border: character === c.id ? '2px solid #fff' : '2px solid #444',
                color: '#fff',
              }}
            >
              <span style={{
                width: 14, height: 14, borderRadius: '50%', display: 'inline-block',
                background: `#${Number(c.color).toString(16).padStart(6, '0')}`,
              }} />
              {c.name}
            </button>
          ))}
        </div>

        <h2 style={{ marginTop: 24 }}>Main Lobby</h2>
        <p style={{ opacity: 0.7, fontSize: 14 }}>One shared room. Attacking is disabled here.</p>
        <button className = {styles.menu} disabled={busy || !characters} onClick={joinMainLobby}>{busy ? 'Connecting…' : 'Join Main Lobby'}</button>

        <h2 style={{ marginTop: 32 }}>Tag</h2>
        <p style={{ opacity: 0.7, fontSize: 14 }}>One shared room. Whoever's "it" (yellow) tags the next by touch.</p>
        <button className={styles.menu} disabled={busy || !characters} onClick={joinTagGame}>{busy ? 'Connecting…' : 'Join Tag Game'}</button>

        <h2 style={{ marginTop: 32 }}>Arenas</h2>
        <p style={{ opacity: 0.7, fontSize: 14 }}>Small rooms, up to 8 players, attacking enabled. Anyone can create one.</p>
        <button className={styles.menu} disabled={busy || !characters} onClick={createArena}>{busy ? 'Connecting…' : 'Create New Arena'}</button>
        <button className={styles.menu} disabled={busy || !characters} onClick={refreshArenas} style={{ marginLeft: 8 }}>Refresh</button>
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

        {!characters && <p style={{ opacity: 0.7, fontSize: 13, marginTop: 8 }}>Loading character data…</p>}
        {error && <p style={{ color: 'salmon' }}>{error}</p>}
      </div>
    );
  }

  return <div ref={containerRef} />;
}

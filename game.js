'use strict';

// ============================================================
// CANVAS — PLEIN ÉCRAN DYNAMIQUE
// ============================================================
const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');

// Résolution interne fixe (logique du jeu)
const VW = 960, VH = 540;
canvas.width  = VW;
canvas.height = VH;

// Alias globaux utilisés dans tout le code
let W = VW, H = VH;

function resizeCanvas() {
  const sx = window.innerWidth  / VW;
  const sy = window.innerHeight / VH;
  const s  = Math.min(sx, sy);
  canvas.style.width  = Math.round(VW * s) + 'px';
  canvas.style.height = Math.round(VH * s) + 'px';
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ============================================================
// PHYSICS CONSTANTS — moteur pro
// ============================================================
const GRAVITY       = 0.55;   // gravité de base
const GRAVITY_FALL  = 1.05;   // plus lourde en descente → chute nette
const GRAVITY_RISE  = 0.38;   // plus légère en montée (bouton maintenu)
const GRAVITY_CUT   = 0.70;   // si on lâche saut tôt → coupe la montée
const MAX_FALL      = 20;
const PLAYER_SPMAX  = 6.5;
const PLAYER_ACCEL  = 2.2;    // accél sol
const PLAYER_ACCEL_AIR = 1.0; // accél air (moins de contrôle)
const GROUND_FRIC   = 0.76;   // friction sol (arrêt net)
const AIR_FRIC      = 0.94;   // friction air
const JUMP_FORCE    = -15;
const COYOTE_T      = 8;      // frames de grâce après avoir quitté un bord
const JUMP_BUFFER   = 8;      // frames de buffer avant l'atterrissage

// ============================================================
// GLOBAL STATE
// ============================================================
let gameState      = 'menu';   // menu | playing | quiz | gameover | win
let currentLevel   = 0;
let score          = 0;
let lives          = 3;
let highScore      = 0;
let frameCount     = 0;
let camera         = { x: 0, shake: 0 };
let particles      = [];
let notifications  = [];

// Quiz state
let quizSelected   = -1;
let quizRevealed   = false;
let quizTimer      = 0;

// Level objects
let lPlatforms     = [];
let lEnemies       = [];
let lCollectibles  = [];
let lPowerUps      = [];
let lEndZone       = null;
let levelData      = null;
let player         = null;

// ============================================================
// INPUT
// ============================================================
const keys = {};
document.addEventListener('keydown', e => {
  const prev = keys[e.code];
  keys[e.code] = { held: true, just: !prev || !prev.held };
  if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
});
document.addEventListener('keyup', e => { keys[e.code] = { held: false, just: false }; });

// ── Touch / mobile controls ──
(function initTouch() {
  const zones = {
    left:  { held: false, code: 'ArrowLeft'  },
    right: { held: false, code: 'ArrowRight' },
    jump:  { held: false, code: 'Space'      },
  };
  function codeFromTouch(t) {
    // Left 30% = left, Right 30% = right, Middle/top = jump
    const rx = t.clientX / window.innerWidth;
    if (rx < 0.30) return 'left';
    if (rx > 0.70) return 'right';
    return 'jump';
  }
  function press(zone) {
    if (!zones[zone].held) {
      zones[zone].held = true;
      const c = zones[zone].code;
      keys[c] = { held: true, just: true };
    }
  }
  function release(zone) {
    zones[zone].held = false;
    keys[zones[zone].code] = { held: false, just: false };
  }
  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    for (const t of e.changedTouches) press(codeFromTouch(t));
  }, { passive: false });
  canvas.addEventListener('touchend', e => {
    e.preventDefault();
    for (const t of e.changedTouches) release(codeFromTouch(t));
  }, { passive: false });
  canvas.addEventListener('touchmove', e => { e.preventDefault(); }, { passive: false });
})();

function held(c)  { return !!(keys[c] && keys[c].held); }
function just(c)  {
  if (keys[c] && keys[c].just) { keys[c].just = false; return true; }
  return false;
}

// ============================================================
// UTILITIES
// ============================================================
function lerp(a, b, t)       { return a + (b - a) * t; }
function clamp(v, lo, hi)    { return Math.max(lo, Math.min(hi, v)); }
function rand(lo, hi)        { return lo + Math.random() * (hi - lo); }
function overlap(a, b)       {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function rRect(x, y, w, h, r, fill, stroke, lw) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
  if (fill)   { ctx.fillStyle   = fill;   ctx.fill();   }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 2; ctx.stroke(); }
}

// ============================================================
// PARTICLE SYSTEM
// ============================================================
class Particle {
  constructor(x, y, vx, vy, col, life, size) {
    Object.assign(this, { x, y, vx, vy, col, life, maxLife: life, size });
  }
  update() {
    this.x  += this.vx;
    this.y  += this.vy;
    this.vy += 0.25;
    this.vx *= 0.97;
    this.life--;
  }
  draw() {
    const a = this.life / this.maxLife;
    ctx.globalAlpha = a;
    ctx.fillStyle   = this.col;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size * a, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  get alive() { return this.life > 0; }
}

function burst(x, y, col, n = 8, baseSpeed = 4) {
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i / n) + rand(-0.4, 0.4);
    const s = rand(baseSpeed * 0.5, baseSpeed);
    particles.push(new Particle(x, y, Math.cos(a)*s, Math.sin(a)*s - 1, col, rand(22, 40), rand(3, 7)));
  }
}

// ============================================================
// NOTIFICATION SYSTEM
// ============================================================
function notify(text, col) {
  notifications.push({ text, col, y: H - 90, ty: H - 140, alpha: 1, t: 110 });
}
function updateNotifications() {
  for (const n of notifications) {
    n.y = lerp(n.y, n.ty, 0.12);
    n.t--;
    if (n.t < 28) n.alpha = n.t / 28;
  }
  notifications = notifications.filter(n => n.t > 0);
}
function drawNotifications() {
  ctx.textAlign = 'center';
  for (const n of notifications) {
    ctx.globalAlpha = n.alpha;
    ctx.font = 'bold 20px Arial';
    ctx.fillStyle = '#000';
    ctx.fillText(n.text, W/2 + 2, n.y + 2);
    ctx.fillStyle = n.col;
    ctx.fillText(n.text, W/2, n.y);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}

// ============================================================
// POWER-UP DEFINITIONS
// ============================================================
const PU = {
  speed:      { col: '#FFD700', icon: '⚡', dur: 300, label: 'Turbo Sucré!'      },
  doubleJump: { col: '#00CFFF', icon: '👟', dur: 380, label: 'Double Saut!'      },
  shield:     { col: '#AADDFF', icon: '🛡', dur: 420, label: 'Bouclier Crème!'  },
  ultra:      { col: '#FF6600', icon: '⭐', dur: 220, label: 'MODE ULTRA SUCRE!' },
  superJump:  { col: '#88FF44', icon: '🚀', dur: 200, label: 'Super Propulsion!' },
  dash:       { col: '#FF44CC', icon: '💨', dur: 300, label: 'Turbo Dash!'       },
};

// ============================================================
// CANDY TWIST DRAWING HELPERS
// ============================================================
function _drawCandyTwist(cx, cy, w, h, pointUp) {
  const dir = pointUp ? -1 : 1;
  const tg  = ctx.createLinearGradient(cx - w/2, cy, cx + w/2, cy + dir*h);
  tg.addColorStop(0, '#FF5533'); tg.addColorStop(0.45, '#EE2200'); tg.addColorStop(1, '#CC1100');
  ctx.fillStyle = tg;
  ctx.beginPath();
  ctx.moveTo(cx - w/2, cy);
  ctx.bezierCurveTo(cx - w*0.35, cy + dir*h*0.4,  cx - w*0.14, cy + dir*h*0.85, cx, cy + dir*h);
  ctx.bezierCurveTo(cx + w*0.14, cy + dir*h*0.85, cx + w*0.35, cy + dir*h*0.4,  cx + w/2, cy);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(255,200,180,0.55)'; ctx.lineWidth = 0.8;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + s*w*0.18, cy);
    ctx.bezierCurveTo(cx + s*w*0.12, cy + dir*h*0.4, cx + s*w*0.04, cy + dir*h*0.75, cx, cy + dir*h*0.92);
    ctx.stroke();
  }
  ctx.strokeStyle = '#AA1100'; ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(cx - w/2, cy);
  ctx.bezierCurveTo(cx - w*0.35, cy + dir*h*0.4,  cx - w*0.14, cy + dir*h*0.85, cx, cy + dir*h);
  ctx.bezierCurveTo(cx + w*0.14, cy + dir*h*0.85, cx + w*0.35, cy + dir*h*0.4,  cx + w/2, cy);
  ctx.closePath(); ctx.stroke();
}

function _drawHorizTwist(cx, cy, w, h, isLeft) {
  const d = isLeft ? -1 : 1;
  const hg = ctx.createLinearGradient(cx, cy - h/2, cx, cy + h/2);
  hg.addColorStop(0, '#FF5533'); hg.addColorStop(0.5, '#EE2200'); hg.addColorStop(1, '#FF5533');
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.moveTo(cx, cy - h/2 * 0.65);
  ctx.bezierCurveTo(cx + d*w*0.35, cy - h/2,       cx + d*w,       cy - h/2*0.35, cx + d*w, cy);
  ctx.bezierCurveTo(cx + d*w,       cy + h/2*0.35, cx + d*w*0.35, cy + h/2,       cx, cy + h/2*0.65);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(255,200,180,0.5)'; ctx.lineWidth = 0.7;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + s*h*0.22);
    ctx.bezierCurveTo(cx + d*w*0.4, cy + s*h*0.35, cx + d*w*0.8, cy + s*h*0.22, cx + d*w*0.95, cy);
    ctx.stroke();
  }
  ctx.strokeStyle = '#AA1100'; ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(cx, cy - h/2 * 0.65);
  ctx.bezierCurveTo(cx + d*w*0.35, cy - h/2,       cx + d*w,       cy - h/2*0.35, cx + d*w, cy);
  ctx.bezierCurveTo(cx + d*w,       cy + h/2*0.35, cx + d*w*0.35, cy + h/2,       cx, cy + h/2*0.65);
  ctx.closePath(); ctx.stroke();
}

// ============================================================
// PLAYER
// ============================================================
class Player {
  constructor(x, y) {
    this.x = x;  this.y = y;
    this.w = 32; this.h = 40;
    this.vx = 0; this.vy = 0;
    this.onGround    = false;
    this.wasOnGround = false;
    this.facing      = 1;
    this.jumps       = 0;
    this.maxJumps    = 1;        // single jump by default; doubleJump pickup enables 2nd
    this.hp          = 3;
    this.iframes     = 0;
    this.dead        = false;
    this.walkPhase   = 0;
    this.coyoteT     = 0;
    this.jumpBuffer  = 0;
    this.jumpHeld    = false;
    this.sqX = 1; this.sqY = 1;
    this.wallDir     = 0;        // -1 left wall, +1 right wall (set by _resolveX)
    this.wallSlide   = false;
    this.dashT       = 0;        // frames left in current dash
    this.dashCooldown= 0;
    this.pu = { speed: 0, doubleJump: 0, shield: 0, ultra: 0, superJump: 0, dash: 0 };
  }

  get speedMult()     { return 1 + (this.pu.speed > 0 ? 0.65 : 0) + (this.pu.ultra > 0 ? 0.9 : 0); }
  get jumpMult()      { return 1 + (this.pu.superJump > 0 ? 0.45 : 0) + (this.pu.ultra > 0 ? 0.2 : 0); }
  get canDoubleJump() { return this.pu.doubleJump > 0 || this.pu.ultra > 0; }

  update() {
    for (const k in this.pu) if (this.pu[k] > 0) this.pu[k]--;
    if (this.iframes > 0) this.iframes--;
    if (this.coyoteT  > 0) this.coyoteT--;
    if (this.jumpBuffer > 0) this.jumpBuffer--;
    // Squash & stretch — interpolate back to neutral every frame
    this.sqX += (1 - this.sqX) * 0.22;
    this.sqY += (1 - this.sqY) * 0.22;

    // ── Effective max jumps from power-ups ──
    this.maxJumps = 1 + (this.canDoubleJump ? 1 : 0);

    const spd = PLAYER_SPMAX * this.speedMult;

    // ── Dash countdown ──
    if (this.dashCooldown > 0) this.dashCooldown--;
    if (this.dashT > 0) {
      this.dashT--;
      this.vx = this.facing * 18 * (this.dashT / 12);
    } else {
      // ── Horizontal movement ──
      const accel = this.onGround ? PLAYER_ACCEL : PLAYER_ACCEL_AIR;
      const fric  = this.onGround ? GROUND_FRIC  : AIR_FRIC;
      if (held('ArrowLeft') || held('KeyA')) {
        this.vx = Math.max(this.vx - accel, -spd);
        this.facing = -1;
      } else if (held('ArrowRight') || held('KeyD')) {
        this.vx = Math.min(this.vx + accel,  spd);
        this.facing = 1;
      } else {
        this.vx *= fric;
        if (Math.abs(this.vx) < 0.12) this.vx = 0;
      }
      // Dash trigger (Shift)
      if ((just('ShiftLeft') || just('ShiftRight')) && this.dashCooldown === 0 && this.pu.dash > 0) {
        this.dashT = 12; this.dashCooldown = 55;
        this.sqX = 0.52; this.sqY = 1.55;
        burst(this.x + this.w/2, this.y + this.h/2, '#FF44CC', 12, 7);
      }
    }

    // Walk animation + run dust
    if (Math.abs(this.vx) > 0.4 && this.onGround) {
      this.walkPhase += 0.24 * Math.abs(this.vx) / spd;
      if (Math.abs(this.vx) > spd * 0.78 && frameCount % 6 === 0)
        burst(this.x + this.w/2, this.y + this.h, '#C8860A', 2, 1.5);
    } else if (this.onGround) {
      this.walkPhase = 0;
    }

    // ── Jump buffer ──
    const jumpPressed = just('Space') || just('ArrowUp') || just('KeyW');
    if (jumpPressed) this.jumpBuffer = JUMP_BUFFER;
    this.jumpHeld = held('Space') || held('ArrowUp') || held('KeyW');

    // ── Wall slide detection ──
    this.wallSlide = !this.onGround && this.wallDir !== 0 && this.vy > 0 &&
      ((this.wallDir ===  1 && (held('ArrowRight') || held('KeyD'))) ||
       (this.wallDir === -1 && (held('ArrowLeft')  || held('KeyA'))));
    if (this.wallSlide && frameCount % 7 === 0)
      burst(this.x + (this.wallDir > 0 ? this.w : 0), this.y + this.h * 0.6, '#FFD700', 3, 2);

    // ── Execute jump ──
    if (this.jumpBuffer > 0) {
      if (this.wallSlide) {
        // Wall jump — bounces away from the wall
        this.vy = JUMP_FORCE * 0.9;
        this.vx = -this.wallDir * spd * 1.15;
        this.facing = -this.wallDir;
        this.jumps = 1; this.jumpBuffer = 0;
        this.sqX = 0.72; this.sqY = 1.32;
        burst(this.x + this.w/2, this.y + this.h/2, '#FFD700', 10, 5);
      } else if (this.onGround || this.coyoteT > 0) {
        this.vy = JUMP_FORCE * this.jumpMult;
        this.jumps = 1; this.jumpBuffer = 0; this.coyoteT = 0;
        this.sqX = 0.70; this.sqY = 1.38;
        burst(this.x + this.w/2, this.y + this.h, '#C8860A', 6, 3);
      } else if (this.jumps < this.maxJumps) {
        this.vy = JUMP_FORCE * this.jumpMult * 0.88;
        this.jumps++; this.jumpBuffer = 0;
        this.sqX = 0.72; this.sqY = 1.32;
        burst(this.x + this.w/2, this.y + this.h/2, '#00CFFF', 14, 5);
        burst(this.x + this.w/2, this.y + this.h/2, '#FFFFFF', 6, 3);
      }
    }

    // ── Asymmetric gravity ──
    if (this.wallSlide && this.vy > 0) {
      this.vy = Math.min(this.vy + 0.12, 2.4);   // wall slide: slow fall
    } else if (this.vy < 0) {
      const g = this.jumpHeld ? GRAVITY_RISE : GRAVITY_RISE + GRAVITY_CUT;
      this.vy += g;
    } else {
      this.vy += GRAVITY_FALL;
    }
    this.vy = Math.min(this.vy, MAX_FALL);

    this.wasOnGround = this.onGround;
    this.wallDir = 0;
    this.x += this.vx;
    this._resolveX();
    this.y += this.vy;
    this.onGround = false;
    this._resolveY();

    // Coyote time
    if (this.wasOnGround && !this.onGround && this.vy >= 0) this.coyoteT = COYOTE_T;

    // Left boundary
    if (this.x < 0) { this.x = 0; this.vx = 0; }

    // Fall death
    if (this.y > levelData.height + 80) this.die();

    // Collectibles
    for (const c of lCollectibles) {
      if (c.collected) continue;
      if (overlap({ x: this.x, y: this.y, w: this.w, h: this.h },
                  { x: c.x - c.r, y: c.y - c.r, w: c.r*2, h: c.r*2 })) {
        c.collected = true;
        score += 10;
        burst(c.x, c.y, '#8B4513', 6, 3);
      }
    }

    // Power-ups
    for (const p of lPowerUps) {
      if (p.collected) continue;
      if (overlap({ x: this.x, y: this.y, w: this.w, h: this.h },
                  { x: p.x, y: p.y, w: p.w, h: p.h })) {
        p.collected = true;
        this.pu[p.type] = PU[p.type].dur;
        burst(p.x + p.w/2, p.y + p.h/2, PU[p.type].col, 12, 5);
        notify(PU[p.type].label, PU[p.type].col);
      }
    }

    // Enemy collisions
    for (const e of lEnemies) {
      if (e.dead) continue;
      if (!overlap({ x: this.x, y: this.y, w: this.w, h: this.h },
                   { x: e.x, y: e.y, w: e.w, h: e.h })) continue;

      // Stomp if falling onto top half of enemy
      if (this.vy > 1 && this.y + this.h < e.y + e.h * 0.6) {
        e.kill();
        this.vy = -9;
        score += 50;
        burst(e.x + e.w/2, e.y, '#5C3317', 12, 5);
      } else if (this.iframes === 0) {
        if (this.pu.shield > 0) {
          this.pu.shield = 0;
          this.iframes = 60;
          burst(this.x + this.w/2, this.y + this.h/2, '#FFF', 14, 4);
          notify('Bouclier brisé!', '#AAE');
        } else {
          this.takeDamage();
        }
      }
    }
  }

  _resolveX() {
    for (const p of lPlatforms) {
      if (!overlap({ x: this.x, y: this.y + 3, w: this.w, h: this.h - 6 },
                   { x: p.x, y: p.y, w: p.w, h: p.h })) continue;
      if (this.vx > 0) { this.x = p.x - this.w; this.wallDir =  1; }
      else              { this.x = p.x + p.w;    this.wallDir = -1; }
      this.vx = 0;
    }
  }

  _resolveY() {
    for (const p of lPlatforms) {
      if (!overlap({ x: this.x + 2, y: this.y, w: this.w - 4, h: this.h },
                   { x: p.x, y: p.y, w: p.w, h: p.h })) continue;
      if (this.vy >= 0) {
        this.y        = p.y - this.h;
        if (this.vy > 4) { this.sqX = 1.42; this.sqY = 0.60; camera.shake = Math.min(camera.shake + this.vy * 0.45, 10); }
        this.vy       = 0;
        this.onGround = true;
        this.jumps    = 0;
        this.coyoteT  = 0;
      } else {
        this.y  = p.y + p.h;
        this.vy = 1;
      }
    }
  }

  takeDamage() {
    this.hp--;
    this.iframes = 90;
    camera.shake = 9;
    if (this.hp <= 0) { this.die(); return; }
    this.vy = -8;
    this.vx = this.facing * -5;
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    burst(this.x + this.w/2, this.y + this.h/2, '#E8001C', 20, 6);
    lives--;
    setTimeout(() => {
      if (lives <= 0) gameState = 'gameover';
      else            loadLevel(currentLevel);
    }, 900);
  }

  draw() {
    if (this.dead) return;
    if (this.iframes > 0 && Math.floor(frameCount / 5) % 2 === 0) return;

    const cx      = this.x + this.w / 2;
    const cy      = this.y + this.h / 2;
    const ultra   = this.pu.ultra > 0;
    const isWalk  = this.onGround && Math.abs(this.vx) > 0.5;
    const lp      = this.walkPhase * Math.PI * 2;

    const bob  = this.wallSlide ? 0 : (isWalk ? Math.sin(lp) * 1.5 : 0);
    const tilt = this.wallSlide ? this.wallDir * 0.3 : (isWalk ? Math.sin(lp) * 0.07 : 0);

    ctx.save();
    ctx.translate(cx, cy + bob);
    ctx.rotate(tilt);
    ctx.scale(this.sqX, this.sqY);

    const bw = 26, bh = 34;

    // Shield bubble
    if (this.pu.shield > 0) {
      const sa = 0.28 + 0.14 * Math.sin(frameCount * 0.15);
      const sg = ctx.createRadialGradient(0, 0, 10, 0, 0, 32);
      sg.addColorStop(0, `rgba(173,216,230,${sa})`);
      sg.addColorStop(1, 'rgba(173,216,230,0)');
      ctx.fillStyle = sg;
      ctx.beginPath(); ctx.ellipse(0, 0, 32, 37, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(135,206,235,${sa + 0.2})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(0, 0, 30, 35, 0, 0, Math.PI * 2); ctx.stroke();
    }

    // Feet (red candy-twist blobs)
    const l1 = isWalk ? Math.sin(lp) * 6 : 0;
    const l2 = isWalk ? -Math.sin(lp) * 6 : 0;
    ctx.save(); ctx.translate(-7, bh/2 - 1); ctx.rotate(l1 * 0.09);
    _drawCandyTwist(0, 0, 9, 11, false); ctx.restore();
    ctx.save(); ctx.translate(7,  bh/2 - 1); ctx.rotate(l2 * 0.09);
    _drawCandyTwist(0, 0, 9, 11, false); ctx.restore();

    // Body shadow
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.ellipse(2.5, 3, bw/2, bh/2, 0, 0, Math.PI * 2); ctx.fill();

    // ── Body (oval, clipped interior) ──
    ctx.save();
    ctx.beginPath(); ctx.ellipse(0, 0, bw/2, bh/2, 0, 0, Math.PI * 2); ctx.clip();

    const bodyG = ctx.createLinearGradient(-bw/2, -bh/2, bw*0.3, bh/2);
    if (ultra) {
      bodyG.addColorStop(0, '#FFFCE0'); bodyG.addColorStop(0.5, '#FFE033'); bodyG.addColorStop(1, '#FF8C00');
    } else {
      bodyG.addColorStop(0, '#FFFFFF'); bodyG.addColorStop(0.45, '#F6F0E6');
      bodyG.addColorStop(0.8, '#EAE0CC'); bodyG.addColorStop(1, '#D2C4A0');
    }
    ctx.fillStyle = bodyG;
    ctx.fillRect(-bw/2, -bh/2, bw, bh);

    // Chocolate bottom section
    ctx.fillStyle = ultra ? '#8B4A00' : '#6B3200';
    ctx.fillRect(-bw/2, bh * 0.12, bw, bh);

    // Animated cream wave border
    ctx.fillStyle = ultra ? '#FFEBB0' : '#F2E6C8';
    ctx.beginPath();
    for (let i = 0; i <= 6; i++) {
      const wx  = -bw/2 + bw * i / 6;
      const osc = Math.sin(i * 1.3 + frameCount * 0.05) * 2.5;
      i === 0 ? ctx.moveTo(wx, bh * 0.12 + osc) : ctx.lineTo(wx, bh * 0.12 + osc);
    }
    ctx.lineTo(bw/2, bh * 0.24); ctx.lineTo(bw/2, bh/2);
    ctx.lineTo(-bw/2, bh/2); ctx.closePath(); ctx.fill();

    // Cream highlight drop
    ctx.fillStyle = 'rgba(255,250,240,0.65)';
    ctx.beginPath(); ctx.ellipse(3, bh * 0.28, 5, 3.5, 0.4, 0, Math.PI * 2); ctx.fill();

    // Blue kinder stripe
    ctx.fillStyle = ultra ? '#FF8800' : '#0099DD';
    ctx.fillRect(-bw/2, -bh * 0.26, bw, 9);

    ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 5.5px Arial';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('kinder', 0, -bh * 0.26 + 4.5);
    ctx.fillStyle = ultra ? '#FFEE88' : '#5C3317'; ctx.font = 'bold 4.5px Arial';
    ctx.fillText('Schoko-Bons', 0, -bh * 0.05);

    ctx.restore(); // end clip

    // Outline
    ctx.strokeStyle = ultra ? '#CC6600' : '#C0A870'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(0, 0, bw/2, bh/2, 0, 0, Math.PI * 2); ctx.stroke();

    // Face
    const ex = this.facing * 5;
    ctx.fillStyle = '#2A2A2A';
    ctx.beginPath(); ctx.arc(ex, -bh * 0.19, 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath(); ctx.arc(ex + 0.7, -bh * 0.19 - 0.9, 0.9, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, -bh * 0.09, 4.5, 0.25, Math.PI - 0.25); ctx.stroke();

    // Arms
    const armSwing = isWalk ? Math.sin(lp) * 20 : 0;
    ctx.strokeStyle = ultra ? '#CC6600' : '#CC1100'; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
    ctx.save(); ctx.translate(-bw/2+1, -3); ctx.rotate((-38+armSwing)*Math.PI/180);
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(-7,9); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.translate(bw/2-1,  -3); ctx.rotate((38-armSwing)*Math.PI/180);
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(7,9);  ctx.stroke(); ctx.restore();

    // Top candy twist (hair)
    ctx.save();
    ctx.translate(0, -bh/2);
    ctx.translate(0, isWalk ? Math.sin(lp) * 1.5 : 0);
    _drawCandyTwist(0, 0, 13, 13, true);
    ctx.restore();

    // Specular highlight
    const shG = ctx.createRadialGradient(-bw*0.22, -bh*0.28, 0, -bw*0.08, -bh*0.18, bw*0.38);
    shG.addColorStop(0, 'rgba(255,255,255,0.62)'); shG.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = shG;
    ctx.beginPath(); ctx.ellipse(-bw*0.08, -bh*0.18, bw*0.32, bh*0.18, -0.35, 0, Math.PI*2); ctx.fill();

    // ── Double jump wings ──
    if (this.pu.doubleJump > 0) {
      const wa = 0.55 + 0.35 * Math.sin(frameCount * 0.16);
      ctx.globalAlpha = wa;
      for (const side of [-1, 1]) {
        ctx.save(); ctx.scale(side, 1);
        const wg = ctx.createLinearGradient(bw/2, -6, bw/2+18, 4);
        wg.addColorStop(0, '#00CFFF'); wg.addColorStop(1, 'rgba(0,207,255,0)');
        ctx.fillStyle = wg;
        ctx.beginPath();
        ctx.moveTo(bw/2, 0);
        ctx.bezierCurveTo(bw/2+9, -12, bw/2+18, -6, bw/2+14, 5);
        ctx.bezierCurveTo(bw/2+11, 12, bw/2+5, 9, bw/2, 0);
        ctx.fill();
        // Wing shine
        ctx.strokeStyle = 'rgba(180,240,255,0.6)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(bw/2+2, -1);
        ctx.quadraticCurveTo(bw/2+10, -7, bw/2+14, -1); ctx.stroke();
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    // ── Wall-slide sparks ──
    if (this.wallSlide) {
      const wx = this.wallDir * (bw/2 + 3);
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#FFD700';
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(wx + (Math.random()-0.5)*3, (Math.random()-0.5)*bh*0.8, 1.5+Math.random(), 0, Math.PI*2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // ── Dash speed-lines ──
    if (this.dashT > 0) {
      ctx.globalAlpha = this.dashT / 12 * 0.55;
      ctx.strokeStyle = '#FF44CC'; ctx.lineWidth = 2; ctx.lineCap = 'round';
      for (let i = 0; i < 4; i++) {
        const ly = (i - 1.5) * 6;
        const lx = -this.facing * (18 + i * 4);
        ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx - this.facing * 12, ly); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // ── Ultra aura ──
    if (ultra) {
      const ac = ['#FF6600','#FFD700','#FF44FF','#00EEFF'];
      ctx.globalAlpha = 0.6 + 0.3 * Math.sin(frameCount * 0.18);
      for (let i = 0; i < 6; i++) {
        const a = frameCount * 0.07 + i * Math.PI / 3;
        ctx.fillStyle = ac[i % 4];
        ctx.beginPath(); ctx.arc(Math.cos(a)*28, Math.sin(a)*28, 4, 0, Math.PI*2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }
}

// ============================================================
// ENEMIES
// ============================================================
class ChocCreature {
  constructor(x, y, range = 140) {
    this.x = x; this.y = y; this.w = 34; this.h = 34;
    this.vx = 1.8; this.vy = 0;
    this.startX = x; this.range = range;
    this.dead = false;
  }
  kill() { this.dead = true; }
  update() {
    if (this.dead) return;
    this.x += this.vx;
    if (this.x > this.startX + this.range || this.x < this.startX) this.vx *= -1;
    this.vy = Math.min(this.vy + GRAVITY, MAX_FALL);
    this.y += this.vy;
    for (const p of lPlatforms) {
      if (overlap({ x: this.x+2, y: this.y, w: this.w-4, h: this.h },
                  { x: p.x, y: p.y, w: p.w, h: p.h }) && this.vy >= 0) {
        this.y = p.y - this.h; this.vy = 0;
      }
    }
  }
  draw() {
    if (this.dead) return;
    const cx = this.x + this.w/2, cy = this.y + this.h/2, r = 17;
    const dir = this.vx >= 0 ? 1 : -1;

    // Ground shadow
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath(); ctx.ellipse(cx+2, cy+r-2, r-3, 5, 0, 0, Math.PI*2); ctx.fill();

    // Molten chocolate body
    const bg = ctx.createRadialGradient(cx-r*0.3, cy-r*0.3, r*0.1, cx, cy, r);
    bg.addColorStop(0, '#A85020'); bg.addColorStop(0.35, '#7B3A0C');
    bg.addColorStop(0.75, '#5C2A06'); bg.addColorStop(1, '#3D1A04');
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.fill();

    // Melt drips at bottom
    ctx.fillStyle = '#4A1E04';
    for (let d=-1; d<=1; d++) {
      ctx.beginPath(); ctx.arc(cx + d*7, cy+r-2, 4.5, 0, Math.PI*2); ctx.fill();
    }
    // Crack lines
    ctx.strokeStyle = '#3D1A04'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(cx-6,cy-4); ctx.lineTo(cx-2,cy+2); ctx.lineTo(cx+4,cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx+5,cy-5); ctx.lineTo(cx+2,cy+3); ctx.stroke();

    // Evil glowing eye
    const eg = ctx.createRadialGradient(cx+dir*5,cy-6,0, cx+dir*5,cy-6,5);
    eg.addColorStop(0,'#FF6600'); eg.addColorStop(0.5,'#FF2200'); eg.addColorStop(1,'#AA0000');
    ctx.fillStyle = eg;
    ctx.beginPath(); ctx.arc(cx+dir*5, cy-6, 4.5, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#1A0000';
    ctx.beginPath(); ctx.arc(cx+dir*5+dir*0.8, cy-6, 2.2, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = 'rgba(255,150,100,0.6)';
    ctx.beginPath(); ctx.arc(cx+dir*4, cy-7.5, 1.2, 0, Math.PI*2); ctx.fill();

    // Jagged mouth
    ctx.strokeStyle = '#2A0A00'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx-6,cy+4); ctx.lineTo(cx-3,cy+7); ctx.lineTo(cx,cy+4);
    ctx.lineTo(cx+3,cy+7); ctx.lineTo(cx+6,cy+4); ctx.stroke();

    // Specular highlight
    const sh = ctx.createRadialGradient(cx-r*0.3,cy-r*0.4,0, cx-r*0.1,cy-r*0.2,r*0.55);
    sh.addColorStop(0,'rgba(255,200,150,0.35)'); sh.addColorStop(1,'rgba(255,200,150,0)');
    ctx.fillStyle = sh;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.fill();
  }
}

class Hazelnut {
  constructor(x, y) {
    this.x = x; this.y = y; this.w = 28; this.h = 30;
    this.vx = 0; this.vy = -9;
    this.timer = 0; this.dead = false;
  }
  kill() { this.dead = true; }
  update() {
    if (this.dead) return;
    this.timer++;
    this.vy = Math.min(this.vy + GRAVITY, MAX_FALL);
    this.y += this.vy;
    this.x += Math.sin(this.timer * 0.04) * 1.8;
    for (const p of lPlatforms) {
      if (overlap({ x: this.x+2, y: this.y, w: this.w-4, h: this.h },
                  { x: p.x, y: p.y, w: p.w, h: p.h }) && this.vy >= 0) {
        this.y = p.y - this.h; this.vy = -10;
      }
    }
  }
  draw() {
    if (this.dead) return;
    const cx = this.x + this.w/2, cy = this.y + this.h/2;
    const sq = this.vy > 4 ? 1.22 : (this.vy < -4 ? 0.82 : 1);
    ctx.save(); ctx.translate(cx, cy); ctx.scale(sq, 1/sq);

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath(); ctx.ellipse(1.5, 15, 9, 3.5, 0, 0, Math.PI*2); ctx.fill();

    // Main body with rich gradient
    const bg = ctx.createRadialGradient(-4, -4, 2, 0, 2, 16);
    bg.addColorStop(0, '#C09040'); bg.addColorStop(0.4, '#966A14');
    bg.addColorStop(0.8, '#7A5010'); bg.addColorStop(1, '#5C3A08');
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.ellipse(0, 2, 12, 13, 0, 0, Math.PI*2); ctx.fill();

    // Shell ridge lines
    ctx.strokeStyle = '#5C3A08'; ctx.lineWidth = 1;
    for (let i=-2; i<=2; i++) {
      ctx.beginPath(); ctx.moveTo(i*3, -10);
      ctx.quadraticCurveTo(i*4, 2, i*3, 14); ctx.stroke();
    }

    // Top cap
    const cg = ctx.createRadialGradient(-2,-12,1, 0,-10,8);
    cg.addColorStop(0,'#8B6020'); cg.addColorStop(1,'#5C3A08');
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.ellipse(0,-10,7,5.5,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='rgba(255,200,100,0.28)';
    ctx.beginPath(); ctx.ellipse(-2,-11,3,2,-0.3,0,Math.PI*2); ctx.fill();

    // Evil eyes
    ctx.fillStyle = '#FF7700';
    ctx.beginPath(); ctx.arc(-5,-1,3,0,Math.PI*2); ctx.arc(5,-1,3,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = '#1A0000';
    ctx.beginPath(); ctx.arc(-4.5,-1,1.6,0,Math.PI*2); ctx.arc(5.5,-1,1.6,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = 'rgba(255,180,100,0.5)';
    ctx.beginPath(); ctx.arc(-5.5,-2,1,0,Math.PI*2); ctx.arc(4.5,-2,1,0,Math.PI*2); ctx.fill();

    // Gloss
    const sh = ctx.createRadialGradient(-5,-5,0,-3,-3,9);
    sh.addColorStop(0,'rgba(255,220,150,0.4)'); sh.addColorStop(1,'rgba(255,220,150,0)');
    ctx.fillStyle = sh;
    ctx.beginPath(); ctx.ellipse(0,2,12,13,0,0,Math.PI*2); ctx.fill();

    ctx.restore();
  }
}

class SweetGuard {
  constructor(x, y) {
    this.x = x; this.y = y; this.w = 30; this.h = 44;
    this.vx = 0; this.vy = 0;
    this.alertT = 0; this.dead = false;
  }
  kill() { this.dead = true; }
  update() {
    if (this.dead || !player) return;
    const dx = (player.x + player.w/2) - (this.x + this.w/2);
    const dist = Math.abs(dx) + Math.abs((player.y + player.h/2) - (this.y + this.h/2));
    if (dist < 220) { this.alertT = 35; this.vx = (dx > 0 ? 1 : -1) * 2.2; }
    else { this.vx *= 0.88; }
    if (this.alertT > 0) this.alertT--;
    this.x += this.vx;
    this.vy = Math.min(this.vy + GRAVITY, MAX_FALL);
    this.y += this.vy;
    for (const p of lPlatforms) {
      if (overlap({x:this.x+2,y:this.y,w:this.w-4,h:this.h},{x:p.x,y:p.y,w:p.w,h:p.h})&&this.vy>=0) {
        this.y = p.y - this.h; this.vy = 0;
      }
      if (overlap({x:this.x,y:this.y+4,w:this.w,h:this.h-8},{x:p.x,y:p.y,w:p.w,h:p.h})) {
        if (this.vx > 0) this.x = p.x - this.w;
        else             this.x = p.x + p.w;
        this.vx = 0;
      }
    }
  }
  draw() {
    if (this.dead) return;
    const cx = this.x + this.w/2;
    const al = this.alertT > 0;

    // Ground shadow
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.ellipse(cx+2, this.y+this.h+2, 12, 4, 0, 0, Math.PI*2); ctx.fill();

    // Body uniform with gradient
    const bg = ctx.createLinearGradient(this.x+3, this.y+16, this.x+27, this.y+44);
    bg.addColorStop(0, al?'#FF4444':'#DD1111'); bg.addColorStop(0.5, al?'#EE2222':'#CC0000'); bg.addColorStop(1, al?'#CC1111':'#990000');
    rRect(this.x+3, this.y+16, 24, 28, 5, bg, null);
    ctx.fillStyle = 'rgba(255,255,255,0.38)';
    for (let i=0;i<3;i++) ctx.fillRect(this.x+4, this.y+20+i*8, 22, 3);

    // Belt buckle
    rRect(cx-6, this.y+36, 12, 8, 3, '#FFD700', '#CC9900', 1);
    ctx.fillStyle='#CC9900'; ctx.font='bold 6px Arial'; ctx.textAlign='center';
    ctx.fillText('K', cx, this.y+43); ctx.textAlign='left';

    // Neck
    ctx.fillStyle='#FFD5B0'; ctx.fillRect(cx-5, this.y+12, 10, 6);

    // Head with gradient
    const hg = ctx.createRadialGradient(cx-4, this.y+8, 2, cx, this.y+12, 13);
    hg.addColorStop(0,'#FFE0BB'); hg.addColorStop(1,'#F0C090');
    ctx.fillStyle=hg; ctx.beginPath(); ctx.arc(cx,this.y+12,12,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#E0A870'; ctx.lineWidth=0.8;
    ctx.beginPath(); ctx.arc(cx,this.y+12,12,0,Math.PI*2); ctx.stroke();

    // Hat brim + top
    rRect(cx-12, this.y+1, 24, 7, 2, al?'#EE0000':'#CC0000', '#880000', 1);
    rRect(cx-7, this.y-11, 14, 13, 3, al?'#FF2222':'#CC0000', '#880000', 1);
    ctx.fillStyle='#FFFFFF'; ctx.fillRect(cx-12, this.y+5, 24, 3);
    ctx.fillStyle='#FFD700'; ctx.beginPath(); ctx.arc(cx,this.y-4,3.5,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#CC9900'; ctx.font='bold 5px Arial'; ctx.textAlign='center';
    ctx.fillText('★',cx,this.y-2); ctx.textAlign='left';

    // Eyes
    ctx.fillStyle = al ? '#FF2200' : '#3A2010';
    ctx.beginPath(); ctx.arc(cx-4,this.y+11,2.5,0,Math.PI*2); ctx.arc(cx+4,this.y+11,2.5,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='rgba(255,255,255,0.7)';
    ctx.beginPath(); ctx.arc(cx-3.2,this.y+10,0.9,0,Math.PI*2); ctx.arc(cx+4.8,this.y+10,0.9,0,Math.PI*2); ctx.fill();

    // Mouth
    ctx.strokeStyle='#5A1A00'; ctx.lineWidth=1.4;
    if (al) {
      ctx.beginPath(); ctx.moveTo(cx-4,this.y+16); ctx.lineTo(cx,this.y+14); ctx.lineTo(cx+4,this.y+16); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(cx,this.y+14,3.5,0.2,Math.PI-0.2); ctx.stroke();
    }

    // Pulsing alert "!"
    if (al) {
      ctx.save(); ctx.translate(cx, this.y-18);
      ctx.globalAlpha = 0.7 + 0.3*Math.sin(frameCount*0.3);
      ctx.fillStyle='#FFD700'; ctx.font='bold 16px Arial'; ctx.textAlign='center';
      ctx.fillText('!',0,0); ctx.globalAlpha=1; ctx.textAlign='left'; ctx.restore();
    }
  }
}

// ============================================================
// COLLECTIBLE: SCHOKO BON
// ============================================================
class SchokoBot {
  constructor(x, y) {
    this.x = x; this.y = y; this.r = 10;
    this.collected = false;
    this.phase = Math.random() * Math.PI * 2;
    this.sparkT = Math.floor(Math.random() * 60);
  }
  update() { if (!this.collected) { this.phase += 0.05; this.sparkT = (this.sparkT+1)%60; } }
  draw() {
    if (this.collected) return;
    const cx = this.x, cy = this.y + Math.sin(this.phase) * 3;
    const bw = 22, bh = 15;

    // Outer glow
    const glow = ctx.createRadialGradient(cx, cy, 1, cx, cy, bw+6);
    glow.addColorStop(0, 'rgba(200,134,10,0.45)'); glow.addColorStop(1, 'rgba(200,134,10,0)');
    ctx.fillStyle = glow; ctx.beginPath(); ctx.ellipse(cx, cy, bw+6, bh+6, 0, 0, Math.PI*2); ctx.fill();

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    ctx.beginPath(); ctx.ellipse(cx+1.5, cy+1.5, bw, bh, 0, 0, Math.PI*2); ctx.fill();

    // Red twists on each side
    _drawHorizTwist(cx - bw, cy, 11, 13, true);
    _drawHorizTwist(cx + bw, cy, 11, 13, false);

    // Body clip
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx, cy, bw, bh, 0, 0, Math.PI*2); ctx.clip();

    const bg = ctx.createLinearGradient(cx-bw, cy-bh, cx+bw*0.3, cy+bh);
    bg.addColorStop(0, '#FFFFFF'); bg.addColorStop(0.45, '#F6F0E6');
    bg.addColorStop(0.8, '#EAE0CC'); bg.addColorStop(1, '#D5C5A0');
    ctx.fillStyle = bg; ctx.fillRect(cx-bw, cy-bh, bw*2, bh*2);

    // Chocolate bottom (animated wave border)
    ctx.fillStyle = '#6A3200';
    ctx.beginPath();
    for (let i=0; i<=5; i++) {
      const wx = cx - bw + bw*2*i/5;
      const osc = Math.sin(i*1.5 + frameCount*0.06) * 2;
      i===0 ? ctx.moveTo(wx, cy+2+osc) : ctx.lineTo(wx, cy+2+osc);
    }
    ctx.lineTo(cx+bw, cy+bh); ctx.lineTo(cx-bw, cy+bh); ctx.closePath(); ctx.fill();

    // Cream swirl drop
    ctx.fillStyle = 'rgba(255,250,240,0.65)';
    ctx.beginPath(); ctx.ellipse(cx+3, cy+6, 5, 3.5, 0.3, 0, Math.PI*2); ctx.fill();

    // Blue kinder stripe
    ctx.fillStyle = '#0099DD';
    ctx.fillRect(cx-bw, cy-bh*0.72, bw*2, bh*0.56);
    ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 6px Arial';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('kinder', cx, cy - bh*0.44);
    ctx.fillStyle = '#0099DD'; ctx.font = 'bold 4.5px Arial';
    ctx.fillText('Schoko-Bons', cx, cy+1.5);

    ctx.restore(); // end clip

    // Outline
    ctx.strokeStyle = '#C8A870'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.ellipse(cx, cy, bw, bh, 0, 0, Math.PI*2); ctx.stroke();

    // Specular shine
    ctx.fillStyle = 'rgba(255,255,255,0.56)';
    ctx.beginPath(); ctx.ellipse(cx-bw*0.28, cy-bh*0.38, bw*0.28, bh*0.28, -0.25, 0, Math.PI*2); ctx.fill();

    // Sparkle rays
    if (this.sparkT < 8) {
      const len = 4 + this.sparkT * 0.9;
      ctx.strokeStyle = '#FFD700'; ctx.lineWidth = 1.2;
      for (let i=0; i<4; i++) {
        const a = i*Math.PI/2 + this.sparkT*0.5;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a)*(bw+2), cy + Math.sin(a)*(bh+2));
        ctx.lineTo(cx + Math.cos(a)*(bw+len), cy + Math.sin(a)*(bh+len));
        ctx.stroke();
      }
    }

    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
}

// ============================================================
// POWER-UP ITEM
// ============================================================
class PowerUpItem {
  constructor(x, y, type) {
    this.x = x; this.y = y; this.w = 28; this.h = 28;
    this.type = type; this.collected = false;
    this.phase = Math.random() * Math.PI * 2;
  }
  update() { if (!this.collected) this.phase += 0.04; }
  draw() {
    if (this.collected) return;
    const bob = Math.sin(this.phase) * 4;
    const py  = this.y + bob;
    const cfg = PU[this.type];
    const cx  = this.x + this.w/2, cy = py + this.h/2;

    // Pulsing outer glow
    const gr = 22 + 3*Math.sin(this.phase*2);
    const glow = ctx.createRadialGradient(cx,cy,6,cx,cy,gr);
    glow.addColorStop(0, cfg.col+'AA'); glow.addColorStop(0.5, cfg.col+'44'); glow.addColorStop(1, cfg.col+'00');
    ctx.fillStyle=glow; ctx.beginPath(); ctx.arc(cx,cy,gr,0,Math.PI*2); ctx.fill();

    // Rotating spoke rays
    ctx.save(); ctx.translate(cx,cy); ctx.rotate(frameCount*0.04);
    ctx.strokeStyle=cfg.col; ctx.lineWidth=1.2; ctx.globalAlpha=0.5;
    for (let i=0;i<6;i++) {
      const a=i*Math.PI/3;
      ctx.beginPath(); ctx.moveTo(Math.cos(a)*16,Math.sin(a)*16);
      ctx.lineTo(Math.cos(a)*22,Math.sin(a)*22); ctx.stroke();
    }
    ctx.globalAlpha=1; ctx.restore();

    // Box shadow
    ctx.fillStyle='rgba(0,0,0,0.28)';
    rRect(this.x+3,py+3,this.w,this.h,8,'rgba(0,0,0,0.28)',null);

    // Box body
    const bG = ctx.createLinearGradient(this.x,py,this.x+this.w,py+this.h);
    bG.addColorStop(0, cfg.col); bG.addColorStop(1, cfg.col+'BB');
    rRect(this.x,py,this.w,this.h,8,bG,null);
    rRect(this.x+2,py+2,this.w-4,this.h-4,6,'rgba(255,255,255,0.2)',null);

    // Top shine
    ctx.fillStyle='rgba(255,255,255,0.38)';
    rRect(this.x+3,py+3,this.w-6,6,3,'rgba(255,255,255,0.38)',null);

    // Outline
    rRect(this.x,py,this.w,this.h,8,null,'rgba(255,255,255,0.7)',1.5);

    if (this.type === 'doubleJump') {
      // Draw candy wings instead of icon
      ctx.save(); ctx.translate(cx, cy);
      const wf = 0.85 + 0.15 * Math.sin(frameCount * 0.14);
      ctx.scale(wf, wf);
      for (const side of [-1, 1]) {
        ctx.save(); ctx.scale(side, 1);
        const wg = ctx.createLinearGradient(2, -8, 14, 2);
        wg.addColorStop(0, '#FFFFFF'); wg.addColorStop(0.5, '#00CFFF'); wg.addColorStop(1, 'rgba(0,150,220,0)');
        ctx.fillStyle = wg;
        ctx.beginPath(); ctx.moveTo(2, 0);
        ctx.bezierCurveTo(6, -10, 14, -7, 12, 2);
        ctx.bezierCurveTo(11, 8, 5, 7, 2, 0);
        ctx.fill();
        ctx.strokeStyle = 'rgba(180,240,255,0.8)'; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(3, -1); ctx.quadraticCurveTo(9, -7, 12, -1); ctx.stroke();
        ctx.restore();
      }
      // Center gem
      const gemG = ctx.createRadialGradient(0, 0, 0, 0, 0, 5);
      gemG.addColorStop(0, '#FFFFFF'); gemG.addColorStop(0.4, '#00CFFF'); gemG.addColorStop(1, '#0066AA');
      ctx.fillStyle = gemG; ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI*2); ctx.fill();
      ctx.restore();
    } else if (this.type === 'dash') {
      // Draw speed-arrow icon
      ctx.save(); ctx.translate(cx, cy);
      const df = 1 + 0.12 * Math.sin(frameCount * 0.18);
      ctx.scale(df, 1);
      for (let i = 0; i < 3; i++) {
        const alpha = (3-i)/3;
        ctx.globalAlpha = alpha * 0.9;
        ctx.fillStyle = '#FF44CC';
        ctx.beginPath();
        const ox = (i-1)*5;
        ctx.moveTo(ox+6, 0); ctx.lineTo(ox-2, -6); ctx.lineTo(ox-2, -2);
        ctx.lineTo(ox-8, -2); ctx.lineTo(ox-8, 2); ctx.lineTo(ox-2, 2);
        ctx.lineTo(ox-2, 6); ctx.closePath(); ctx.fill();
      }
      ctx.globalAlpha = 1; ctx.restore();
    } else {
      // Default icon
      ctx.font='17px Arial'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillStyle='rgba(0,0,0,0.3)'; ctx.fillText(cfg.icon, cx+1, cy+1);
      ctx.fillText(cfg.icon, cx, cy);
      ctx.textAlign='left'; ctx.textBaseline='alphabetic';
    }
  }
}

// ============================================================
// BLOCK RENDERER — textures haute qualité par type
// ============================================================
// helper — clip to rounded rect
function _clipRR(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y,   x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x,   y+h, r);
  ctx.arcTo(x,   y+h, x,   y,   r);
  ctx.arcTo(x,   y,   x+w, y,   r);
  ctx.closePath();
}

function drawBlock(x, y, w, h, type) {
  ctx.save();
  const R = 7;

  // ── Drop shadow ──
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 12; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 7;
  _clipRR(x, y, w, h, R); ctx.fillStyle = 'rgba(0,0,0,0.01)'; ctx.fill();
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;

  // ── Clip all interior drawing to rounded rect ──
  _clipRR(x, y, w, h, R); ctx.clip();

  if (type === 'chocolate') {
    // Main gradient body
    const mg = ctx.createLinearGradient(x, y, x, y+h);
    mg.addColorStop(0, '#7B3F12'); mg.addColorStop(0.55, '#5C2A08'); mg.addColorStop(1, '#3D1A04');
    ctx.fillStyle = mg; ctx.fillRect(x, y, w, h);

    // Chocolate bar brick grid
    const cellW = 34;
    const rows = Math.max(1, Math.floor((h - 8) / 14));
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    for (let r = 1; r <= rows; r++) {
      const ry = y + r * 14;
      if (ry < y + h - 8) ctx.fillRect(x, ry - 1, w, 2);
    }
    for (let r = 0; r <= rows; r++) {
      const offset = (r % 2) * cellW * 0.5;
      const cols = Math.ceil(w / cellW) + 1;
      for (let c = 1; c <= cols; c++) {
        const vx = x + c * cellW - offset;
        if (vx > x + 2 && vx < x + w - 2)
          ctx.fillRect(vx - 1, y + r * 14, 2, Math.min(14, h - 8 - r * 14));
      }
    }
    // Per-brick highlight
    ctx.fillStyle = 'rgba(255,200,130,0.065)';
    for (let r = 0; r <= rows; r++) {
      const offset = (r % 2) * cellW * 0.5;
      for (let c = 0; c < Math.ceil(w / cellW) + 1; c++) {
        const bx = x + c * cellW - offset;
        const clipX = Math.max(bx + 2, x + 2);
        const rw = Math.min(bx + cellW - 4, x + w - 2) - clipX;
        if (rw > 0) ctx.fillRect(clipX, y + r * 14 + 1, rw, 3);
      }
    }
    // Diagonal crack details
    if (w > 60) {
      ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1.2;
      const crx = x + w * 0.38;
      ctx.beginPath(); ctx.moveTo(crx, y+3); ctx.lineTo(crx+8, y+h*0.48); ctx.lineTo(crx+5, y+h*0.72); ctx.stroke();
      if (w > 120) {
        ctx.beginPath(); ctx.moveTo(x+w*0.72, y+2); ctx.lineTo(x+w*0.75, y+h*0.42); ctx.stroke();
      }
    }
    // Top specular strip
    const shG = ctx.createLinearGradient(x, y, x, y+7);
    shG.addColorStop(0, 'rgba(255,210,130,0.42)'); shG.addColorStop(1, 'rgba(255,210,130,0)');
    ctx.fillStyle = shG; ctx.fillRect(x+3, y, w-6, 7);
    // Bottom 3D face
    const edgeG = ctx.createLinearGradient(x, y+h-8, x, y+h);
    edgeG.addColorStop(0, '#2A1006'); edgeG.addColorStop(1, '#180602');
    ctx.fillStyle = edgeG; ctx.fillRect(x, y+h-8, w, 8);
    // Edge line
    ctx.strokeStyle = 'rgba(255,220,160,0.22)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x+5, y+1); ctx.lineTo(x+w-5, y+1); ctx.stroke();

  } else if (type === 'cream') {
    // Base gradient
    const mg = ctx.createLinearGradient(x, y, x, y+h);
    mg.addColorStop(0, '#FFF8F2'); mg.addColorStop(0.45, '#F5E8C8'); mg.addColorStop(1, '#E0CC90');
    ctx.fillStyle = mg; ctx.fillRect(x, y, w, h);
    // Wavy cream top
    ctx.fillStyle = '#FFFDF8';
    ctx.beginPath();
    const wSteps = Math.ceil(w / 10);
    for (let i = 0; i <= wSteps; i++) {
      const wx = x + w * i / wSteps;
      const wy = y + 5 + Math.sin(i * 1.3) * 4.5;
      i === 0 ? ctx.moveTo(wx, wy) : ctx.lineTo(wx, wy);
    }
    ctx.lineTo(x+w, y); ctx.lineTo(x, y); ctx.closePath(); ctx.fill();
    // Cream dollop peaks
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    const dollops = Math.max(2, Math.floor(w / 28));
    for (let i = 0; i < dollops; i++) {
      const dx = x + 14 + i * ((w - 28) / Math.max(dollops - 1, 1));
      ctx.beginPath(); ctx.ellipse(dx, y+5, 5, 4.5, 0, Math.PI, 0, true); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.ellipse(dx, y+2, 2.5, 3, 0, Math.PI, 0, true); ctx.closePath(); ctx.fill();
    }
    // Cream shadow under top
    ctx.fillStyle = 'rgba(200,168,90,0.15)'; ctx.fillRect(x+2, y+10, w-4, 4);
    // Segment lines
    ctx.strokeStyle = 'rgba(200,168,80,0.22)'; ctx.lineWidth = 1;
    for (let sx = x + 40; sx < x + w - 15; sx += 40) {
      ctx.beginPath(); ctx.moveTo(sx, y+10); ctx.lineTo(sx, y+h-6); ctx.stroke();
    }
    // Sugar sparkle dots
    ctx.fillStyle = 'rgba(255,235,160,0.52)';
    for (let i = 0; i < Math.floor(w / 18); i++) {
      ctx.beginPath(); ctx.arc(x+9+i*18+(i*7%11)-5, y+h*0.55+(i*5%8)-4, 1.5, 0, Math.PI*2); ctx.fill();
    }
    // Top shine
    const shG = ctx.createLinearGradient(x, y, x, y+10);
    shG.addColorStop(0, 'rgba(255,255,255,0.72)'); shG.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = shG; ctx.fillRect(x+2, y, w-4, 10);
    // Bottom edge
    const edgeG = ctx.createLinearGradient(x, y+h-7, x, y+h);
    edgeG.addColorStop(0, '#C8A060'); edgeG.addColorStop(1, '#906828');
    ctx.fillStyle = edgeG; ctx.fillRect(x, y+h-7, w, 7);
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x+5, y+1); ctx.lineTo(x+w-5, y+1); ctx.stroke();

  } else if (type === 'nougat') {
    // Base gradient
    const mg = ctx.createLinearGradient(x, y, x, y+h);
    mg.addColorStop(0, '#E8B840'); mg.addColorStop(0.5, '#C47818'); mg.addColorStop(1, '#8A5208');
    ctx.fillStyle = mg; ctx.fillRect(x, y, w, h);
    // Horizontal wood-grain lines
    const grainCount = Math.max(3, Math.floor((h - 8) / 4));
    for (let i = 0; i < grainCount; i++) {
      ctx.strokeStyle = i % 2 === 0 ? 'rgba(255,220,130,0.16)' : 'rgba(0,0,0,0.1)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y+i*4); ctx.lineTo(x+w, y+i*4); ctx.stroke();
    }
    // Plank separators with nail heads
    const planks = Math.max(1, Math.floor(w / 48));
    for (let i = 1; i < planks; i++) {
      const sx = x + i * (w / planks);
      ctx.strokeStyle = 'rgba(90,50,10,0.38)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(sx, y+2); ctx.lineTo(sx, y+h-8); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,230,130,0.22)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx+2, y+2); ctx.lineTo(sx+2, y+h-8); ctx.stroke();
      for (const ny2 of [y + h*0.3, y + h*0.65]) {
        ctx.fillStyle = '#7A6030';
        ctx.beginPath(); ctx.arc(sx, ny2, 2.8, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = 'rgba(255,230,140,0.45)';
        ctx.beginPath(); ctx.arc(sx-0.8, ny2-0.8, 1.2, 0, Math.PI*2); ctx.fill();
      }
    }
    // Hazelnut decorations
    const nutCount = Math.max(2, Math.floor(w / 40));
    for (let i = 0; i < nutCount; i++) {
      const nx = x + 20 + i * ((w - 40) / Math.max(nutCount - 1, 1)) + (i*5%8) - 3;
      const ny = y + 5;
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath(); ctx.ellipse(nx+1.5, ny+1.5, 5.5, 4, 0.3, 0, Math.PI*2); ctx.fill();
      const ng = ctx.createRadialGradient(nx-1.5, ny-1, 0.5, nx, ny, 5.5);
      ng.addColorStop(0, '#D0A050'); ng.addColorStop(0.5, '#966A18'); ng.addColorStop(1, '#5C3A0A');
      ctx.fillStyle = ng; ctx.beginPath(); ctx.ellipse(nx, ny, 5.5, 4, 0.3, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = 'rgba(60,30,5,0.3)'; ctx.lineWidth = 0.7;
      for (const ri of [-2, 0, 2]) {
        ctx.beginPath(); ctx.moveTo(nx+ri, ny-3.5); ctx.quadraticCurveTo(nx+ri*1.2, ny, nx+ri, ny+3.5); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(240,200,100,0.55)';
      ctx.beginPath(); ctx.ellipse(nx-1.5, ny-1, 2.5, 1.5, 0.3, 0, Math.PI*2); ctx.fill();
    }
    // Knot hole
    if (w > 90) {
      const kx = x + w * 0.62, ky = y + h * 0.6;
      ctx.fillStyle = 'rgba(60,30,5,0.28)'; ctx.beginPath(); ctx.ellipse(kx, ky, 4, 3, 0.2, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = 'rgba(60,30,5,0.4)'; ctx.lineWidth = 0.9;
      ctx.beginPath(); ctx.ellipse(kx, ky, 7, 5, 0.2, 0, Math.PI*2); ctx.stroke();
    }
    // Top shine
    const shG = ctx.createLinearGradient(x, y, x, y+8);
    shG.addColorStop(0, 'rgba(255,240,150,0.44)'); shG.addColorStop(1, 'rgba(255,240,150,0)');
    ctx.fillStyle = shG; ctx.fillRect(x+2, y, w-4, 8);
    // Bottom edge
    const edgeG = ctx.createLinearGradient(x, y+h-7, x, y+h);
    edgeG.addColorStop(0, '#5C3008'); edgeG.addColorStop(1, '#381C04');
    ctx.fillStyle = edgeG; ctx.fillRect(x, y+h-7, w, 7);
    ctx.strokeStyle = 'rgba(255,220,130,0.22)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x+5, y+1); ctx.lineTo(x+w-5, y+1); ctx.stroke();

  } else if (type === 'ground') {
    const mg = ctx.createLinearGradient(x, y, x, y+h);
    mg.addColorStop(0, '#6B3810'); mg.addColorStop(0.45, '#4A2208'); mg.addColorStop(1, '#2A1004');
    ctx.fillStyle = mg; ctx.fillRect(x, y, w, h);
    // Strata bands
    for (let i = 1; i <= 3; i++) {
      ctx.strokeStyle = i % 2 === 0 ? 'rgba(255,180,80,0.07)' : 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y+i*h/4); ctx.lineTo(x+w, y+i*h/4); ctx.stroke();
    }
    // Chip dots
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    for (let i = 0; i < Math.floor(w/14); i++) {
      ctx.beginPath(); ctx.arc(x+7+i*14+(i*7%9)-4, y+4+(i*5%(h-8)), 2+(i%2), 0, Math.PI*2); ctx.fill();
    }
    ctx.fillStyle = 'rgba(200,140,60,0.08)';
    for (let i = 0; i < Math.floor(w/20); i++) {
      ctx.beginPath(); ctx.arc(x+10+i*20+(i*11%7)-3, y+7+(i*7%(h-12)), 1.5, 0, Math.PI*2); ctx.fill();
    }
    // Crack lines
    if (w > 60) {
      ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x+w*0.15, y+2); ctx.lineTo(x+w*0.2, y+h*0.5); ctx.lineTo(x+w*0.18, y+h*0.75); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x+w*0.65, y+3); ctx.lineTo(x+w*0.68, y+h*0.4); ctx.stroke();
    }
    const shG = ctx.createLinearGradient(x, y, x, y+5);
    shG.addColorStop(0, 'rgba(200,140,60,0.3)'); shG.addColorStop(1, 'rgba(200,140,60,0)');
    ctx.fillStyle = shG; ctx.fillRect(x+3, y, w-6, 5);
    ctx.fillStyle = '#180A02'; ctx.fillRect(x, y+h-6, w, 6);
    ctx.strokeStyle = 'rgba(200,140,60,0.15)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x+5, y+1); ctx.lineTo(x+w-5, y+1); ctx.stroke();

  } else if (type === 'candy') {
    // Candy cane stripes
    ctx.fillStyle = '#FFF0F0'; ctx.fillRect(x, y, w, h);
    const stripeW = 10;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    for (let sx = x - h; sx < x + w + stripeW; sx += stripeW * 2) {
      ctx.fillStyle = 'rgba(220,0,30,0.68)';
      ctx.beginPath();
      ctx.moveTo(sx, y); ctx.lineTo(sx+stripeW, y);
      ctx.lineTo(sx+stripeW+h, y+h); ctx.lineTo(sx+h, y+h);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    // Gloss top half
    const shG = ctx.createLinearGradient(x, y, x, y+h*0.5);
    shG.addColorStop(0, 'rgba(255,255,255,0.62)'); shG.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = shG; ctx.fillRect(x, y, w, h*0.5);
    // Gem sparkles
    const gems = ['#FF6090','#60C8FF','#FFE040','#C060FF'];
    for (let i = 0; i < Math.floor(w/28); i++) {
      const gx2 = x+14+i*28, gy2 = y+h*0.3;
      ctx.fillStyle = gems[i%4];
      ctx.save(); ctx.translate(gx2, gy2); ctx.rotate(Math.PI/4); ctx.fillRect(-3,-3,6,6); ctx.restore();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.arc(gx2-1, gy2-1, 1.5, 0, Math.PI*2); ctx.fill();
    }
    // Cross sparkles
    ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.lineWidth = 1.2;
    for (let i = 0; i < Math.floor(w/50); i++) {
      const sx2 = x+25+i*50, sy2 = y+h*0.18;
      ctx.beginPath(); ctx.moveTo(sx2-5,sy2); ctx.lineTo(sx2+5,sy2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sx2,sy2-5); ctx.lineTo(sx2,sy2+5); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(180,0,20,0.38)'; ctx.fillRect(x, y+h-5, w, 5);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x+5, y+1); ctx.lineTo(x+w-5, y+1); ctx.stroke();

  } else if (type === 'spring') {
    const mg = ctx.createLinearGradient(x, y, x, y+h);
    mg.addColorStop(0, '#4A8040'); mg.addColorStop(0.5, '#2A5A28'); mg.addColorStop(1, '#1A3C18');
    ctx.fillStyle = mg; ctx.fillRect(x, y, w, h);
    const coilH = 5;
    for (let i = 0; i < Math.floor(h / coilH); i++) {
      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(x+2, y+i*coilH, w-4, coilH);
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.beginPath(); ctx.moveTo(x+w/2, y+h/2-6); ctx.lineTo(x+w/2+7, y+h/2+3); ctx.lineTo(x+w/2-7, y+h/2+3); ctx.closePath(); ctx.fill();
    const shG = ctx.createLinearGradient(x, y, x, y+6);
    shG.addColorStop(0, 'rgba(180,255,120,0.5)'); shG.addColorStop(1, 'rgba(180,255,120,0)');
    ctx.fillStyle = shG; ctx.fillRect(x+2, y, w-4, 6);
    ctx.fillStyle = '#102010'; ctx.fillRect(x, y+h-5, w, 5);
  }

  ctx.restore();
}

// ============================================================
// PLATFORM
// ============================================================
class Platform {
  constructor(cfg) { Object.assign(this, cfg); this.h = this.h || 20; this.type = this.type || 'chocolate'; }
  draw() { drawBlock(this.x, this.y, this.w, this.h, this.type); }
}

// ============================================================
// LEVEL DATA
// ============================================================
const LEVELS = [
  {
    name: 'La Chocolaterie',
    width: 3200,
    height: 600,
    bgTop: '#FFE4B5', bgBot: '#DEB887',
    spawn: { x: 80, y: 380 },
    end: { x: 3100, y: 380, w: 56, h: 70 },
    platforms: [
      // Ground segments
      { x:0,    y:440, w:480, h:20, type:'ground' },
      { x:530,  y:440, w:300, h:20, type:'ground' },
      { x:880,  y:440, w:380, h:20, type:'ground' },
      { x:1310, y:440, w:340, h:20, type:'ground' },
      { x:1700, y:440, w:400, h:20, type:'ground' },
      { x:2150, y:440, w:320, h:20, type:'ground' },
      { x:2530, y:440, w:680, h:20, type:'ground' },
      // Mid platforms
      { x:220,  y:360, w:130, h:18, type:'chocolate' },
      { x:400,  y:295, w:110, h:18, type:'cream'     },
      { x:560,  y:360, w:130, h:18, type:'cream'     },
      { x:740,  y:290, w:120, h:18, type:'nougat'    },
      { x:910,  y:360, w:140, h:18, type:'nougat'    },
      { x:1100, y:295, w:130, h:18, type:'chocolate' },
      { x:1280, y:355, w:120, h:18, type:'chocolate' },
      { x:1410, y:278, w:140, h:18, type:'cream'     },
      { x:1600, y:320, w:120, h:18, type:'nougat'    },
      { x:1770, y:370, w:150, h:18, type:'chocolate' },
      { x:1970, y:305, w:130, h:18, type:'cream'     },
      { x:2130, y:375, w:130, h:18, type:'nougat'    },
      { x:2290, y:295, w:150, h:18, type:'chocolate' },
      { x:2470, y:355, w:120, h:18, type:'cream'     },
      { x:2640, y:268, w:130, h:18, type:'chocolate' },
      { x:2820, y:315, w:140, h:18, type:'nougat'    },
      { x:3000, y:360, w:150, h:18, type:'chocolate' },
      // High platforms (optional bonus)
      { x:380,  y:220, w:100, h:16, type:'cream'     },
      { x:730,  y:215, w:110, h:16, type:'chocolate' },
      { x:1400, y:200, w:120, h:16, type:'cream'     },
      { x:2290, y:210, w:130, h:16, type:'nougat'    },
      { x:2810, y:235, w:110, h:16, type:'chocolate' },
    ],
    collectibles: [
      // Ground-level paths
      {x:120,y:415},{x:180,y:415},{x:250,y:415},{x:360,y:415},
      // Platform trails
      {x:225,y:335},{x:260,y:335},{x:295,y:335},
      {x:405,y:265},{x:445,y:265},
      {x:565,y:335},{x:605,y:335},{x:645,y:335},
      {x:745,y:265},{x:785,y:265},
      {x:915,y:335},{x:960,y:335},{x:1000,y:335},
      {x:1105,y:268},{x:1145,y:268},
      {x:1415,y:252},{x:1460,y:252},{x:1500,y:252},
      {x:1605,y:295},{x:1645,y:295},
      {x:1975,y:278},{x:2015,y:278},
      {x:2295,y:268},{x:2345,y:268},{x:2390,y:268},
      {x:2645,y:242},{x:2685,y:242},
      // High platform
      {x:390,y:195},{x:425,y:195},
      {x:1405,y:175},{x:1450,y:175},
    ],
    powerUps: [
      { x:610,  y:328, type:'speed'      },
      { x:1455, y:248, type:'doubleJump' },
      { x:2000, y:278, type:'dash'       },
      { x:2345, y:265, type:'shield'     },
      { x:2830, y:205, type:'ultra'      },
    ],
    enemies: [
      { type:'chocolate', x:600,  y:406, range:130 },
      { type:'chocolate', x:1100, y:406, range:160 },
      { type:'hazelnut',  x:1600, y:406 },
      { type:'chocolate', x:2150, y:406, range:130 },
      { type:'guard',     x:2750, y:396 },
    ],
  },

  {
    name: 'Montagnes de Noisettes',
    width: 4800,
    height: 650,
    bgTop: '#E8C87A', bgBot: '#8B6914',
    spawn: { x: 80, y: 400 },
    end: { x: 4710, y: 360, w: 56, h: 70 },
    platforms: [
      // Ground segments (many gaps)
      { x:0,    y:450, w:400, h:20, type:'ground' },
      { x:460,  y:450, w:280, h:20, type:'ground' },
      { x:790,  y:450, w:310, h:20, type:'ground' },
      { x:1160, y:450, w:300, h:20, type:'ground' },
      { x:1520, y:450, w:290, h:20, type:'ground' },
      { x:1870, y:450, w:380, h:20, type:'ground' },
      { x:2310, y:450, w:340, h:20, type:'ground' },
      { x:2710, y:450, w:310, h:20, type:'ground' },
      { x:3080, y:450, w:380, h:20, type:'ground' },
      { x:3520, y:450, w:330, h:20, type:'ground' },
      { x:3910, y:450, w:900, h:20, type:'ground' },
      // Mid platforms
      { x:200,  y:370, w:130, h:18, type:'chocolate' },
      { x:380,  y:300, w:110, h:18, type:'cream'     },
      { x:510,  y:370, w:130, h:18, type:'nougat'    },
      { x:700,  y:300, w:120, h:18, type:'chocolate' },
      { x:850,  y:370, w:140, h:18, type:'cream'     },
      { x:1020, y:295, w:130, h:18, type:'nougat'    },
      { x:1210, y:370, w:120, h:18, type:'chocolate' },
      { x:1360, y:285, w:140, h:18, type:'cream'     },
      { x:1540, y:365, w:130, h:18, type:'chocolate' },
      { x:1710, y:295, w:120, h:18, type:'nougat'    },
      { x:1890, y:370, w:150, h:18, type:'chocolate' },
      { x:2090, y:285, w:130, h:18, type:'cream'     },
      { x:2260, y:365, w:140, h:18, type:'nougat'    },
      { x:2440, y:275, w:120, h:18, type:'chocolate' },
      { x:2600, y:360, w:130, h:18, type:'cream'     },
      { x:2770, y:280, w:150, h:18, type:'nougat'    },
      { x:2960, y:370, w:120, h:18, type:'chocolate' },
      { x:3120, y:270, w:140, h:18, type:'cream'     },
      { x:3310, y:365, w:130, h:18, type:'nougat'    },
      { x:3490, y:275, w:150, h:18, type:'chocolate' },
      { x:3680, y:365, w:130, h:18, type:'cream'     },
      { x:3860, y:280, w:140, h:18, type:'nougat'    },
      { x:4060, y:355, w:120, h:18, type:'chocolate' },
      { x:4230, y:275, w:140, h:18, type:'cream'     },
      { x:4420, y:360, w:130, h:18, type:'nougat'    },
      { x:4600, y:285, w:170, h:18, type:'chocolate' },
      // High platforms
      { x:370,  y:220, w:110, h:16, type:'cream'     },
      { x:710,  y:215, w:120, h:16, type:'chocolate' },
      { x:1160, y:210, w:130, h:16, type:'nougat'    },
      { x:1710, y:218, w:120, h:16, type:'chocolate' },
      { x:2090, y:206, w:130, h:16, type:'cream'     },
      { x:2770, y:200, w:130, h:16, type:'nougat'    },
      { x:3490, y:198, w:140, h:16, type:'chocolate' },
      { x:4230, y:200, w:130, h:16, type:'cream'     },
    ],
    collectibles: [
      {x:120,y:425},{x:200,y:425},{x:280,y:425},
      {x:205,y:345},{x:245,y:345},{x:285,y:345},
      {x:385,y:275},{x:425,y:275},{x:465,y:275},
      {x:515,y:345},{x:555,y:345},{x:595,y:345},
      {x:705,y:275},{x:745,y:275},
      {x:855,y:345},{x:895,y:345},{x:935,y:345},
      {x:1025,y:270},{x:1065,y:270},{x:1105,y:270},
      {x:1215,y:345},{x:1255,y:345},
      {x:1365,y:260},{x:1405,y:260},{x:1445,y:260},
      {x:1545,y:340},{x:1585,y:340},
      {x:1715,y:270},{x:1755,y:270},
      {x:1895,y:345},{x:1935,y:345},{x:1975,y:345},
      {x:2095,y:260},{x:2135,y:260},
      {x:2445,y:250},{x:2485,y:250},{x:2520,y:250},
      {x:2605,y:335},{x:2645,y:335},
      {x:2775,y:255},{x:2815,y:255},
      {x:3125,y:245},{x:3165,y:245},{x:3200,y:245},
      {x:3495,y:250},{x:3535,y:250},
      {x:4235,y:250},{x:4275,y:250},{x:4310,y:250},
      {x:4605,y:260},{x:4645,y:260},
      // High platform bonuses
      {x:375,y:195},{x:415,y:195},
      {x:1165,y:185},{x:1205,y:185},
      {x:2775,y:175},{x:2815,y:175},
      {x:4235,y:175},{x:4275,y:175},
    ],
    powerUps: [
      { x:515,  y:340, type:'speed'      },
      { x:1365, y:255, type:'doubleJump' },
      { x:2130, y:258, type:'dash'       },
      { x:2445, y:245, type:'shield'     },
      { x:3680, y:335, type:'speed'      },
      { x:4200, y:330, type:'doubleJump' },
      { x:4605, y:255, type:'ultra'      },
    ],
    enemies: [
      { type:'chocolate', x:430,  y:415, range:120 },
      { type:'hazelnut',  x:720,  y:415 },
      { type:'chocolate', x:1070, y:415, range:150 },
      { type:'guard',     x:1500, y:415 },
      { type:'hazelnut',  x:1930, y:415 },
      { type:'chocolate', x:2320, y:415, range:130 },
      { type:'guard',     x:2780, y:415 },
      { type:'hazelnut',  x:3200, y:415 },
      { type:'chocolate', x:3650, y:415, range:140 },
      { type:'guard',     x:4280, y:415 },
    ],
  },

  {
    name: 'Château de Crème',
    width: 5600,
    height: 650,
    bgTop: '#FFAACC', bgBot: '#CC4488',
    spawn: { x: 80, y: 400 },
    end: { x: 5510, y: 355, w: 56, h: 70 },
    platforms: [
      // Ground segments
      { x:0,    y:450, w:360, h:20, type:'ground' },
      { x:420,  y:450, w:280, h:20, type:'ground' },
      { x:760,  y:450, w:310, h:20, type:'ground' },
      { x:1130, y:450, w:300, h:20, type:'ground' },
      { x:1490, y:450, w:340, h:20, type:'ground' },
      { x:1890, y:450, w:290, h:20, type:'ground' },
      { x:2240, y:450, w:330, h:20, type:'ground' },
      { x:2630, y:450, w:310, h:20, type:'ground' },
      { x:2990, y:450, w:370, h:20, type:'ground' },
      { x:3420, y:450, w:320, h:20, type:'ground' },
      { x:3800, y:450, w:380, h:20, type:'ground' },
      { x:4240, y:450, w:310, h:20, type:'ground' },
      { x:4610, y:450, w:1000,h:20, type:'ground' },
      // Dense platform grid
      { x:180,  y:375, w:120, h:18, type:'cream'     },
      { x:350,  y:300, w:110, h:18, type:'chocolate' },
      { x:490,  y:370, w:130, h:18, type:'nougat'    },
      { x:660,  y:295, w:120, h:18, type:'cream'     },
      { x:820,  y:370, w:130, h:18, type:'chocolate' },
      { x:1000, y:285, w:130, h:18, type:'nougat'    },
      { x:1190, y:360, w:120, h:18, type:'cream'     },
      { x:1360, y:275, w:140, h:18, type:'chocolate' },
      { x:1550, y:365, w:130, h:18, type:'nougat'    },
      { x:1730, y:280, w:120, h:18, type:'cream'     },
      { x:1940, y:370, w:150, h:18, type:'chocolate' },
      { x:2140, y:275, w:130, h:18, type:'nougat'    },
      { x:2310, y:360, w:140, h:18, type:'cream'     },
      { x:2500, y:270, w:120, h:18, type:'chocolate' },
      { x:2680, y:360, w:130, h:18, type:'nougat'    },
      { x:2860, y:272, w:150, h:18, type:'cream'     },
      { x:3060, y:365, w:120, h:18, type:'chocolate' },
      { x:3240, y:270, w:140, h:18, type:'nougat'    },
      { x:3440, y:358, w:130, h:18, type:'cream'     },
      { x:3630, y:268, w:150, h:18, type:'chocolate' },
      { x:3840, y:360, w:120, h:18, type:'nougat'    },
      { x:4010, y:268, w:140, h:18, type:'cream'     },
      { x:4200, y:358, w:130, h:18, type:'chocolate' },
      { x:4390, y:268, w:150, h:18, type:'nougat'    },
      { x:4580, y:360, w:130, h:18, type:'cream'     },
      { x:4760, y:272, w:140, h:18, type:'chocolate' },
      { x:4950, y:355, w:130, h:18, type:'nougat'    },
      { x:5120, y:268, w:150, h:18, type:'cream'     },
      { x:5310, y:358, w:140, h:18, type:'chocolate' },
      { x:5480, y:280, w:130, h:18, type:'nougat'    },
      // High platforms
      { x:340,  y:220, w:110, h:16, type:'cream'     },
      { x:660,  y:215, w:120, h:16, type:'chocolate' },
      { x:1350, y:200, w:130, h:16, type:'nougat'    },
      { x:1730, y:205, w:120, h:16, type:'cream'     },
      { x:2500, y:195, w:130, h:16, type:'chocolate' },
      { x:2860, y:195, w:140, h:16, type:'nougat'    },
      { x:3630, y:190, w:140, h:16, type:'cream'     },
      { x:4390, y:190, w:140, h:16, type:'chocolate' },
      { x:5120, y:188, w:140, h:16, type:'nougat'    },
    ],
    collectibles: [
      {x:120,y:425},{x:185,y:350},{x:220,y:350},{x:260,y:350},
      {x:355,y:275},{x:395,y:275},{x:435,y:275},
      {x:495,y:345},{x:535,y:345},{x:575,y:345},
      {x:665,y:270},{x:705,y:270},
      {x:825,y:345},{x:865,y:345},{x:900,y:345},
      {x:1005,y:260},{x:1045,y:260},{x:1085,y:260},
      {x:1365,y:250},{x:1405,y:250},{x:1440,y:250},
      {x:1555,y:340},{x:1595,y:340},
      {x:1735,y:255},{x:1775,y:255},
      {x:1945,y:345},{x:1985,y:345},{x:2025,y:345},
      {x:2145,y:250},{x:2185,y:250},
      {x:2505,y:245},{x:2545,y:245},{x:2580,y:245},
      {x:2685,y:335},{x:2725,y:335},
      {x:2865,y:248},{x:2905,y:248},{x:2945,y:248},
      {x:3065,y:340},{x:3100,y:340},
      {x:3245,y:245},{x:3285,y:245},{x:3325,y:245},
      {x:3635,y:243},{x:3675,y:243},{x:3715,y:243},
      {x:3845,y:335},{x:3880,y:335},
      {x:4015,y:243},{x:4055,y:243},{x:4090,y:243},
      {x:4395,y:243},{x:4435,y:243},{x:4475,y:243},
      {x:4585,y:335},{x:4625,y:335},
      {x:4765,y:248},{x:4805,y:248},{x:4845,y:248},
      {x:4955,y:330},{x:4995,y:330},
      {x:5125,y:243},{x:5165,y:243},{x:5205,y:243},
      {x:5315,y:333},{x:5355,y:333},
      {x:5485,y:255},{x:5525,y:255},
      // High bonuses
      {x:345,y:195},{x:385,y:195},
      {x:1355,y:175},{x:1395,y:175},
      {x:2505,y:170},{x:2545,y:170},
      {x:3635,y:165},{x:3675,y:165},
      {x:5125,y:163},{x:5165,y:163},
    ],
    powerUps: [
      { x:400,  y:270, type:'speed'      },
      { x:1140, y:258, type:'doubleJump' },
      { x:1900, y:248, type:'dash'       },
      { x:2145, y:248, type:'shield'     },
      { x:3245, y:242, type:'speed'      },
      { x:3850, y:330, type:'doubleJump' },
      { x:4395, y:238, type:'ultra'      },
      { x:5125, y:160, type:'shield'     },
    ],
    enemies: [
      { type:'chocolate', x:400,  y:415, range:130 },
      { type:'hazelnut',  x:700,  y:415 },
      { type:'chocolate', x:1050, y:415, range:150 },
      { type:'guard',     x:1420, y:415 },
      { type:'hazelnut',  x:1980, y:415 },
      { type:'chocolate', x:2360, y:415, range:140 },
      { type:'guard',     x:2720, y:415 },
      { type:'hazelnut',  x:3130, y:415 },
      { type:'chocolate', x:3510, y:415, range:150 },
      { type:'guard',     x:3920, y:415 },
      { type:'hazelnut',  x:4320, y:415 },
      { type:'chocolate', x:4680, y:415, range:130 },
      { type:'guard',     x:5000, y:415 },
      { type:'hazelnut',  x:5300, y:415 },
      { type:'guard',     x:5490, y:415 },
    ],
  },
];

// ============================================================
// QUIZZES
// ============================================================
const QUIZZES = [
  {
    q: 'Quelle marque fabrique les Schoko Bons ?',
    a: ['Nestlé', 'Haribo', 'Kinder (Ferrero)', 'Mars'],
    ok: 2,
    expl: 'Kinder est une marque de Ferrero, société fondée en 1946 en Italie. "Kinder" signifie "enfants" en allemand !',
  },
  {
    q: 'De quoi est composé l\'intérieur d\'un Schoko Bon ?',
    a: ['Caramel pur', 'Farce noisette et chocolat blanc', 'Guimauve', 'Confiture de fraise'],
    ok: 1,
    expl: 'Les Schoko Bons ont une coque en chocolat au lait et une délicieuse farce à base de noisette et chocolat blanc !',
  },
  {
    q: 'En quelle année le Kinder Surprise a-t-il été lancé ?',
    a: ['1958', '1964', '1974', '1982'],
    ok: 2,
    expl: 'Le Kinder Surprise a été lancé en 1974 en Italie ! Les Schoko Bons, eux, ont suivi quelques années plus tard.',
  },
];

// ============================================================
// LEVEL MANAGEMENT
// ============================================================
function mkEnemy(cfg) {
  switch (cfg.type) {
    case 'hazelnut':  return new Hazelnut(cfg.x, cfg.y);
    case 'guard':     return new SweetGuard(cfg.x, cfg.y);
    default:          return new ChocCreature(cfg.x, cfg.y, cfg.range);
  }
}

function loadLevel(idx) {
  currentLevel   = idx;
  levelData      = LEVELS[idx];
  lPlatforms     = levelData.platforms.map(p => new Platform(p));
  lEnemies       = levelData.enemies.map(e => mkEnemy(e));
  lCollectibles  = levelData.collectibles.map(c => new SchokoBot(c.x, c.y));
  lPowerUps      = levelData.powerUps.map(p => new PowerUpItem(p.x, p.y, p.type));
  lEndZone       = levelData.end;
  player         = new Player(levelData.spawn.x, levelData.spawn.y);
  camera         = { x: 0 };
  particles      = [];
  notifications  = [];
  gameState      = 'playing';
}

// ============================================================
// BACKGROUND
// ============================================================
function drawBg() {
  // ── Sky gradient ──
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0,    levelData.bgTop);
  sky.addColorStop(0.35, levelData.bgBot);
  sky.addColorStop(0.72, '#5C2A08');
  sky.addColorStop(1,    '#2A0E02');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);

  // ── Sun glow ──
  const sunX = W * 0.76, sunY = H * 0.16;
  const sunCore = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 18);
  sunCore.addColorStop(0, 'rgba(255,240,180,0.95)');
  sunCore.addColorStop(1, 'rgba(255,210,100,0)');
  ctx.fillStyle = sunCore; ctx.beginPath(); ctx.arc(sunX, sunY, 18, 0, Math.PI*2); ctx.fill();
  const sunHalo = ctx.createRadialGradient(sunX, sunY, 8, sunX, sunY, 240);
  sunHalo.addColorStop(0, 'rgba(255,220,100,0.22)');
  sunHalo.addColorStop(0.5, 'rgba(255,160,40,0.07)');
  sunHalo.addColorStop(1, 'rgba(255,100,0,0)');
  ctx.fillStyle = sunHalo; ctx.fillRect(0, 0, W, H);

  // ── Chocolate drips from top ──
  for (let i = 0; i < 9; i++) {
    const dx = ((i * 160 + 40 - camera.x * 0.035) % (W + 120) + W + 120) % (W + 120) - 30;
    const dw = 8 + (i % 4) * 5;
    const dh = 38 + (i % 3) * 18;
    const dg = ctx.createLinearGradient(dx, 0, dx, dh);
    dg.addColorStop(0, 'rgba(50,18,4,0.32)'); dg.addColorStop(1, 'rgba(50,18,4,0)');
    ctx.fillStyle = dg;
    ctx.beginPath();
    ctx.moveTo(dx, 0); ctx.lineTo(dx + dw, 0);
    ctx.quadraticCurveTo(dx + dw + 5, dh * 0.5, dx + dw - 2, dh * 0.8);
    ctx.quadraticCurveTo(dx + dw - 3, dh, dx + dw/2, dh);
    ctx.quadraticCurveTo(dx + 2, dh, dx - 2, dh * 0.7);
    ctx.quadraticCurveTo(dx - 5, dh * 0.4, dx, 0);
    ctx.fill();
  }

  // ── Far candy/chocolate clouds ──
  for (let i = 0; i < 7; i++) {
    const cx2 = ((i * 210 + 80 - camera.x * 0.04) % (W + 280) + W + 280) % (W + 280) - 60;
    const cy2 = 28 + (i * 61) % 90;
    const cr = 20 + (i * 17 % 22);
    ctx.globalAlpha = 0.07 + 0.04 * Math.sin(frameCount * 0.013 + i);
    const cg = ctx.createRadialGradient(cx2, cy2, 2, cx2, cy2, cr);
    cg.addColorStop(0, '#C88040'); cg.addColorStop(1, 'rgba(100,40,5,0)');
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(cx2, cy2, cr, 0, Math.PI*2); ctx.fill();
    // Shine
    ctx.fillStyle = 'rgba(255,230,180,0.5)';
    ctx.beginPath(); ctx.ellipse(cx2-cr*0.25, cy2-cr*0.3, cr*0.35, cr*0.2, -0.3, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // ── Parallax hills — 5 layers ──
  const hills = [
    { a: 0.32, spd: 0.42, sz: 65,  yOff: -12, col: '70,26,5' },
    { a: 0.24, spd: 0.28, sz: 95,  yOff:   8, col: '60,22,4' },
    { a: 0.18, spd: 0.18, sz: 125, yOff:  22, col: '50,18,3' },
    { a: 0.13, spd: 0.10, sz: 160, yOff:  38, col: '40,14,2' },
    { a: 0.09, spd: 0.05, sz: 195, yOff:  52, col: '32,10,2' },
  ];
  for (const { a, spd, sz, yOff, col } of hills) {
    ctx.fillStyle = `rgba(${col},${a})`;
    for (let i = 0; i < 9; i++) {
      const hx = ((i * 255 + i * 18 - camera.x * spd) % (W + 360) + W + 360) % (W + 360) - 110;
      const hr = sz + (i * 31 % 52);
      ctx.beginPath(); ctx.arc(hx, H + yOff, hr, 0, Math.PI, true); ctx.fill();
    }
  }

  // ── Chocolate trees — mid layer ──
  for (let i = 0; i < 6; i++) {
    const tx = ((i * 310 + 55 - camera.x * 0.20) % (W + 320) + W + 320) % (W + 320) - 55;
    const th = 72 + (i * 41 % 52);
    const alpha = 0.30 + 0.08 * (i % 3);
    ctx.globalAlpha = alpha;
    // Trunk
    const tg = ctx.createLinearGradient(tx-8, H-th, tx+8, H);
    tg.addColorStop(0, '#3A1608'); tg.addColorStop(1, '#220C04');
    ctx.fillStyle = tg; ctx.fillRect(tx-7, H-th, 14, th);
    // Chocolate canopy balls
    for (let j = 0; j < 4; j++) {
      const bx = tx + (j - 1.5) * 16;
      const by = H - th - 8 - j * 10 + (j % 2) * 5;
      const br2 = 20 - j * 2;
      const bg = ctx.createRadialGradient(bx-4, by-4, 2, bx, by, br2);
      bg.addColorStop(0, '#5C2A0A'); bg.addColorStop(0.6, '#3A1806'); bg.addColorStop(1, '#220E03');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(bx, by, br2, 0, Math.PI*2); ctx.fill();
      // Canopy shine
      ctx.fillStyle = 'rgba(200,140,60,0.14)';
      ctx.beginPath(); ctx.arc(bx-4, by-4, br2*0.45, 0, Math.PI*2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ── Floating candy shapes (far parallax) ──
  for (let i = 0; i < 14; i++) {
    const bx  = ((i * 172 + 50 - camera.x * 0.055) % (W + 260) + W + 260) % (W + 260);
    const by  = 22 + (i * 79) % 165 + Math.sin(frameCount * 0.011 + i) * 11;
    const br  = 5 + i % 7;
    const alp = 0.07 + 0.05 * Math.sin(frameCount * 0.014 + i);
    ctx.globalAlpha = alp;
    // Oval candy body
    ctx.fillStyle = '#7B3A0C';
    ctx.beginPath(); ctx.ellipse(bx, by, br*1.75, br, 0.25, 0, Math.PI*2); ctx.fill();
    // White wrapper shine
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath(); ctx.ellipse(bx-br*0.5, by-br*0.32, br*0.55, br*0.32, 0, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // ── Ground fog ──
  const fog = ctx.createLinearGradient(0, H - 90, 0, H);
  fog.addColorStop(0, 'rgba(30,10,2,0)'); fog.addColorStop(1, 'rgba(15,5,1,0.65)');
  ctx.fillStyle = fog; ctx.fillRect(0, H - 90, W, 90);
}

// ============================================================
// END ZONE PORTAL
// ============================================================
function drawEndZone() {
  if (!lEndZone) return;
  const {x, y, w, h} = lEndZone;
  const t     = frameCount * 0.06;
  const pulse = 1 + 0.07 * Math.sin(t);

  ctx.save();
  ctx.translate(x + w/2, y + h/2);

  // Halo animé tournant
  for (let i = 0; i < 8; i++) {
    const a = t + i * Math.PI / 4;
    const r = 38 + 6 * Math.sin(t * 2 + i);
    ctx.globalAlpha = 0.18 + 0.1 * Math.sin(t + i);
    ctx.fillStyle = '#FFD700';
    ctx.beginPath(); ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Glow radial
  const glow = ctx.createRadialGradient(0, 0, 4, 0, 0, 55);
  glow.addColorStop(0, 'rgba(255,220,80,0.7)');
  glow.addColorStop(0.5, 'rgba(255,150,30,0.25)');
  glow.addColorStop(1, 'rgba(255,80,0,0)');
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0, 55, 0, Math.PI * 2); ctx.fill();

  ctx.scale(pulse, pulse);

  // Cadre
  ctx.shadowColor = '#FFD700'; ctx.shadowBlur = 15;
  rRect(-w/2, -h/2, w, h, 7, '#5C2808', '#FFD700', 2.5);
  ctx.shadowBlur = 0;

  // Intérieur brillant
  const ig = ctx.createLinearGradient(-w/2, -h/2, w/2, h/2);
  ig.addColorStop(0, '#FFD700'); ig.addColorStop(0.4, '#FFFACD'); ig.addColorStop(1, '#FFA500');
  rRect(-w/2+4, -h/2+4, w-8, h-8, 5, ig, null);

  // Étoile animée
  ctx.font = '30px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.save(); ctx.rotate(Math.sin(t) * 0.15);
  ctx.fillText('⭐', 0, 0); ctx.restore();

  // Label
  ctx.fillStyle = '#3D1A00'; ctx.font = 'bold 10px Arial';
  ctx.fillText('SORTIE', 0, h/2 + 14);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

// ============================================================
// HUD
// ============================================================
function drawHUD() {
  const col = levelData.collectibles.filter((_,i) => lCollectibles[i]?.collected).length;
  const tot = lCollectibles.length;

  // Panel
  rRect(8,8,285,68,10,'rgba(60,20,0,0.8)',null);

  // Mini Schoko-Bon icon (oval candy with red twists)
  ctx.save(); ctx.translate(30, 25); ctx.scale(0.72, 0.72);
  _drawHorizTwist(-16, 0, 9, 11, true);
  _drawHorizTwist(16, 0, 9, 11, false);
  ctx.save();
  ctx.beginPath(); ctx.ellipse(0,0,16,11,0,0,Math.PI*2); ctx.clip();
  const hig=ctx.createLinearGradient(-16,-11,5,11);
  hig.addColorStop(0,'#FFFFFF'); hig.addColorStop(0.5,'#F5EFE5'); hig.addColorStop(1,'#D0C0A0');
  ctx.fillStyle=hig; ctx.fillRect(-16,-11,32,22);
  ctx.fillStyle='#6B3200'; ctx.fillRect(-16,2,32,12);
  ctx.fillStyle='#0099DD'; ctx.fillRect(-16,-11,32,8);
  ctx.fillStyle='#FFF'; ctx.font='bold 4px Arial'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText('kinder',0,-7); ctx.restore();
  ctx.strokeStyle='#C8A060'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.ellipse(0,0,16,11,0,0,Math.PI*2); ctx.stroke();
  ctx.fillStyle='rgba(255,255,255,0.5)';
  ctx.beginPath(); ctx.ellipse(-5,-4,5,3,0,0,Math.PI*2); ctx.fill();
  ctx.restore();

  ctx.fillStyle='#FFF8DC'; ctx.font='bold 15px Arial';
  ctx.fillText(`${col} / ${tot} Schoko Bons`, 48,29);
  ctx.fillStyle='#FFD700'; ctx.font='13px Arial';
  ctx.fillText(`Score: ${score}`, 48,48);

  // Lives (hearts)
  ctx.font='14px Arial';
  const heartX = 160;
  for (let i=0;i<3;i++) {
    ctx.fillStyle = i < lives ? '#E8001C' : '#555';
    ctx.fillText('♥', heartX + i*22, 29);
  }

  // Level name
  ctx.fillStyle='rgba(255,250,205,0.7)'; ctx.font='11px Arial';
  ctx.fillText(`Niveau ${currentLevel+1}: ${levelData.name}`, 12,68);

  // Power-up bars (right side)
  let px = W - 12;
  const drawPBar = (type) => {
    if (!player || player.pu[type] <= 0) return;
    const pct = player.pu[type] / PU[type].dur;
    px -= 58;
    rRect(px,8,52,42,5,'rgba(0,0,0,0.55)',null);
    ctx.fillStyle = PU[type].col;
    const bh = pct * 36;
    ctx.fillRect(px+3, 8+42-3-bh, 46, bh);
    ctx.font='18px Arial'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(PU[type].icon, px+26, 29);
    ctx.textAlign='left'; ctx.textBaseline='alphabetic';
  };
  drawPBar('speed'); drawPBar('doubleJump'); drawPBar('dash'); drawPBar('shield'); drawPBar('ultra');
}

// ============================================================
// QUIZ SCREEN
// ============================================================
function handleQuiz() {
  for (let i=0;i<4;i++) {
    if (just(`Digit${i+1}`) && !quizRevealed) {
      quizSelected = i;
      quizRevealed = true;
      quizTimer    = 200;
      if (i === QUIZZES[currentLevel].ok) {
        score += 100;
        notify('+100 BONUS! Bravo!', '#00FF88');
      }
    }
  }
  if (quizRevealed) {
    quizTimer--;
    if (quizTimer <= 0) {
      quizSelected = -1;
      quizRevealed = false;
      quizTimer    = 0;
      const next = currentLevel + 1;
      if (next < LEVELS.length) loadLevel(next);
      else gameState = 'win';
    }
  }
}

function drawQuiz() {
  ctx.fillStyle='rgba(0,0,0,0.78)'; ctx.fillRect(0,0,W,H);
  rRect(70,50,W-140,H-100,18,'#3D1F0D','#C8860A',2);

  const q = QUIZZES[currentLevel];
  ctx.textAlign='center';

  ctx.fillStyle='#FFD700'; ctx.font='bold 21px Arial';
  ctx.fillText('QUIZ SCHOKO BONS !', W/2, 92);
  ctx.fillStyle='#FAEBD7'; ctx.font='15px Arial';
  ctx.fillText(`Niveau ${currentLevel+1} terminé ! Réponds pour continuer...`, W/2, 118);

  // Question (word-wrap)
  ctx.fillStyle='#FFF8DC'; ctx.font='17px Arial';
  const words=q.q.split(' ');
  let line='', qy=158;
  for (const w of words) {
    const t=line+w+' ';
    if (ctx.measureText(t).width > W-180) { ctx.fillText(line.trim(),W/2,qy); line=w+' '; qy+=26; }
    else line=t;
  }
  ctx.fillText(line.trim(),W/2,qy);

  // Answer options
  const ay0 = 210;
  for (let i=0;i<4;i++) {
    const ay = ay0 + i*55;
    let bg='#5C3317';
    if (quizRevealed) {
      if (i===q.ok)                       bg='#1A7A1A';
      else if (i===quizSelected&&i!==q.ok) bg='#7A1A1A';
    }
    rRect(100,ay,W-200,46,10,bg,'#C8860A',1.5);
    ctx.fillStyle='#FFF8DC'; ctx.font='bold 15px Arial'; ctx.textAlign='left';
    ctx.fillText(`${i+1}.  ${q.a[i]}`, 118, ay+29);
  }

  if (quizRevealed) {
    const ok = quizSelected === q.ok;
    ctx.textAlign='center';
    ctx.fillStyle = ok ? '#00FF88' : '#FF5555';
    ctx.font='bold 16px Arial';
    ctx.fillText(ok ? '✓ Excellent ! Bonne réponse !' : '✗ Oops, mauvaise réponse !', W/2, 444);
    if (!ok) {
      ctx.fillStyle='#FFD700'; ctx.font='13px Arial';
      // Wrap explanation
      const ew=q.expl.split(' ');
      let el='', ey=466;
      for (const w of ew) {
        const t=el+w+' ';
        if (ctx.measureText(t).width>W-180){ctx.fillText(el.trim(),W/2,ey);el=w+' ';ey+=20;}
        else el=t;
      }
      ctx.fillText(el.trim(),W/2,ey);
    }
    ctx.fillStyle='rgba(255,255,255,0.55)'; ctx.font='12px Arial';
    ctx.fillText(`Suite dans ${Math.ceil(quizTimer/60)}s...`, W/2, H-65);
  } else {
    ctx.fillStyle='rgba(255,255,255,0.55)'; ctx.font='14px Arial'; ctx.textAlign='center';
    ctx.fillText('Appuie sur 1, 2, 3 ou 4 pour répondre', W/2, 454);
  }
  ctx.textAlign='left';
}

// ============================================================
// MENU
// ============================================================
function _drawMenuCandy(cx, cy, scale) {
  // Draw a large Schoko-Bon candy (horizontal oval, red twists) for the menu
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(scale, scale);

  const bw = 68, bh = 48;

  // Outer glow
  const glow = ctx.createRadialGradient(0,0,10,0,0,bw+18);
  glow.addColorStop(0,'rgba(200,130,10,0.4)'); glow.addColorStop(1,'rgba(200,130,10,0)');
  ctx.fillStyle=glow; ctx.beginPath(); ctx.ellipse(0,0,bw+18,bh+18,0,0,Math.PI*2); ctx.fill();

  // Shadow
  ctx.fillStyle='rgba(0,0,0,0.25)';
  ctx.beginPath(); ctx.ellipse(4,5,bw,bh,0,0,Math.PI*2); ctx.fill();

  // Left twist
  _drawHorizTwist(-bw, 0, 38, 44, true);
  // Right twist
  _drawHorizTwist(bw, 0, 38, 44, false);

  // Body clip
  ctx.save();
  ctx.beginPath(); ctx.ellipse(0,0,bw,bh,0,0,Math.PI*2); ctx.clip();

  const bg = ctx.createLinearGradient(-bw,-bh, bw*0.3,bh);
  bg.addColorStop(0,'#FFFFFF'); bg.addColorStop(0.4,'#F5EFE5');
  bg.addColorStop(0.75,'#E8DEC8'); bg.addColorStop(1,'#D0C0A0');
  ctx.fillStyle=bg; ctx.fillRect(-bw,-bh,bw*2,bh*2);

  // Chocolate bottom
  ctx.fillStyle='#6B3200';
  ctx.beginPath();
  for (let i=0;i<=8;i++) {
    const wx=-bw+bw*2*i/8, osc=Math.sin(i*1.3+frameCount*0.04)*3;
    i===0?ctx.moveTo(wx,6+osc):ctx.lineTo(wx,6+osc);
  }
  ctx.lineTo(bw,bh); ctx.lineTo(-bw,bh); ctx.closePath(); ctx.fill();

  // Cream highlight blobs
  ctx.fillStyle='rgba(255,250,240,0.6)';
  ctx.beginPath(); ctx.ellipse(10,18,16,11,0.3,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(-12,22,8,6,0.2,0,Math.PI*2); ctx.fill();

  // Blue kinder stripe
  ctx.fillStyle='#0099DD';
  ctx.fillRect(-bw, -bh*0.72, bw*2, bh*0.54);

  // "kinder" text
  ctx.fillStyle='#FFFFFF'; ctx.font='bold 18px Arial';
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText('kinder', 0, -bh*0.46);

  // "Schoko-Bons" text
  ctx.fillStyle='#003D6B'; ctx.font='bold 13px Arial';
  ctx.fillText('Schoko-Bons', 0, 4);

  ctx.restore(); // end clip

  // Outline
  ctx.strokeStyle='#C8A060'; ctx.lineWidth=2;
  ctx.beginPath(); ctx.ellipse(0,0,bw,bh,0,0,Math.PI*2); ctx.stroke();

  // Big specular highlight
  const sh=ctx.createRadialGradient(-bw*0.3,-bh*0.35,0,-bw*0.1,-bh*0.2,bw*0.5);
  sh.addColorStop(0,'rgba(255,255,255,0.65)'); sh.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle=sh;
  ctx.beginPath(); ctx.ellipse(-bw*0.1,-bh*0.2,bw*0.45,bh*0.32,-0.2,0,Math.PI*2); ctx.fill();

  ctx.restore();
}

function drawMenu() {
  // Rich chocolate background
  const g=ctx.createLinearGradient(0,0,0,H);
  g.addColorStop(0,'#6B3010'); g.addColorStop(0.45,'#4A2008'); g.addColorStop(1,'#2A1004');
  ctx.fillStyle=g; ctx.fillRect(0,0,W,H);

  // Subtle grid texture
  ctx.strokeStyle='rgba(255,180,80,0.04)'; ctx.lineWidth=1;
  for (let i=0;i<W;i+=40) { ctx.beginPath(); ctx.moveTo(i,0); ctx.lineTo(i,H); ctx.stroke(); }
  for (let i=0;i<H;i+=40) { ctx.beginPath(); ctx.moveTo(0,i); ctx.lineTo(W,i); ctx.stroke(); }

  // Floating mini Schoko-Bons (background)
  for (let i=0;i<12;i++) {
    const bx=((i*148+frameCount*0.55)%(W+160));
    const by=25+(i*97)%(H-50);
    ctx.globalAlpha=0.07+0.06*Math.sin(frameCount*0.02+i);
    ctx.save(); ctx.translate(bx,by); ctx.scale(0.7,0.7);
    // mini oval
    ctx.fillStyle='#7B3A0C';
    ctx.beginPath(); ctx.ellipse(0,0,22,15,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='rgba(255,255,255,0.45)';
    ctx.beginPath(); ctx.ellipse(-7,-5,8,5,0,0,Math.PI*2); ctx.fill();
    ctx.restore(); ctx.globalAlpha=1;
  }

  // Title with chocolate drip style
  ctx.save();
  const ts=1+0.018*Math.sin(frameCount*0.05);
  ctx.translate(W/2,98); ctx.scale(ts,ts);
  // Shadow
  ctx.fillStyle='rgba(0,0,0,0.55)'; ctx.font='bold 52px Arial'; ctx.textAlign='center';
  ctx.fillText('SCHOKO BONS',3,3);
  // Gold gradient
  const tg=ctx.createLinearGradient(-220,-30,220,30);
  tg.addColorStop(0,'#C8860A'); tg.addColorStop(0.25,'#FFE066');
  tg.addColorStop(0.5,'#FFF8DC'); tg.addColorStop(0.75,'#FFE066'); tg.addColorStop(1,'#C8860A');
  ctx.fillStyle=tg; ctx.fillText('SCHOKO BONS',0,0);
  // Red subtitle
  ctx.fillStyle='#E8001C'; ctx.font='bold 28px Arial';
  ctx.fillText('ADVENTURE',0,40);
  ctx.restore();

  ctx.fillStyle='rgba(255,235,180,0.65)'; ctx.font='14px Arial'; ctx.textAlign='center';
  ctx.fillText('Un univers gourmand et délicieux !', W/2, 170);

  // Large Schoko-Bon candy illustration
  _drawMenuCandy(W/2, 285, 1 + 0.02*Math.sin(frameCount*0.06));

  // Play button
  const pulse=1+0.05*Math.sin(frameCount*0.1);
  ctx.save(); ctx.translate(W/2, H-130); ctx.scale(pulse,pulse);
  // Button shadow
  ctx.fillStyle='rgba(0,0,0,0.4)';
  rRect(-122,-26,248,54,16,'rgba(0,0,0,0.4)',null);
  // Button gradient
  const btnG=ctx.createLinearGradient(-120,-24,120,24);
  btnG.addColorStop(0,'#FF2222'); btnG.addColorStop(0.5,'#E8001C'); btnG.addColorStop(1,'#CC0000');
  rRect(-120,-24,240,50,15,btnG,null);
  rRect(-120,-24,240,22,15,'rgba(255,255,255,0.18)',null);
  ctx.strokeStyle='#FFD700'; ctx.lineWidth=2;
  rRect(-120,-24,240,50,15,null,'#FFD700',2);
  ctx.fillStyle='#FFFFFF'; ctx.font='bold 22px Arial'; ctx.textAlign='center';
  ctx.fillText('▶  JOUER',0,8);
  ctx.restore();

  ctx.fillStyle='rgba(222,184,135,0.8)'; ctx.font='14px Arial'; ctx.textAlign='center';
  ctx.fillText('Appuie sur ENTRÉE ou ESPACE pour commencer', W/2, H-82);
  ctx.fillStyle='rgba(255,255,255,0.4)'; ctx.font='12px Arial';
  ctx.fillText('Flèches / WASD = Déplacer  |  Espace / ↑ = Sauter  |  Double saut !', W/2, H-58);
  ctx.fillStyle='rgba(255,255,255,0.28)'; ctx.font='11px Arial';
  ctx.fillText('Collecte des Schoko Bons · Évite les ennemis · Quiz à chaque fin de niveau', W/2, H-38);
  ctx.textAlign='left';

  if (just('Enter')||just('Space')) {
    score=0; lives=3; loadLevel(0);
  }
}

// ============================================================
// GAME OVER
// ============================================================
function drawGameOver() {
  ctx.fillStyle='rgba(0,0,0,0.88)'; ctx.fillRect(0,0,W,H);
  ctx.fillStyle='#E8001C'; ctx.font='bold 58px Arial'; ctx.textAlign='center';
  ctx.fillText('GAME OVER', W/2, H/2-55);
  ctx.fillStyle='#FFD700'; ctx.font='22px Arial';
  ctx.fillText(`Score final : ${score}`, W/2, H/2+5);
  ctx.fillStyle='#FAEBD7'; ctx.font='16px Arial';
  ctx.fillText('Appuie sur ENTRÉE pour rejouer', W/2, H/2+55);
  ctx.textAlign='left';
  if (just('Enter')||just('Space')) gameState='menu';
}

// ============================================================
// WIN SCREEN
// ============================================================
function drawWin() {
  const g=ctx.createLinearGradient(0,0,0,H);
  g.addColorStop(0,'#FFD700'); g.addColorStop(1,'#FF8C00');
  ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
  // Confetti
  for (let i=0;i<24;i++) {
    const cx2=((i*163+frameCount*2.8)%W), cy2=((i*127+frameCount*2)%H);
    ctx.fillStyle=['#E8001C','#FFFFFF','#5C3317','#FFD700','#00CFFF'][i%5];
    ctx.save(); ctx.translate(cx2,cy2); ctx.rotate(frameCount*0.05+i); ctx.fillRect(-4,-4,8,8); ctx.restore();
  }
  ctx.fillStyle='#3D1F0D'; ctx.font='bold 48px Arial'; ctx.textAlign='center';
  ctx.fillText('VICTOIRE !', W/2, 120);
  ctx.fillStyle='#5C3317'; ctx.font='20px Arial';
  ctx.fillText('Félicitations ! Tu as terminé', W/2,175);
  ctx.fillText('Schoko Bons Adventure !', W/2,202);
  ctx.fillStyle='#E8001C'; ctx.font='bold 26px Arial';
  ctx.fillText(`Score total : ${score}`, W/2,265);
  highScore = Math.max(highScore, score);
  ctx.fillStyle='#5C3317'; ctx.font='16px Arial';
  ctx.fillText(`Meilleur score : ${highScore}`, W/2,300);
  const stars = score > 2500 ? 3 : score > 1200 ? 2 : 1;
  ctx.font='44px Arial'; ctx.fillText('⭐'.repeat(stars), W/2, 360);
  ctx.font='13px Arial'; ctx.fillStyle='rgba(92,51,23,0.7)';
  ctx.fillText(stars===3?'Maître Chocolatier !':stars===2?'Expert Sucré !':'Apprenti Gourmand', W/2,390);
  rRect(W/2-130,H-115,260,52,14,'#E8001C','#FFD700',2);
  ctx.fillStyle='#FFF'; ctx.font='bold 19px Arial'; ctx.fillText('Rejouer', W/2, H-83);
  ctx.textAlign='left';
  if (just('Enter')||just('Space')) gameState='menu';
}

// ============================================================
// MAIN LOOP
// ============================================================
function loop() {
  frameCount++;
  ctx.clearRect(0,0,W,H);

  if (gameState === 'menu')     { drawMenu();     requestAnimationFrame(loop); return; }
  if (gameState === 'gameover') { drawGameOver(); requestAnimationFrame(loop); return; }
  if (gameState === 'win')      { drawWin();      requestAnimationFrame(loop); return; }

  if (gameState === 'quiz') {
    drawBg();
    ctx.save(); ctx.translate(-camera.x, 0);
    lPlatforms.forEach(p => p.draw());
    lCollectibles.forEach(c => c.draw());
    if (player) player.draw();
    ctx.restore();
    handleQuiz();
    drawQuiz();
    requestAnimationFrame(loop); return;
  }

  // ---- PLAYING ----
  // Update
  if (player && !player.dead) player.update();
  lEnemies.forEach(e => e.update());
  lCollectibles.forEach(c => c.update());
  lPowerUps.forEach(p => p.update());
  particles = particles.filter(p => { p.update(); return p.alive; });
  updateNotifications();

  // Camera smooth follow
  if (player) {
    const tx = clamp(player.x - W/2 + player.w/2, 0, levelData.width - W);
    camera.x  = lerp(camera.x, tx, 0.14);
  }

  // Level end trigger
  if (player && !player.dead && lEndZone) {
    if (overlap({ x: player.x, y: player.y, w: player.w, h: player.h },
                { x: lEndZone.x, y: lEndZone.y, w: lEndZone.w, h: lEndZone.h })) {
      gameState    = 'quiz';
      quizSelected = -1;
      quizRevealed = false;
      quizTimer    = 0;
    }
  }

  // Render
  drawBg();
  ctx.save();
  // Camera shake
  if (camera.shake > 0.2) {
    ctx.translate((Math.random()-0.5)*camera.shake, (Math.random()-0.5)*camera.shake*0.6);
    camera.shake *= 0.72;
  } else { camera.shake = 0; }
  ctx.translate(-camera.x, 0);
  lPlatforms.forEach(p => p.draw());
  lCollectibles.forEach(c => c.draw());
  lPowerUps.forEach(p => p.draw());
  lEnemies.forEach(e => e.draw());
  if (player) player.draw();
  particles.forEach(p => p.draw());
  drawEndZone();
  ctx.restore();

  drawHUD();
  drawNotifications();

  requestAnimationFrame(loop);
}

// ============================================================
// BOOT
// ============================================================
loop();

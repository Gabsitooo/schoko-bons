'use strict';

// ============================================================
// CANVAS & CONTEXT
// ============================================================
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const W = canvas.width;   // 800
const H = canvas.height;  // 500

// ============================================================
// PHYSICS CONSTANTS
// ============================================================
const GRAVITY      = 0.5;
const MAX_FALL     = 16;
const PLAYER_SPMAX = 5;
const JUMP_FORCE   = -13;
const FRICTION     = 0.82;

// ============================================================
// GLOBAL STATE
// ============================================================
let gameState      = 'menu';   // menu | playing | quiz | gameover | win
let currentLevel   = 0;
let score          = 0;
let lives          = 3;
let highScore      = 0;
let frameCount     = 0;
let camera         = { x: 0 };
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
  speed:     { col: '#FFD700', icon: '⚡', dur: 320, label: 'Turbo Sucré!'      },
  superJump: { col: '#00CFFF', icon: '🚀', dur: 320, label: 'Super Propulsion!'},
  shield:    { col: '#FFFFFF', icon: '🛡', dur: 420, label: 'Bouclier Crème!'  },
  ultra:     { col: '#FF6600', icon: '⭐', dur: 220, label: 'MODE ULTRA SUCRE!'},
};

// ============================================================
// PLAYER
// ============================================================
class Player {
  constructor(x, y) {
    this.x = x;  this.y = y;
    this.w = 30; this.h = 38;
    this.vx = 0; this.vy = 0;
    this.onGround  = false;
    this.facing    = 1;
    this.jumps     = 0;
    this.maxJumps  = 2;
    this.hp        = 3;
    this.iframes   = 0;
    this.dead      = false;
    this.walkPhase = 0;
    this.pu = { speed: 0, superJump: 0, shield: 0, ultra: 0 };
  }

  get speedMult() { return 1 + (this.pu.speed > 0 ? 0.7 : 0) + (this.pu.ultra > 0 ? 1.0 : 0); }
  get jumpMult()  { return 1 + (this.pu.superJump > 0 ? 0.45 : 0) + (this.pu.ultra > 0 ? 0.25 : 0); }

  update() {
    for (const k in this.pu) if (this.pu[k] > 0) this.pu[k]--;
    if (this.iframes > 0) this.iframes--;

    const spd = PLAYER_SPMAX * this.speedMult;

    if (held('ArrowLeft') || held('KeyA')) {
      this.vx = Math.max(this.vx - 2, -spd);
      this.facing = -1;
      if (this.onGround) this.walkPhase += 0.22;
    } else if (held('ArrowRight') || held('KeyD')) {
      this.vx = Math.min(this.vx + 2, spd);
      this.facing = 1;
      if (this.onGround) this.walkPhase += 0.22;
    } else {
      this.vx *= FRICTION;
      if (Math.abs(this.vx) < 0.1) this.vx = 0;
      this.walkPhase = 0;
    }

    const jumpKey = just('Space') || just('ArrowUp') || just('KeyW');
    if (jumpKey && this.jumps < this.maxJumps) {
      this.vy = JUMP_FORCE * this.jumpMult;
      this.jumps++;
      burst(this.x + this.w/2, this.y + this.h, '#C8860A', 5, 3);
    }

    this.vy = Math.min(this.vy + GRAVITY, MAX_FALL);

    this.x += this.vx;
    this._resolveX();
    this.y += this.vy;
    this.onGround = false;
    this._resolveY();

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
      if (this.vx > 0) this.x = p.x - this.w;
      else              this.x = p.x + p.w;
      this.vx = 0;
    }
  }

  _resolveY() {
    for (const p of lPlatforms) {
      if (!overlap({ x: this.x + 2, y: this.y, w: this.w - 4, h: this.h },
                   { x: p.x, y: p.y, w: p.w, h: p.h })) continue;
      if (this.vy >= 0) {
        this.y = p.y - this.h;
        this.vy = 0;
        this.onGround = true;
        this.jumps = 0;
      } else {
        this.y = p.y + p.h;
        this.vy = 2;
      }
    }
  }

  takeDamage() {
    this.hp--;
    this.iframes = 90;
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

    const cx = this.x + this.w / 2;
    const cy = this.y + this.h / 2;
    const ultra = this.pu.ultra > 0;

    ctx.save();
    ctx.translate(cx, cy);

    // Shield aura
    if (this.pu.shield > 0) {
      ctx.globalAlpha = 0.35 + 0.15 * Math.sin(frameCount * 0.15);
      ctx.fillStyle = '#87CEEB';
      ctx.beginPath(); ctx.arc(0, 0, 26, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#ADD8E6'; ctx.lineWidth = 2;
      ctx.stroke();
    }

    const bodyCol = ultra ? '#FFD700' : '#E8001C';

    // Body
    rRect(-13, -15, 26, 28, 7, bodyCol, null);
    // Kinder white band
    ctx.fillStyle = ultra ? '#FF8800' : '#FFFFFF';
    ctx.fillRect(-13, -3, 26, 7);

    // Face
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(this.facing * 4, -8, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#FFF';
    ctx.beginPath(); ctx.arc(this.facing * 4 + 1, -9, 1, 0, Math.PI * 2); ctx.fill();
    // Smile
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, -4, 5, 0.2, Math.PI - 0.2); ctx.stroke();

    // Legs
    const leg = Math.sin(this.walkPhase * Math.PI * 2) * (this.onGround ? 14 : 0);
    ctx.strokeStyle = '#5C3317'; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.save(); ctx.translate(-6, 13); ctx.rotate(-leg * Math.PI / 180);
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(0, 11); ctx.stroke();
    ctx.fillStyle = '#5C3317'; ctx.beginPath(); ctx.ellipse(0,11,5,2.5,0,0,Math.PI*2); ctx.fill();
    ctx.restore();
    ctx.save(); ctx.translate(6, 13); ctx.rotate(leg * Math.PI / 180);
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(0, 11); ctx.stroke();
    ctx.fillStyle = '#5C3317'; ctx.beginPath(); ctx.ellipse(0,11,5,2.5,0,0,Math.PI*2); ctx.fill();
    ctx.restore();

    // Arms
    const arm = Math.sin(this.walkPhase * Math.PI * 2) * (this.onGround ? 18 : 0);
    ctx.strokeStyle = bodyCol; ctx.lineWidth = 4;
    ctx.save(); ctx.translate(-13, -4); ctx.rotate((-25 + arm) * Math.PI / 180);
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(-7, 9); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.translate(13, -4); ctx.rotate((25 - arm) * Math.PI / 180);
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(7, 9); ctx.stroke(); ctx.restore();

    // Ultra sugar aura
    if (ultra) {
      const cols = ['#FF6600','#FFD700','#FF00FF','#00FFFF'];
      ctx.globalAlpha = 0.55 + 0.3 * Math.sin(frameCount * 0.18);
      for (let i = 0; i < 6; i++) {
        const a = frameCount * 0.06 + i * Math.PI / 3;
        ctx.fillStyle = cols[i % 4];
        ctx.beginPath(); ctx.arc(Math.cos(a)*24, Math.sin(a)*24, 4, 0, Math.PI*2); ctx.fill();
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
    const cx = this.x + this.w/2, cy = this.y + this.h/2;
    ctx.fillStyle = '#5C3317';
    ctx.beginPath(); ctx.arc(cx, cy, 17, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = '#3D1F0D'; ctx.lineWidth = 2;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath(); ctx.moveTo(cx - 8, cy + i*7); ctx.lineTo(cx + 8, cy + i*7); ctx.stroke();
    }
    ctx.fillStyle = '#FF3300';
    const dir = this.vx > 0 ? 1 : -1;
    ctx.beginPath(); ctx.arc(cx + dir*5, cy - 6, 4, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(cx + dir*5, cy - 6, 2, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath(); ctx.arc(cx - 5, cy - 7, 6, 0, Math.PI*2); ctx.fill();
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
    const sq = this.vy > 4 ? 1.25 : (this.vy < -4 ? 0.8 : 1);
    ctx.save(); ctx.translate(cx, cy); ctx.scale(sq, 1/sq);
    ctx.fillStyle = '#8B6914';
    ctx.beginPath(); ctx.ellipse(0, 0, 13, 15, 0, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#6B4F10';
    ctx.beginPath(); ctx.ellipse(0, -10, 7, 5, 0, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = '#5C3A0C'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0,-14); ctx.lineTo(0,13); ctx.stroke();
    ctx.fillStyle = '#FF8800';
    ctx.beginPath(); ctx.arc(-5,-2,3,0,Math.PI*2); ctx.arc(5,-2,3,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(-5,-1,1.5,0,Math.PI*2); ctx.arc(5,-1,1.5,0,Math.PI*2); ctx.fill();
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
    const alert = this.alertT > 0;
    // Body
    rRect(this.x+3, this.y+16, 24, 28, 4, alert ? '#FF3333' : '#CC0000', null);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (let i=0;i<3;i++) ctx.fillRect(this.x+3, this.y+20+i*8, 24, 3);
    // Head
    ctx.fillStyle = '#FFD5B0';
    ctx.beginPath(); ctx.arc(cx, this.y+12, 12, 0, Math.PI*2); ctx.fill();
    // Hat
    ctx.fillStyle = '#CC0000';
    ctx.fillRect(cx-11, this.y-1, 22, 7);
    ctx.fillRect(cx-6,  this.y-10, 12, 11);
    ctx.fillStyle = '#FFF'; ctx.fillRect(cx-11, this.y+4, 22, 3);
    // Eyes
    ctx.fillStyle = alert ? '#FF0000' : '#333';
    ctx.beginPath(); ctx.arc(cx-4,this.y+11,2.2,0,Math.PI*2); ctx.arc(cx+4,this.y+11,2.2,0,Math.PI*2); ctx.fill();
    if (alert) {
      ctx.fillStyle = '#FFD700'; ctx.font = 'bold 15px Arial'; ctx.textAlign = 'center';
      ctx.fillText('!', cx, this.y-13); ctx.textAlign = 'left';
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
    const cy = this.y + Math.sin(this.phase) * 3;
    // Glow
    const g = ctx.createRadialGradient(this.x, cy, 2, this.x, cy, this.r+5);
    g.addColorStop(0, 'rgba(200,134,10,0.35)'); g.addColorStop(1, 'rgba(200,134,10,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(this.x, cy, this.r+5, 0, Math.PI*2); ctx.fill();
    // Body
    const grad = ctx.createRadialGradient(this.x-3, cy-3, 2, this.x, cy, this.r);
    grad.addColorStop(0, '#A0522D'); grad.addColorStop(0.5, '#7B3A0C'); grad.addColorStop(1, '#4A2008');
    ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(this.x, cy, this.r, 0, Math.PI*2); ctx.fill();
    // Highlight
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath(); ctx.arc(this.x-3, cy-3, 4, 0, Math.PI*2); ctx.fill();
    // Sparkle
    if (this.sparkT < 8) {
      ctx.strokeStyle = '#FFD700'; ctx.lineWidth = 1.2;
      for (let i=0;i<4;i++) {
        const a = i*Math.PI/2 + this.sparkT*0.6, len = 5+this.sparkT;
        ctx.beginPath();
        ctx.moveTo(this.x + Math.cos(a)*(this.r+2), cy + Math.sin(a)*(this.r+2));
        ctx.lineTo(this.x + Math.cos(a)*(this.r+len), cy + Math.sin(a)*(this.r+len));
        ctx.stroke();
      }
    }
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
    const y   = this.y + bob;
    const cfg = PU[this.type];
    const g = ctx.createRadialGradient(this.x+14,y+14,3,this.x+14,y+14,22);
    g.addColorStop(0, cfg.col+'88'); g.addColorStop(1, cfg.col+'00');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(this.x+14,y+14,22,0,Math.PI*2); ctx.fill();
    rRect(this.x, y, this.w, this.h, 7, cfg.col, '#FFF', 1.5);
    ctx.font = '16px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(cfg.icon, this.x+14, y+14);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
}

// ============================================================
// PLATFORM
// ============================================================
class Platform {
  constructor(cfg) { Object.assign(this, cfg); this.h = this.h || 20; this.type = this.type || 'chocolate'; }
  draw() {
    const palettes = {
      chocolate: { top:'#8B4513', edge:'#5C3317' },
      cream:     { top:'#FAEBD7', edge:'#C8A870' },
      nougat:    { top:'#C8860A', edge:'#8B6914' },
      ground:    { top:'#6B3A0C', edge:'#3D1F0D' },
    };
    const p = palettes[this.type] || palettes.chocolate;
    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    rRect(this.x+4, this.y+4, this.w, this.h, 4, 'rgba(0,0,0,0.18)', null);
    // Body
    rRect(this.x, this.y, this.w, this.h, 4, p.top, null);
    // Edge
    rRect(this.x, this.y+this.h-6, this.w, 6, 4, p.edge, null);
    // Segments
    ctx.strokeStyle = p.edge; ctx.lineWidth = 1;
    for (let sx = this.x+40; sx < this.x+this.w-5; sx += 40) {
      ctx.beginPath(); ctx.moveTo(sx, this.y+2); ctx.lineTo(sx, this.y+this.h-5); ctx.stroke();
    }
    // Top highlight
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    rRect(this.x+2, this.y+2, this.w-4, 4, 2, 'rgba(255,255,255,0.13)', null);
  }
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
      { x:610,  y:328, type:'speed'     },
      { x:1455, y:248, type:'superJump' },
      { x:2345, y:265, type:'shield'    },
      { x:2830, y:205, type:'ultra'     },
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
      { x:515,  y:340, type:'speed'     },
      { x:1365, y:255, type:'superJump' },
      { x:2445, y:245, type:'shield'    },
      { x:3680, y:335, type:'speed'     },
      { x:4605, y:255, type:'ultra'     },
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
      { x:400,  y:270, type:'speed'     },
      { x:1140, y:258, type:'superJump' },
      { x:2145, y:248, type:'shield'    },
      { x:3245, y:242, type:'speed'     },
      { x:4395, y:238, type:'ultra'     },
      { x:5125, y:160, type:'shield'    },
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
  const g = ctx.createLinearGradient(0,0,0,H);
  g.addColorStop(0, levelData.bgTop);
  g.addColorStop(1, levelData.bgBot);
  ctx.fillStyle = g;
  ctx.fillRect(0,0,W,H);

  // Parallax hills
  ctx.fillStyle = 'rgba(139,69,19,0.12)';
  for (let i=0;i<7;i++) {
    const bx = ((i*260 - camera.x*0.25 % 260) + 2600) % (W+260) - 60;
    ctx.beginPath(); ctx.arc(bx, H-40, 110+i*15, 0, Math.PI, true); ctx.fill();
  }
  // Floating chips (far parallax)
  ctx.fillStyle = 'rgba(92,51,23,0.18)';
  for (let i=0;i<9;i++) {
    const bx = ((i*190+50 - camera.x*0.08) % (W+200) + W+200) % (W+200);
    const by = 40 + (i*83)%180 + Math.sin(frameCount*0.012+i)*8;
    ctx.beginPath(); ctx.arc(bx, by, 6+i%4, 0, Math.PI*2); ctx.fill();
  }
}

// ============================================================
// END ZONE PORTAL
// ============================================================
function drawEndZone() {
  if (!lEndZone) return;
  const {x,y,w,h} = lEndZone;
  const pulse = 1 + 0.08*Math.sin(frameCount*0.1);
  ctx.save();
  ctx.translate(x+w/2, y+h/2);
  ctx.scale(pulse, pulse);

  const g = ctx.createRadialGradient(0,0,5,0,0,38);
  g.addColorStop(0,'rgba(255,215,0,0.85)'); g.addColorStop(1,'rgba(255,100,0,0)');
  ctx.fillStyle=g; ctx.beginPath(); ctx.arc(0,0,38,0,Math.PI*2); ctx.fill();

  rRect(-w/2,-h/2,w,h,6,'#8B4513',null);
  const ig=ctx.createLinearGradient(-w/2,0,w/2,0);
  ig.addColorStop(0,'#FFD700'); ig.addColorStop(0.5,'#FFF8DC'); ig.addColorStop(1,'#FFD700');
  rRect(-w/2+5,-h/2+5,w-10,h-10,4,ig,null);

  ctx.font='28px Arial'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText('⭐',0,0);
  ctx.fillStyle='#5C3317'; ctx.font='bold 10px Arial';
  ctx.fillText('SORTIE',0,h/2+12);
  ctx.textAlign='left'; ctx.textBaseline='alphabetic';
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

  // Schoko Bon icon
  const g=ctx.createRadialGradient(30,24,2,30,24,12);
  g.addColorStop(0,'#A0522D'); g.addColorStop(1,'#4A2008');
  ctx.fillStyle=g; ctx.beginPath(); ctx.arc(30,24,12,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='rgba(255,255,255,0.5)'; ctx.beginPath(); ctx.arc(26,20,4,0,Math.PI*2); ctx.fill();

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
  drawPBar('speed'); drawPBar('superJump'); drawPBar('shield'); drawPBar('ultra');
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
function drawMenu() {
  // BG
  const g=ctx.createLinearGradient(0,0,0,H);
  g.addColorStop(0,'#8B4513'); g.addColorStop(0.5,'#5C3317'); g.addColorStop(1,'#3D1F0D');
  ctx.fillStyle=g; ctx.fillRect(0,0,W,H);

  // Background Schoko Bons floating
  for (let i=0;i<14;i++) {
    const bx = ((i*140+frameCount*0.6) % (W+150));
    const by = 30+(i*91)%(H-60);
    ctx.globalAlpha = 0.08+0.08*Math.sin(frameCount*0.02+i);
    ctx.fillStyle='#A0522D'; ctx.beginPath(); ctx.arc(bx,by,22,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='rgba(255,255,255,0.5)'; ctx.beginPath(); ctx.arc(bx-5,by-5,8,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha=1;
  }

  // Title
  ctx.save();
  const ts = 1+0.02*Math.sin(frameCount*0.05);
  ctx.translate(W/2,115); ctx.scale(ts,ts);
  ctx.fillStyle='#000'; ctx.font='bold 50px Arial'; ctx.textAlign='center'; ctx.fillText('SCHOKO BONS',3,3);
  const tg=ctx.createLinearGradient(-200,-28,200,28);
  tg.addColorStop(0,'#FFD700'); tg.addColorStop(0.5,'#FFF8DC'); tg.addColorStop(1,'#FFD700');
  ctx.fillStyle=tg; ctx.fillText('SCHOKO BONS',0,0);
  ctx.fillStyle='#E8001C'; ctx.font='bold 27px Arial'; ctx.fillText('ADVENTURE',0,38);
  ctx.restore();

  ctx.fillStyle='#FAEBD7'; ctx.font='15px Arial'; ctx.textAlign='center';
  ctx.fillText('Un univers gourmand et délicieux !', W/2,188);

  // Big Schoko Bon
  const bg2=ctx.createRadialGradient(W/2-14,H/2-52,10,W/2,H/2-38,52);
  bg2.addColorStop(0,'#A0522D'); bg2.addColorStop(0.6,'#7B3A0C'); bg2.addColorStop(1,'#4A2008');
  ctx.fillStyle=bg2; ctx.beginPath(); ctx.arc(W/2,H/2-38,52,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='rgba(255,255,255,0.58)'; ctx.beginPath(); ctx.arc(W/2-15,H/2-54,17,0,Math.PI*2); ctx.fill();
  // Kinder ribbon
  ctx.fillStyle='#E8001C'; ctx.fillRect(W/2-62,H/2+26,124,22);
  ctx.fillStyle='#FFF'; ctx.fillRect(W/2-62,H/2+32,124,8);
  ctx.font='bold 11px Arial'; ctx.fillStyle='#E8001C'; ctx.fillText('KINDER',W/2,H/2+44);

  // Play button
  const btnY=H-155, pulse=1+0.05*Math.sin(frameCount*0.1);
  ctx.save(); ctx.translate(W/2,btnY+25); ctx.scale(pulse,pulse);
  rRect(-122,-26,244,52,16,'#E8001C','#FFD700',2);
  ctx.fillStyle='#FFF'; ctx.font='bold 21px Arial'; ctx.textAlign='center';
  ctx.fillText('▶  JOUER', 0, 8);
  ctx.restore();

  ctx.fillStyle='#DEB887'; ctx.font='15px Arial'; ctx.textAlign='center';
  ctx.fillText('Appuie sur ENTRÉE ou ESPACE pour commencer', W/2, H-90);
  ctx.fillStyle='rgba(255,255,255,0.45)'; ctx.font='13px Arial';
  ctx.fillText('Flèches / WASD = Déplacer  |  Espace / ↑ = Sauter  |  Double saut !', W/2, H-65);
  ctx.fillStyle='rgba(255,255,255,0.35)'; ctx.font='12px Arial';
  ctx.fillText('Collecte des Schoko Bons · Évite les ennemis · Quiz à chaque fin de niveau', W/2, H-44);
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
    // Render frozen background
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

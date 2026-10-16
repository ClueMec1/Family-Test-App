// Canvas particle waterfall: name badges + dense dot streams flying up from the bottom.
// Works in a fixed 1920x1080 design space (the stage is scaled as a whole).
const W = 1920;
const H = 1080;
const MAX_BADGES = 90;
const MAX_DOTS = 2200;

export class Particles {
  constructor(canvas) {
    this.c = canvas;
    canvas.width = W;
    canvas.height = H;
    this.g = canvas.getContext('2d');
    this.badges = [];
    this.dots = [];
    this.last = performance.now();
    this.running = false;
    this.font = '700 34px Heebo, Rubik, sans-serif';
  }

  _ensure() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (t) => {
      const dt = Math.min(0.05, (t - this.last) / 1000);
      this.last = t;
      this._step(dt);
      this._draw();
      if (this.badges.length || this.dots.length) requestAnimationFrame(loop);
      else { this.running = false; this.g.clearRect(0, 0, W, H); }
    };
    requestAnimationFrame(loop);
  }

  /** A participant pressed a button. */
  answer({ name, color = '#ffcc33' }) {
    const x = 160 + Math.random() * (W - 320);
    if (this.badges.length >= MAX_BADGES) this.badges.shift();
    this.g.font = this.font;
    const tw = Math.min(360, this.g.measureText(name).width);
    this.badges.push({
      name, color, x, y: H + 40, w: tw + 56, vy: -(260 + Math.random() * 220),
      sway: 30 + Math.random() * 50, phase: Math.random() * 6.28, age: 0, life: 3.6 + Math.random() * 1.2,
    });
    this._stream(x, color, 26);
    this._ensure();
  }

  join({ name, color }) { this.answer({ name, color }); }

  /** Reveal: celebratory upward fountain across the whole width. */
  celebrate(colors = ['#ffcc33', '#ff3d7f', '#22d3ee', '#a3e635']) {
    for (let i = 0; i < 12; i++) {
      this._stream(120 + (i / 11) * (W - 240), colors[i % colors.length], 60, 1.4);
    }
    this._ensure();
  }

  _stream(x, color, n, power = 1) {
    for (let i = 0; i < n; i++) {
      if (this.dots.length >= MAX_DOTS) this.dots.shift();
      this.dots.push({
        x: x + (Math.random() - 0.5) * 80,
        y: H + Math.random() * 60,
        vx: (Math.random() - 0.5) * 160 * power,
        vy: -(380 + Math.random() * 620) * power,
        r: 2 + Math.random() * 5,
        color,
        age: 0,
        life: 1.3 + Math.random() * 1.6,
      });
    }
  }

  _step(dt) {
    for (const b of this.badges) {
      b.age += dt;
      b.y += b.vy * dt;
      b.vy *= 1 - 0.18 * dt;
    }
    this.badges = this.badges.filter((b) => b.age < b.life && b.y > -80);
    for (const d of this.dots) {
      d.age += dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.vy += 140 * dt;        // slight gravity so the stream arcs
      d.vx *= 1 - 0.6 * dt;
    }
    this.dots = this.dots.filter((d) => d.age < d.life);
  }

  _draw() {
    const g = this.g;
    g.clearRect(0, 0, W, H);
    g.globalCompositeOperation = 'lighter';
    for (const d of this.dots) {
      const a = 1 - d.age / d.life;
      g.globalAlpha = a * 0.9;
      g.fillStyle = d.color;
      g.beginPath();
      g.arc(d.x, d.y, d.r * (0.6 + a * 0.6), 0, 6.283);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    g.font = this.font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const b of this.badges) {
      g.direction = /[\u0590-\u05FF]/.test(b.name) ? 'rtl' : 'ltr';
      const t = b.age / b.life;
      const a = t < 0.1 ? t / 0.1 : t > 0.75 ? 1 - (t - 0.75) / 0.25 : 1;
      const s = t < 0.1 ? 0.6 + 0.4 * (t / 0.1) : 1;
      const x = b.x + Math.sin(b.phase + b.age * 2.4) * b.sway;
      g.save();
      g.globalAlpha = Math.max(0, a);
      g.translate(x, b.y);
      g.scale(s, s);
      g.shadowColor = b.color;
      g.shadowBlur = 28;
      g.fillStyle = 'rgba(12,12,22,.82)';
      roundRect(g, -b.w / 2, -30, b.w, 60, 30);
      g.fill();
      g.shadowBlur = 0;
      g.lineWidth = 3;
      g.strokeStyle = b.color;
      g.stroke();
      g.fillStyle = '#fff';
      g.fillText(b.name, 0, 2, b.w - 40);
      g.restore();
    }
    g.globalAlpha = 1;
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

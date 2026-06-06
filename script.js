/**
 * SCRIPT.JS — Edison Bulb v2
 * ════════════════════════════════════════════════════════════
 * - Canvas glow engine (5 layer ray tracing simulasi)
 * - Particle system: debu melayang saat lampu ON
 * - Web Audio API: suara klik saklar realistis
 * - rAF 60fps, delta time, performa mobile aman
 * ════════════════════════════════════════════════════════════
 */
'use strict';

/* ── CONFIG ─────────────────────────────────────────────── */
const CFG = {
  ON_DUR:  300,
  OFF_DUR: 500,

  FILAMENT_OFF:  { r:50,  g:28,  b:0   },
  FILAMENT_WARM: { r:255, g:140, b:0   },
  FILAMENT_HOT:  { r:255, g:210, b:60  },

  GLOW_LAYERS: [
    { radius:0.07, alpha:0.75, color:[255,230,110] },
    { radius:0.16, alpha:0.42, color:[255,185,40]  },
    { radius:0.32, alpha:0.22, color:[255,130,0]   },
    { radius:0.54, alpha:0.10, color:[220,85,0]    },
    { radius:0.82, alpha:0.05, color:[180,55,0]    },
  ],

  RAYS: [
    { angle:90,  spread:40, alpha:0.07 },   // lurus ke bawah (dome ke bawah)
    { angle:75,  spread:22, alpha:0.045 },
    { angle:105, spread:22, alpha:0.045 },
    { angle:60,  spread:16, alpha:0.028 },
    { angle:120, spread:16, alpha:0.028 },
  ],

  /* Partikel debu */
  PARTICLE_COUNT: 55,
  PARTICLE_COLORS: [
    [255,220,100], [255,190,60], [255,150,30], [220,130,0], [255,240,160]
  ],
};

/* ── STATE ──────────────────────────────────────────────── */
const S = {
  isOn: false,
  intensity: 0,
  flicker: false,
  flickerPhase: 0,
  lastTs: 0,
  rafId: null,
  particles: [],
  audioCtx: null,
};

/* ── DOM ────────────────────────────────────────────────── */
const glowCanvas     = document.getElementById('glowCanvas');
const gCtx           = glowCanvas.getContext('2d');
const partCanvas     = document.getElementById('particleCanvas');
const pCtx           = partCanvas.getContext('2d');
const toggleBtn      = document.getElementById('toggleSwitch');
const switchLabel    = document.getElementById('switchLabel');
const scene          = document.querySelector('.scene');
const bulbWrapper    = document.querySelector('.bulb-wrapper');
const filamentWires  = document.querySelectorAll('.filament-wire');
const litGlass       = document.getElementById('litGlass');
const bloomLayer     = document.getElementById('bloomLayer');
const bloomOuter     = document.getElementById('bloomLayerOuter');

/* ── RESIZE ─────────────────────────────────────────────── */
function resize() {
  glowCanvas.width  = partCanvas.width  = window.innerWidth;
  glowCanvas.height = partCanvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

/* ── HELPERS ────────────────────────────────────────────── */
const lerp  = (a,b,t) => a + (b-a)*t;
const clamp = (v,lo,hi) => Math.min(Math.max(v,lo),hi);
const rand  = (lo,hi) => lo + Math.random()*(hi-lo);

/* ── POSISI BOHLAM ──────────────────────────────────────── */
function getBulbCenter() {
  const r = bulbWrapper.getBoundingClientRect();
  return {
    x: r.left + r.width  * 0.5,
    // Bohlam diflip scaleY(-1): dome di bawah, jadi pusat cahaya di bawah wrapper
    y: r.top  + r.height * 0.72,
    radius: Math.min(r.width, r.height) * 0.42,
  };
}

/* ══════════════════════════════════════════════════════════
   AUDIO ENGINE — suara klik saklar via Web Audio API
══════════════════════════════════════════════════════════ */
function initAudio() {
  if (S.audioCtx) return;
  try {
    S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch(e) {
    console.warn('AudioContext tidak didukung:', e);
  }
}

/**
 * Suara klik saklar vintage: noise burst + mechanical thud
 * @param {boolean} turningOn
 */
function playClickSound(turningOn) {
  if (!S.audioCtx) return;
  const ac  = S.audioCtx;
  const now = ac.currentTime;

  /* ── 1. Noise burst (suara "klik" fisik) ── */
  const bufLen = ac.sampleRate * 0.04;
  const buf    = ac.createBuffer(1, bufLen, ac.sampleRate);
  const data   = buf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i/bufLen, 3);
  }
  const noise = ac.createBufferSource();
  noise.buffer = buf;

  /* Bandpass filter: karakter "klik" mekanikal */
  const bp = ac.createBiquadFilter();
  bp.type      = 'bandpass';
  bp.frequency.value = 1800;
  bp.Q.value   = 1.2;

  const gainNoise = ac.createGain();
  gainNoise.gain.setValueAtTime(0.7, now);
  gainNoise.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

  noise.connect(bp);
  bp.connect(gainNoise);
  gainNoise.connect(ac.destination);
  noise.start(now);
  noise.stop(now + 0.05);

  /* ── 2. Thud rendah (bodi saklar) ── */
  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(90, now);
  osc.frequency.exponentialRampToValueAtTime(30, now + 0.06);

  const gainThud = ac.createGain();
  gainThud.gain.setValueAtTime(0.4, now);
  gainThud.gain.exponentialRampToValueAtTime(0.001, now + 0.07);

  osc.connect(gainThud);
  gainThud.connect(ac.destination);
  osc.start(now);
  osc.stop(now + 0.08);

  /* ── 3. Jika ON: suara relay listrik "bzzt" singkat ── */
  if (turningOn) {
    const relayBuf  = ac.createBuffer(1, ac.sampleRate*0.06, ac.sampleRate);
    const relayData = relayBuf.getChannelData(0);
    for (let i = 0; i < relayData.length; i++) {
      // 120Hz buzz (frekuensi PLN)
      relayData[i] = Math.sin(2*Math.PI*120*i/ac.sampleRate)
                   * (Math.random()*0.3+0.7)
                   * Math.pow(1 - i/relayData.length, 1.5) * 0.25;
    }
    const relay     = ac.createBufferSource();
    relay.buffer    = relayBuf;
    const relayGain = ac.createGain();
    relayGain.gain.setValueAtTime(0.35, now+0.03);
    relayGain.gain.exponentialRampToValueAtTime(0.001, now+0.10);
    relay.connect(relayGain);
    relayGain.connect(ac.destination);
    relay.start(now + 0.02);
    relay.stop(now  + 0.12);
  }
}

/* ══════════════════════════════════════════════════════════
   PARTICLE SYSTEM — debu melayang saat lampu ON
══════════════════════════════════════════════════════════ */
function createParticle(cx, cy) {
  const col = CFG.PARTICLE_COLORS[Math.floor(Math.random()*CFG.PARTICLE_COLORS.length)];
  return {
    x:    cx + rand(-80, 80),
    y:    cy + rand(-30, 60),
    vx:   rand(-0.4, 0.4),
    vy:   rand(-0.8, -0.15),      // naik ke atas (melayang dari cahaya)
    size: rand(0.8, 2.8),
    alpha: rand(0.15, 0.55),
    alphaDecay: rand(0.001, 0.003),
    color: col,
    life:  1.0,
    maxLife: rand(3.0, 8.0),      // detik semu
    wobble: rand(0, Math.PI*2),
    wobbleSpeed: rand(0.8, 1.8),
  };
}

function spawnParticles(cx, cy, count) {
  for (let i = 0; i < count; i++) {
    S.particles.push(createParticle(cx, cy));
  }
}

function updateParticles(dt, cx, cy, intensity) {
  /* Spawn partikel baru saat lampu menyala */
  if (intensity > 0.3 && S.isOn) {
    const spawnChance = intensity * 0.4 * dt;
    if (Math.random() < spawnChance && S.particles.length < CFG.PARTICLE_COUNT) {
      S.particles.push(createParticle(cx, cy));
    }
  }

  pCtx.clearRect(0, 0, partCanvas.width, partCanvas.height);

  for (let i = S.particles.length - 1; i >= 0; i--) {
    const p = S.particles[i];

    /* Update posisi */
    p.wobble += p.wobbleSpeed * dt * 0.05;
    p.x  += p.vx + Math.sin(p.wobble) * 0.3;
    p.y  += p.vy;
    p.vy += -0.002; /* buoyancy: makin ringan naik */
    p.alpha -= p.alphaDecay;
    p.life  -= dt * 0.004;

    /* Fade saat lampu mati */
    if (!S.isOn) p.alpha -= 0.008;

    if (p.alpha <= 0 || p.life <= 0) {
      S.particles.splice(i, 1);
      continue;
    }

    /* Gambar partikel */
    const effAlpha = p.alpha * intensity;
    if (effAlpha < 0.01) continue;

    const [r,g,b] = p.color;
    pCtx.save();
    pCtx.globalAlpha = effAlpha;
    pCtx.shadowColor = `rgb(${r},${g},${b})`;
    pCtx.shadowBlur  = p.size * 4;
    pCtx.fillStyle   = `rgb(${r},${g},${b})`;
    pCtx.beginPath();
    pCtx.arc(p.x, p.y, p.size, 0, Math.PI*2);
    pCtx.fill();
    pCtx.restore();
  }
}

/* ══════════════════════════════════════════════════════════
   GLOW CANVAS RENDER
══════════════════════════════════════════════════════════ */
function renderGlow(intensity) {
  const w = glowCanvas.width;
  const h = glowCanvas.height;
  const { x, y, radius } = getBulbCenter();

  gCtx.clearRect(0, 0, w, h);
  if (intensity < 0.002) return;

  const eff = intensity;

  /* ── Ray beams ke bawah (dome menghadap bawah) ── */
  gCtx.save();
  gCtx.globalCompositeOperation = 'screen';
  CFG.RAYS.forEach(ray => {
    const aRad  = (ray.angle * Math.PI) / 180;
    const sRad  = (ray.spread * Math.PI) / 180;
    const len   = h * 0.92;
    const tx    = x + Math.cos(aRad) * radius * 0.25;
    const ty    = y + Math.sin(aRad) * radius * 0.25;
    const alpha = ray.alpha * eff;

    const g = gCtx.createRadialGradient(tx, ty, 0, tx, ty, len);
    g.addColorStop(0,    `rgba(255,210,80,${alpha})`);
    g.addColorStop(0.18, `rgba(255,165,35,${(alpha*0.65).toFixed(3)})`);
    g.addColorStop(0.45, `rgba(230,105,0,${(alpha*0.28).toFixed(3)})`);
    g.addColorStop(1,    `rgba(200,70,0,0)`);

    gCtx.beginPath();
    gCtx.moveTo(tx, ty);
    gCtx.arc(tx, ty, len, aRad - sRad/2, aRad + sRad/2);
    gCtx.closePath();
    gCtx.fillStyle = g;
    gCtx.fill();
  });
  gCtx.restore();

  /* ── Multi-layer radial glow ── */
  gCtx.save();
  gCtx.globalCompositeOperation = 'screen';
  CFG.GLOW_LAYERS.forEach(layer => {
    const r  = layer.radius * Math.max(w, h);
    const a  = layer.alpha  * eff;
    const [cr,cg,cb] = layer.color;
    const g  = gCtx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0,    `rgba(${cr},${cg},${cb},${a})`);
    g.addColorStop(0.38, `rgba(${cr},${cg},${cb},${(a*0.48).toFixed(3)})`);
    g.addColorStop(0.72, `rgba(${cr},${cg},${cb},${(a*0.14).toFixed(3)})`);
    g.addColorStop(1,    `rgba(${cr},${cg},${cb},0)`);
    gCtx.beginPath();
    gCtx.arc(x, y, r, 0, Math.PI*2);
    gCtx.fillStyle = g;
    gCtx.fill();
  });
  gCtx.restore();

  /* ── Bloom corona (terdekat bohlam) ── */
  gCtx.save();
  gCtx.globalCompositeOperation = 'screen';
  gCtx.filter = 'blur(7px)';
  const cR  = radius * (1.35 + 0.35*eff);
  const ca  = 0.60 * eff;
  const cg  = gCtx.createRadialGradient(x, y, radius*0.18, x, y, cR);
  cg.addColorStop(0,   `rgba(255,245,170,${ca})`);
  cg.addColorStop(0.28,`rgba(255,185,45,${(ca*0.58).toFixed(3)})`);
  cg.addColorStop(0.65,`rgba(255,105,0,${(ca*0.20).toFixed(3)})`);
  cg.addColorStop(1,   `rgba(200,60,0,0)`);
  gCtx.beginPath();
  gCtx.arc(x, y, cR, 0, Math.PI*2);
  gCtx.fillStyle = cg;
  gCtx.fill();
  gCtx.filter = 'none';
  gCtx.restore();

  /* ── Global illumination: lantai & dinding ── */
  gCtx.save();
  gCtx.globalCompositeOperation = 'screen';
  // lantai (cahaya ke bawah)
  const flG = gCtx.createRadialGradient(x, h, 0, x, h, w*0.85);
  flG.addColorStop(0,  `rgba(255,145,30,${(0.038*eff).toFixed(3)})`);
  flG.addColorStop(0.5,`rgba(200,80,0,${(0.015*eff).toFixed(3)})`);
  flG.addColorStop(1,  `rgba(0,0,0,0)`);
  gCtx.fillStyle = flG;
  gCtx.fillRect(0, h*0.45, w, h*0.55);
  gCtx.restore();

  /* ── Warm edge shadow ── */
  gCtx.save();
  gCtx.globalCompositeOperation = 'multiply';
  const sdG = gCtx.createRadialGradient(x, y, radius*1.6, x, y, Math.max(w,h)*0.88);
  sdG.addColorStop(0,  `rgba(0,0,0,0)`);
  sdG.addColorStop(0.7,`rgba(0,0,0,${(0.15*eff).toFixed(3)})`);
  sdG.addColorStop(1,  `rgba(0,0,0,${(0.35*eff).toFixed(3)})`);
  gCtx.fillStyle = sdG;
  gCtx.fillRect(0, 0, w, h);
  gCtx.restore();
}

/* ══════════════════════════════════════════════════════════
   FILAMEN COLOR UPDATE
══════════════════════════════════════════════════════════ */
function updateFilament(intensity) {
  const off  = CFG.FILAMENT_OFF;
  const warm = CFG.FILAMENT_WARM;
  const hot  = CFG.FILAMENT_HOT;

  let r, g, b;
  if (intensity < 0.5) {
    const t = intensity * 2;
    r = Math.round(lerp(off.r, warm.r, t));
    g = Math.round(lerp(off.g, warm.g, t));
    b = Math.round(lerp(off.b, warm.b, t));
  } else {
    const t = (intensity - 0.5) * 2;
    r = Math.round(lerp(warm.r, hot.r, t));
    g = Math.round(lerp(warm.g, hot.g, t));
    b = Math.round(lerp(warm.b, hot.b, t));
  }

  const col  = `rgb(${r},${g},${b})`;
  const a    = intensity.toFixed(3);

  filamentWires.forEach(w => {
    w.style.stroke = col;
    if (intensity > 0.02) {
      const g1 = (intensity*5).toFixed(1);
      const g2 = (intensity*12).toFixed(1);
      const g3 = (intensity*24).toFixed(1);
      w.style.filter =
        `drop-shadow(0 0 ${g1}px rgba(255,210,60,${a})) `+
        `drop-shadow(0 0 ${g2}px rgba(255,150,0,${(intensity*0.7).toFixed(3)})) `+
        `drop-shadow(0 0 ${g3}px rgba(255,90,0,${(intensity*0.38).toFixed(3)}))`;
    } else {
      w.style.filter = 'none';
    }
  });

  litGlass.style.opacity = (intensity * 0.38).toFixed(3);
}

/* ══════════════════════════════════════════════════════════
   BLOOM CSS UPDATE
══════════════════════════════════════════════════════════ */
function updateBloom(intensity) {
  bloomLayer.style.opacity = intensity.toFixed(3);
  bloomOuter.style.opacity = (intensity * 0.85).toFixed(3);
  const sc = 1 + intensity * 0.18;
  bloomLayer.style.transform = `translateX(-50%) scale(${sc.toFixed(3)})`;
  bloomOuter.style.transform = `translateX(-50%) scale(${(sc*1.12).toFixed(3)})`;
}

/* ══════════════════════════════════════════════════════════
   MAIN LOOP — requestAnimationFrame
══════════════════════════════════════════════════════════ */
function loop(ts) {
  const dt  = Math.min(ts - (S.lastTs || ts), 50);
  S.lastTs  = ts;

  /* Intensity ramp */
  const dur   = S.isOn ? CFG.ON_DUR : CFG.OFF_DUR;
  const delta = dt / dur;
  S.intensity = S.isOn
    ? clamp(S.intensity + delta, 0, 1)
    : clamp(S.intensity - delta, 0, 1);

  /* Flicker saat baru menyala */
  let flicker = 0;
  if (S.flicker) {
    S.flickerPhase += dt * 0.055;
    flicker = Math.sin(S.flickerPhase * 7.8) * 0.5 + 0.5;
    if (S.flickerPhase > 10) { S.flicker = false; S.flickerPhase = 0; }
  }
  const eff = S.intensity * (1 - flicker * 0.09);

  renderGlow(eff);

  const { x, y } = getBulbCenter();
  updateParticles(dt, x, y, eff);
  updateFilament(eff);
  updateBloom(eff);

  /* Sync body class */
  if (S.isOn) {
    scene.classList.add('is-on');
    document.body.classList.add('is-on');
  } else if (S.intensity < 0.01) {
    scene.classList.remove('is-on');
    document.body.classList.remove('is-on');
  }

  const still =
    (S.isOn && S.intensity < 1) ||
    (!S.isOn && S.intensity > 0) ||
    S.flicker ||
    S.particles.length > 0;

  S.rafId = still ? requestAnimationFrame(loop) : null;
}

function startLoop() {
  if (S.rafId) return;
  S.lastTs = performance.now();
  S.rafId  = requestAnimationFrame(loop);
}

/* ══════════════════════════════════════════════════════════
   TOGGLE
══════════════════════════════════════════════════════════ */
function toggle() {
  initAudio();
  S.isOn = !S.isOn;

  playClickSound(S.isOn);

  toggleBtn.setAttribute('aria-checked', S.isOn ? 'true' : 'false');
  switchLabel.textContent = S.isOn ? 'ON' : 'OFF';

  if (S.isOn) {
    S.flicker = true;
    S.flickerPhase = 0;
    scene.classList.add('is-on');
    document.body.classList.add('is-on');

    /* Burst partikel awal saat nyala */
    const { x, y } = getBulbCenter();
    spawnParticles(x, y, 18);
  } else {
    /* Partikel akan fade sendiri karena intensity turun */
  }

  startLoop();
}

/* ── EVENTS ─────────────────────────────────────────────── */
toggleBtn.addEventListener('click',   toggle);
toggleBtn.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
});
bulbWrapper.addEventListener('click', toggle);

/* ── INIT ───────────────────────────────────────────────── */
renderGlow(0);

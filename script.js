/**
 * SCRIPT.JS — Edison Bulb Interactive
 * ════════════════════════════════════════════════════════════
 * Sistem pencahayaan real-time menggunakan Canvas API.
 * Mensimulasikan:
 *  - Volumetric glow (beberapa radial gradient berlapis)
 *  - Global illumination palsu (ambient room light)
 *  - Bloom effect dengan gaussian blur via komposit layer
 *  - Warm shadow pada background
 *  - Ray tracing simulasi via gradient cone rays
 * ════════════════════════════════════════════════════════════
 */

'use strict';

/* ──────────────────────────────────────────────────────────
   KONSTANTA & KONFIGURASI
────────────────────────────────────────────────────────── */
const CONFIG = {
  /* Durasi transisi (ms) — cocok dengan CSS */
  ON_DURATION:  300,
  OFF_DURATION: 500,

  /* Target FPS */
  TARGET_FPS: 60,

  /* Warna filamen dalam berbagai keadaan */
  FILAMENT_OFF:  { r: 58,  g: 34,  b: 0   },
  FILAMENT_WARM: { r: 255, g: 149, b: 0   },
  FILAMENT_HOT:  { r: 255, g: 204, b: 68  },

  /* Intensitas glow maksimum (0-1) per layer */
  GLOW_LAYERS: [
    { radius: 0.08, alpha: 0.70, color: [255, 220, 100] },   // inti panas
    { radius: 0.18, alpha: 0.40, color: [255, 180, 40]  },   // halo dekat
    { radius: 0.35, alpha: 0.20, color: [255, 130, 0]   },   // bloom medium
    { radius: 0.55, alpha: 0.10, color: [220, 90,  0]   },   // scatter luar
    { radius: 0.80, alpha: 0.05, color: [180, 60,  0]   },   // ambient room
  ],

  /* Sinar cahaya (ray tracing simulasi) */
  RAYS: [
    { angle: -90,  spread: 35, alpha: 0.06 },   // lurus ke atas
    { angle: -75,  spread: 20, alpha: 0.04 },
    { angle: -105, spread: 20, alpha: 0.04 },
    { angle: -60,  spread: 15, alpha: 0.025 },
    { angle: -120, spread: 15, alpha: 0.025 },
  ],
};

/* ──────────────────────────────────────────────────────────
   STATE
────────────────────────────────────────────────────────── */
const state = {
  isOn: false,
  intensity: 0,        // 0.0 (mati) → 1.0 (penuh)
  flickerPhase: 0,     // untuk efek flicker awal
  flickerActive: false,
  lastTimestamp: 0,
  animFrameId: null,
};

/* ──────────────────────────────────────────────────────────
   DOM REFERENCES
────────────────────────────────────────────────────────── */
const canvas        = document.getElementById('glowCanvas');
const ctx           = canvas.getContext('2d');
const toggleBtn     = document.getElementById('toggleSwitch');
const switchLabel   = document.getElementById('switchLabel');
const scene         = document.querySelector('.scene');
const bulbWrapper   = document.querySelector('.bulb-wrapper');
const filamentWires = document.querySelectorAll('.filament-wire');
const litGlass      = document.getElementById('litGlass');
const bloomLayer    = document.getElementById('bloomLayer');
const bloomOuter    = document.getElementById('bloomLayerOuter');

/* ──────────────────────────────────────────────────────────
   CANVAS RESIZE — responsif, selalu pas viewport
────────────────────────────────────────────────────────── */
function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

/* ──────────────────────────────────────────────────────────
   HELPER: Posisi pusat bohlam dalam koordinat halaman
────────────────────────────────────────────────────────── */
function getBulbCenter() {
  const rect = bulbWrapper.getBoundingClientRect();
  return {
    x: rect.left + rect.width  * 0.5,
    y: rect.top  + rect.height * 0.40,   // sedikit di atas tengah (di area filamen)
    r: Math.max(rect.width, rect.height) * 0.5,
  };
}

/* ──────────────────────────────────────────────────────────
   HELPER: Lerp & clamp
────────────────────────────────────────────────────────── */
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }
function easeIn(t) { return t * t * t; }
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

/* ──────────────────────────────────────────────────────────
   CANVAS RENDER — core rendering loop
────────────────────────────────────────────────────────── */
function renderGlow(intensity, flicker) {
  const w = canvas.width;
  const h = canvas.height;
  const { x, y, r } = getBulbCenter();

  /* Bersihkan canvas setiap frame */
  ctx.clearRect(0, 0, w, h);

  if (intensity < 0.001) return; /* skip jika hampir mati */

  /* ── intensitas efektif dengan flicker kecil ── */
  const effIntensity = intensity * (1 - flicker * 0.08);

  /* ── 1. RAY SIMULATION (volumetric light beams) ──────── */
  ctx.save();
  ctx.globalCompositeOperation = 'screen';

  CONFIG.RAYS.forEach(ray => {
    const angleRad  = (ray.angle * Math.PI) / 180;
    const spreadRad = (ray.spread * Math.PI) / 180;
    const rayLen    = h * 0.9;

    /* Titik ujung sinar (dari pusat bohlam ke atas) */
    const tipX = x + Math.cos(angleRad) * r * 0.3;
    const tipY = y + Math.sin(angleRad) * r * 0.3;

    /* Buat sinar sebagai cone gradient */
    const grad = ctx.createRadialGradient(tipX, tipY, 0, tipX, tipY, rayLen);
    const a = ray.alpha * effIntensity;
    grad.addColorStop(0,    `rgba(255, 200, 80, ${a})`);
    grad.addColorStop(0.15, `rgba(255, 160, 40, ${a * 0.7})`);
    grad.addColorStop(0.40, `rgba(230, 110, 0,  ${a * 0.3})`);
    grad.addColorStop(1,    `rgba(200, 80,  0,  0)`);

    ctx.beginPath();
    /* Cone: arc dari sudut-spread/2 ke sudut+spread/2 */
    ctx.moveTo(tipX, tipY);
    ctx.arc(tipX, tipY, rayLen,
      angleRad - spreadRad / 2,
      angleRad + spreadRad / 2
    );
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  });

  ctx.restore();

  /* ── 2. RADIAL GLOW LAYERS (multi-pass) ──────────────── */
  ctx.save();
  ctx.globalCompositeOperation = 'screen';

  CONFIG.GLOW_LAYERS.forEach(layer => {
    const radius = layer.radius * Math.max(w, h);
    const alpha  = layer.alpha  * effIntensity;
    const [cr, cg, cb] = layer.color;

    const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
    grad.addColorStop(0,    `rgba(${cr}, ${cg}, ${cb}, ${alpha})`);
    grad.addColorStop(0.4,  `rgba(${cr}, ${cg}, ${cb}, ${alpha * 0.5})`);
    grad.addColorStop(0.75, `rgba(${cr}, ${cg}, ${cb}, ${alpha * 0.15})`);
    grad.addColorStop(1,    `rgba(${cr}, ${cg}, ${cb}, 0)`);

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
  });

  ctx.restore();

  /* ── 3. BLOOM CORONA (cahaya sangat dekat bohlam) ─────── */
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.filter = 'blur(8px)';

  const coronaR = r * 1.4 * effIntensity + r * 0.8;
  const corona  = ctx.createRadialGradient(x, y, r * 0.2, x, y, coronaR);
  const ca = 0.55 * effIntensity;
  corona.addColorStop(0,   `rgba(255, 240, 160, ${ca})`);
  corona.addColorStop(0.3, `rgba(255, 180, 40,  ${ca * 0.6})`);
  corona.addColorStop(0.7, `rgba(255, 100, 0,   ${ca * 0.2})`);
  corona.addColorStop(1,   `rgba(200, 60,  0,   0)`);

  ctx.beginPath();
  ctx.arc(x, y, coronaR, 0, Math.PI * 2);
  ctx.fillStyle = corona;
  ctx.fill();

  ctx.filter = 'none';
  ctx.restore();

  /* ── 4. GLOBAL ILLUMINATION — lantai dan dinding ─────── */
  ctx.save();
  ctx.globalCompositeOperation = 'screen';

  /* Pantulan ke dinding atas */
  const wallGrad = ctx.createLinearGradient(x, 0, x, h * 0.5);
  const wa = 0.04 * effIntensity;
  wallGrad.addColorStop(0,   `rgba(255, 160, 40, 0)`);
  wallGrad.addColorStop(0.5, `rgba(255, 120, 20, ${wa})`);
  wallGrad.addColorStop(1,   `rgba(200, 80,  0,  0)`);

  ctx.fillStyle = wallGrad;
  ctx.fillRect(0, 0, w, h * 0.5);

  /* Pantulan ke lantai / bawah */
  const floorGrad = ctx.createRadialGradient(x, h, 0, x, h, w * 0.8);
  const fa = 0.03 * effIntensity;
  floorGrad.addColorStop(0,   `rgba(255, 140, 30, ${fa})`);
  floorGrad.addColorStop(0.5, `rgba(200, 80,  0,  ${fa * 0.4})`);
  floorGrad.addColorStop(1,   `rgba(0, 0, 0,      0)`);

  ctx.fillStyle = floorGrad;
  ctx.fillRect(0, h * 0.5, w, h * 0.5);

  ctx.restore();

  /* ── 5. SOFT WARM SHADOW — bayangan hangat di belakang ── */
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';

  /* Area shadow "menghitam" sedikit di tepi jauh */
  const shadowGrad = ctx.createRadialGradient(x, y, r * 1.5, x, y, Math.max(w, h) * 0.8);
  const sa = 0.25 * effIntensity;
  shadowGrad.addColorStop(0,   `rgba(0, 0, 0, 0)`);
  shadowGrad.addColorStop(0.5, `rgba(0, 0, 0, 0)`);
  shadowGrad.addColorStop(0.8, `rgba(0, 0, 0, ${sa * 0.3})`);
  shadowGrad.addColorStop(1,   `rgba(0, 0, 0, ${sa})`);

  ctx.fillStyle = shadowGrad;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();
}

/* ──────────────────────────────────────────────────────────
   UPDATE FILAMEN — interpolasi warna berdasarkan intensitas
────────────────────────────────────────────────────────── */
function updateFilamentColor(intensity) {
  const off  = CONFIG.FILAMENT_OFF;
  const warm = CONFIG.FILAMENT_WARM;
  const hot  = CONFIG.FILAMENT_HOT;

  let r, g, b;

  if (intensity < 0.5) {
    /* OFF → WARM */
    const t = intensity * 2;
    r = Math.round(lerp(off.r, warm.r, t));
    g = Math.round(lerp(off.g, warm.g, t));
    b = Math.round(lerp(off.b, warm.b, t));
  } else {
    /* WARM → HOT */
    const t = (intensity - 0.5) * 2;
    r = Math.round(lerp(warm.r, hot.r, t));
    g = Math.round(lerp(warm.g, hot.g, t));
    b = Math.round(lerp(warm.b, hot.b, t));
  }

  const color     = `rgb(${r}, ${g}, ${b})`;
  const glowAlpha = intensity.toFixed(3);

  /* Terapkan ke setiap elemen filamen */
  filamentWires.forEach(wire => {
    wire.style.stroke = color;
    if (intensity > 0.01) {
      /* Glow makin kuat seiring intensitas */
      const g1 = (intensity * 4).toFixed(2);
      const g2 = (intensity * 10).toFixed(2);
      const g3 = (intensity * 20).toFixed(2);
      wire.style.filter =
        `drop-shadow(0 0 ${g1}px rgba(255,204,68,${glowAlpha})) ` +
        `drop-shadow(0 0 ${g2}px rgba(255,153,0,${(glowAlpha*0.7).toFixed(3)})) ` +
        `drop-shadow(0 0 ${g3}px rgba(255,100,0,${(glowAlpha*0.4).toFixed(3)}))`;
    } else {
      wire.style.filter = 'none';
    }
  });

  /* Update opacity kaca panas */
  litGlass.style.opacity = (intensity * 0.35).toFixed(3);
}

/* ──────────────────────────────────────────────────────────
   UPDATE BLOOM CSS — sinkron dengan intensitas Canvas
────────────────────────────────────────────────────────── */
function updateBloomCSS(intensity) {
  const op1 = (intensity * 1.0).toFixed(3);
  const op2 = (intensity * 0.8).toFixed(3);
  bloomLayer.style.opacity  = op1;
  bloomOuter.style.opacity  = op2;

  /* Scale sedikit membesar saat intensitas penuh */
  const scale = 1 + intensity * 0.15;
  bloomLayer.style.transform  = `translateX(-50%) scale(${scale.toFixed(3)})`;
  bloomOuter.style.transform  = `translateX(-50%) scale(${(scale * 1.1).toFixed(3)})`;
}

/* ──────────────────────────────────────────────────────────
   MAIN ANIMATION LOOP — requestAnimationFrame 60fps
────────────────────────────────────────────────────────── */
function animate(timestamp) {
  /* Delta time dalam ms, cap di 50ms untuk mencegah jump besar */
  const dt = Math.min(timestamp - (state.lastTimestamp || timestamp), 50);
  state.lastTimestamp = timestamp;

  /* Hitung laju perubahan intensitas berdasarkan state */
  const duration = state.isOn ? CONFIG.ON_DURATION : CONFIG.OFF_DURATION;
  const delta    = (dt / duration);

  if (state.isOn) {
    state.intensity = clamp(state.intensity + delta, 0, 1);
  } else {
    state.intensity = clamp(state.intensity - delta, 0, 1);
  }

  /* Efek flicker kecil (hanya saat baru menyala) */
  let flickerValue = 0;
  if (state.flickerActive) {
    state.flickerPhase += dt * 0.05;
    flickerValue = Math.sin(state.flickerPhase * 7.3) * 0.5 + 0.5;
    /* Matikan flicker setelah phase tertentu */
    if (state.flickerPhase > 12) {
      state.flickerActive = false;
      state.flickerPhase  = 0;
    }
  }

  /* Render canvas dengan intensitas saat ini */
  renderGlow(state.intensity, flickerValue);

  /* Update warna filamen */
  updateFilamentColor(state.intensity);

  /* Update bloom CSS */
  updateBloomCSS(state.intensity);

  /* Update body class untuk ambient (hanya satu kali saat berubah, tapi perlu sync) */
  const bodyOn = document.body.classList.contains('is-on');
  if (state.isOn && !bodyOn) {
    document.body.classList.add('is-on');
    scene.classList.add('is-on');
  } else if (!state.isOn && bodyOn && state.intensity < 0.01) {
    document.body.classList.remove('is-on');
    scene.classList.remove('is-on');
  }

  /* Teruskan loop selama masih berubah */
  const isChanging =
    (state.isOn  && state.intensity < 1.0) ||
    (!state.isOn && state.intensity > 0.0) ||
    state.flickerActive;

  if (isChanging) {
    state.animFrameId = requestAnimationFrame(animate);
  } else {
    state.animFrameId = null;
  }
}

/* ──────────────────────────────────────────────────────────
   MULAI / HENTIKAN ANIMASI
────────────────────────────────────────────────────────── */
function startAnimation() {
  if (state.animFrameId) return; /* sudah berjalan */
  state.lastTimestamp = performance.now();
  state.animFrameId   = requestAnimationFrame(animate);
}

/* ──────────────────────────────────────────────────────────
   TOGGLE LAMPU
────────────────────────────────────────────────────────── */
function toggleLight() {
  state.isOn = !state.isOn;

  /* Update ARIA dan label */
  toggleBtn.setAttribute('aria-checked', state.isOn ? 'true' : 'false');
  switchLabel.textContent = state.isOn ? 'ON' : 'OFF';

  if (state.isOn) {
    /* Aktifkan flicker saat menyala */
    state.flickerActive = true;
    state.flickerPhase  = 0;

    /* Tambahkan class segera untuk CSS transition */
    scene.classList.add('is-on');
    document.body.classList.add('is-on');
  } else {
    /* Hapus class — CSS transition akan berlaku */
    /* (scene.classList.remove dijalankan di loop saat intensitas mendekati 0) */
  }

  /* Mulai (atau lanjutkan) animasi */
  startAnimation();
}

/* ──────────────────────────────────────────────────────────
   EVENT LISTENERS
────────────────────────────────────────────────────────── */
toggleBtn.addEventListener('click', toggleLight);

/* Keyboard accessibility: Enter / Space */
toggleBtn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    toggleLight();
  }
});

/* Klik di mana saja pada bohlam juga toggle (UX lebih baik) */
bulbWrapper.addEventListener('click', toggleLight);

/* ──────────────────────────────────────────────────────────
   RENDER AWAL — pastikan canvas menggambar (state OFF)
────────────────────────────────────────────────────────── */
renderGlow(0, 0);

/* ──────────────────────────────────────────────────────────
   HINT LABEL FADE SETELAH PERTAMA KALI DIGUNAKAN
────────────────────────────────────────────────────────── */
(function setupHint() {
  const hint = document.querySelector('.hint-text');
  let used = false;
  function hideHint() {
    if (!used) {
      used = true;
      hint.style.opacity = '0';
      setTimeout(() => { hint.style.display = 'none'; }, 600);
    }
  }
  toggleBtn.addEventListener('click', hideHint, { once: true });
  bulbWrapper.addEventListener('click', hideHint, { once: true });
})();

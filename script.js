/**
 * SCRIPT.JS — Edison Bulb v3
 * - Single SVG: kabel+socket+globe sudah menyatu di HTML
 * - Toggle: aria-checked dikelola satu sumber kebenaran
 * - Glow lebih terang (alpha dinaikkan)
 * - Ray cahaya hanya ke atas (TIDAK ke bawah)
 * - Partikel debu melayang ke atas saat ON
 * - Suara klik via Web Audio API
 */
'use strict';

/* ── CONFIG ─────────────────────────────────────────────── */
const CFG = {
  ON_DUR:  300,
  OFF_DUR: 480,

  FILAMENT_OFF:  {r:45, g:24, b:0},
  FILAMENT_WARM: {r:255,g:145,b:0},
  FILAMENT_HOT:  {r:255,g:215,b:65},

  /* Layer glow — alpha lebih besar dari v2 */
  GLOW_LAYERS: [
    {radius:0.08, alpha:0.90, color:[255,235,115]},
    {radius:0.20, alpha:0.55, color:[255,190,42]},
    {radius:0.38, alpha:0.30, color:[255,135,0]},
    {radius:0.60, alpha:0.14, color:[225,90,0]},
    {radius:0.88, alpha:0.07, color:[185,58,0]},
  ],

  /* Sinar HANYA ke atas (angle 270° = atas, tidak ada yang ke bawah) */
  RAYS: [
    {angle:270, spread:44, alpha:0.09},
    {angle:253, spread:24, alpha:0.055},
    {angle:287, spread:24, alpha:0.055},
    {angle:238, spread:18, alpha:0.032},
    {angle:302, spread:18, alpha:0.032},
  ],

  PARTICLE_MAX: 60,
  PARTICLE_COLS: [
    [255,225,100],[255,195,62],[255,155,32],[222,132,0],[255,245,160]
  ],
};

/* ── STATE ──────────────────────────────────────────────── */
const S = {
  isOn:    false,
  intensity: 0,
  flicker: false,
  flickerPhase: 0,
  lastTs:  0,
  rafId:   null,
  particles: [],
  audioCtx: null,
};

/* ── DOM ────────────────────────────────────────────────── */
const glowCanvas   = document.getElementById('glowCanvas');
const gCtx         = glowCanvas.getContext('2d');
const partCanvas   = document.getElementById('particleCanvas');
const pCtx         = partCanvas.getContext('2d');
const toggleBtn    = document.getElementById('toggleSwitch');
const scene        = document.querySelector('.scene');
const lampWrap     = document.querySelector('.lamp-wrap');
const filWires     = document.querySelectorAll('.filament-wire');
const litGlass     = document.getElementById('litGlass');
const bloom        = document.getElementById('bloomLayer');
const bloomOut     = document.getElementById('bloomLayerOuter');

/* ── RESIZE ─────────────────────────────────────────────── */
function resize() {
  glowCanvas.width  = partCanvas.width  = window.innerWidth;
  glowCanvas.height = partCanvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

/* ── HELPERS ────────────────────────────────────────────── */
const lerp  = (a,b,t) => a+(b-a)*t;
const clamp = (v,lo,hi) => Math.min(Math.max(v,lo),hi);
const rand  = (lo,hi) => lo+Math.random()*(hi-lo);

/* Pusat cahaya = tengah globe SVG.
   Globe ada dari Y≈38% sampai Y≈92% dari lamp-wrap.
   Pusat globe ≈ Y 65% dari lamp-wrap. */
function getLightPos() {
  const r = lampWrap.getBoundingClientRect();
  return {
    x: r.left + r.width * 0.5,
    y: r.top  + r.height * 0.65,
    radius: r.width * 0.43,
  };
}

/* ══════════════════════════════════════════════════════════
   AUDIO
══════════════════════════════════════════════════════════ */
function initAudio() {
  if (S.audioCtx) return;
  try { S.audioCtx = new (window.AudioContext||window.webkitAudioContext)(); }
  catch(e) {}
}

function playClick(on) {
  const ac = S.audioCtx;
  if (!ac) return;
  const t = ac.currentTime;

  /* Noise burst — klik mekanikal */
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate*0.045), ac.sampleRate);
  const d   = buf.getChannelData(0);
  for (let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,3);
  const n = ac.createBufferSource(); n.buffer = buf;
  const bp = ac.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=1900; bp.Q.value=1.1;
  const gn = ac.createGain(); gn.gain.setValueAtTime(0.75,t); gn.gain.exponentialRampToValueAtTime(0.001,t+0.045);
  n.connect(bp); bp.connect(gn); gn.connect(ac.destination);
  n.start(t); n.stop(t+0.05);

  /* Thud badan saklar */
  const os = ac.createOscillator(); os.type='sine';
  os.frequency.setValueAtTime(85,t); os.frequency.exponentialRampToValueAtTime(28,t+0.065);
  const gt = ac.createGain(); gt.gain.setValueAtTime(0.42,t); gt.gain.exponentialRampToValueAtTime(0.001,t+0.075);
  os.connect(gt); gt.connect(ac.destination);
  os.start(t); os.stop(t+0.08);

  /* Relay buzz saat ON */
  if (on) {
    const rb = ac.createBuffer(1, Math.floor(ac.sampleRate*0.065), ac.sampleRate);
    const rd = rb.getChannelData(0);
    for (let i=0;i<rd.length;i++)
      rd[i]=Math.sin(2*Math.PI*120*i/ac.sampleRate)*(Math.random()*0.3+0.7)*Math.pow(1-i/rd.length,1.4)*0.28;
    const rs = ac.createBufferSource(); rs.buffer=rb;
    const rg = ac.createGain(); rg.gain.setValueAtTime(0.38,t+0.025); rg.gain.exponentialRampToValueAtTime(0.001,t+0.105);
    rs.connect(rg); rg.connect(ac.destination);
    rs.start(t+0.018); rs.stop(t+0.115);
  }
}

/* ══════════════════════════════════════════════════════════
   PARTICLES — melayang ke atas dari cahaya
══════════════════════════════════════════════════════════ */
function makeParticle(cx,cy) {
  const col = CFG.PARTICLE_COLS[Math.floor(Math.random()*CFG.PARTICLE_COLS.length)];
  return {
    x: cx+rand(-70,70),
    y: cy+rand(-20,40),
    vx: rand(-0.35,0.35),
    vy: rand(-0.75,-0.15),
    sz: rand(0.7,2.6),
    alpha: rand(0.18,0.55),
    decay: rand(0.0012,0.0032),
    color: col,
    life: 1.0,
    wobble: rand(0,Math.PI*2),
    wobbleSpd: rand(0.8,1.9),
  };
}

function updateParticles(dt, cx, cy, eff) {
  /* Spawn baru hanya saat ON */
  if (S.isOn && eff>0.28 && S.particles.length<CFG.PARTICLE_MAX) {
    if (Math.random()<eff*0.38*dt) S.particles.push(makeParticle(cx,cy));
  }

  pCtx.clearRect(0,0,partCanvas.width,partCanvas.height);

  for (let i=S.particles.length-1;i>=0;i--) {
    const p=S.particles[i];
    p.wobble+=p.wobbleSpd*dt*0.05;
    p.x+=p.vx+Math.sin(p.wobble)*0.28;
    p.y+=p.vy;
    p.vy-=0.0018;
    p.alpha-=p.decay;
    if (!S.isOn) p.alpha-=0.007;
    if (p.alpha<=0){ S.particles.splice(i,1); continue; }

    const ea=p.alpha*eff;
    if (ea<0.01) continue;
    const [r,g,b]=p.color;
    pCtx.save();
    pCtx.globalAlpha=ea;
    pCtx.shadowColor=`rgb(${r},${g},${b})`;
    pCtx.shadowBlur=p.sz*5;
    pCtx.fillStyle=`rgb(${r},${g},${b})`;
    pCtx.beginPath();
    pCtx.arc(p.x,p.y,p.sz,0,Math.PI*2);
    pCtx.fill();
    pCtx.restore();
  }
}

/* ══════════════════════════════════════════════════════════
   GLOW CANVAS — lebih terang, ray hanya ke atas, tidak ke bawah
══════════════════════════════════════════════════════════ */
function renderGlow(eff) {
  const W=glowCanvas.width, H=glowCanvas.height;
  const {x,y,radius}=getLightPos();
  gCtx.clearRect(0,0,W,H);
  if (eff<0.002) return;

  /* ── Ray beams (ke atas saja) ── */
  gCtx.save();
  gCtx.globalCompositeOperation='screen';
  CFG.RAYS.forEach(ray=>{
    const aRad=(ray.angle*Math.PI)/180;
    const sRad=(ray.spread*Math.PI)/180;
    const len=H*0.90;
    const tx=x+Math.cos(aRad)*radius*0.22;
    const ty=y+Math.sin(aRad)*radius*0.22;
    const a=ray.alpha*eff;
    const g=gCtx.createRadialGradient(tx,ty,0,tx,ty,len);
    g.addColorStop(0,   `rgba(255,215,82,${a.toFixed(3)})`);
    g.addColorStop(0.18,`rgba(255,168,36,${(a*0.62).toFixed(3)})`);
    g.addColorStop(0.46,`rgba(230,108,0,${(a*0.26).toFixed(3)})`);
    g.addColorStop(1,   `rgba(200,68,0,0)`);
    gCtx.beginPath();
    gCtx.moveTo(tx,ty);
    gCtx.arc(tx,ty,len,aRad-sRad/2,aRad+sRad/2);
    gCtx.closePath();
    gCtx.fillStyle=g;
    gCtx.fill();
  });
  gCtx.restore();

  /* ── Multi-layer radial glow ── */
  gCtx.save();
  gCtx.globalCompositeOperation='screen';
  CFG.GLOW_LAYERS.forEach(layer=>{
    const r=layer.radius*Math.max(W,H);
    const a=layer.alpha*eff;
    const [cr,cg,cb]=layer.color;
    const g=gCtx.createRadialGradient(x,y,0,x,y,r);
    g.addColorStop(0,   `rgba(${cr},${cg},${cb},${a.toFixed(3)})`);
    g.addColorStop(0.38,`rgba(${cr},${cg},${cb},${(a*0.46).toFixed(3)})`);
    g.addColorStop(0.74,`rgba(${cr},${cg},${cb},${(a*0.13).toFixed(3)})`);
    g.addColorStop(1,   `rgba(${cr},${cg},${cb},0)`);
    gCtx.beginPath();
    gCtx.arc(x,y,r,0,Math.PI*2);
    gCtx.fillStyle=g;
    gCtx.fill();
  });
  gCtx.restore();

  /* ── Corona dekat bohlam (sangat terang) ── */
  gCtx.save();
  gCtx.globalCompositeOperation='screen';
  gCtx.filter='blur(6px)';
  const cR=radius*(1.30+0.40*eff);
  const ca=0.72*eff;
  const cg=gCtx.createRadialGradient(x,y,radius*0.15,x,y,cR);
  cg.addColorStop(0,   `rgba(255,248,175,${ca.toFixed(3)})`);
  cg.addColorStop(0.26,`rgba(255,192,46,${(ca*0.56).toFixed(3)})`);
  cg.addColorStop(0.62,`rgba(255,108,0,${(ca*0.18).toFixed(3)})`);
  cg.addColorStop(1,   `rgba(200,60,0,0)`);
  gCtx.beginPath();
  gCtx.arc(x,y,cR,0,Math.PI*2);
  gCtx.fillStyle=cg;
  gCtx.fill();
  gCtx.filter='none';
  gCtx.restore();

  /* ── Global illumination dinding (ke atas & samping saja) ── */
  gCtx.save();
  gCtx.globalCompositeOperation='screen';
  /* Hanya area ATAS pusat cahaya */
  const wG=gCtx.createLinearGradient(x,y,x,0);
  wG.addColorStop(0,  `rgba(255,165,40,${(0.04*eff).toFixed(3)})`);
  wG.addColorStop(0.5,`rgba(255,120,18,${(0.02*eff).toFixed(3)})`);
  wG.addColorStop(1,  `rgba(200,80,0,0)`);
  gCtx.fillStyle=wG;
  gCtx.fillRect(0,0,W,y);
  gCtx.restore();

  /* ── Edge vignette (multiply) ── */
  gCtx.save();
  gCtx.globalCompositeOperation='multiply';
  const sg=gCtx.createRadialGradient(x,y,radius*1.5,x,y,Math.max(W,H)*0.9);
  sg.addColorStop(0,  `rgba(0,0,0,0)`);
  sg.addColorStop(0.68,`rgba(0,0,0,${(0.14*eff).toFixed(3)})`);
  sg.addColorStop(1,  `rgba(0,0,0,${(0.38*eff).toFixed(3)})`);
  gCtx.fillStyle=sg;
  gCtx.fillRect(0,0,W,H);
  gCtx.restore();
}

/* ══════════════════════════════════════════════════════════
   FILAMENT COLOR
══════════════════════════════════════════════════════════ */
function updateFilament(eff) {
  const {r:or,g:og,b:ob}=CFG.FILAMENT_OFF;
  const {r:wr,g:wg,b:wb}=CFG.FILAMENT_WARM;
  const {r:hr,g:hg,b:hb}=CFG.FILAMENT_HOT;
  let r,g,b;
  if (eff<0.5) {
    const t=eff*2;
    r=Math.round(lerp(or,wr,t)); g=Math.round(lerp(og,wg,t)); b=Math.round(lerp(ob,wb,t));
  } else {
    const t=(eff-0.5)*2;
    r=Math.round(lerp(wr,hr,t)); g=Math.round(lerp(wg,hg,t)); b=Math.round(lerp(wb,hb,t));
  }
  const col=`rgb(${r},${g},${b})`;
  const a=eff.toFixed(3);
  filWires.forEach(w=>{
    w.style.stroke=col;
    if (eff>0.02) {
      const g1=(eff*5.5).toFixed(1);
      const g2=(eff*13).toFixed(1);
      const g3=(eff*26).toFixed(1);
      w.style.filter=
        `drop-shadow(0 0 ${g1}px rgba(255,215,62,${a}))`+
        `drop-shadow(0 0 ${g2}px rgba(255,155,0,${(eff*0.72).toFixed(3)}))`+
        `drop-shadow(0 0 ${g3}px rgba(255,92,0,${(eff*0.40).toFixed(3)}))`;
    } else { w.style.filter='none'; }
  });
  litGlass.style.opacity=(eff*0.42).toFixed(3);
}

/* ══════════════════════════════════════════════════════════
   BLOOM CSS
══════════════════════════════════════════════════════════ */
function updateBloom(eff) {
  bloom.style.opacity   = eff.toFixed(3);
  bloomOut.style.opacity= (eff*0.88).toFixed(3);
  const sc=1+eff*0.20;
  bloom.style.transform   =`translateX(-50%) scale(${sc.toFixed(3)})`;
  bloomOut.style.transform=`translateX(-50%) scale(${(sc*1.14).toFixed(3)})`;
}

/* ══════════════════════════════════════════════════════════
   MAIN LOOP
══════════════════════════════════════════════════════════ */
function loop(ts) {
  const dt=Math.min(ts-(S.lastTs||ts),50);
  S.lastTs=ts;

  const dur=S.isOn?CFG.ON_DUR:CFG.OFF_DUR;
  S.intensity=S.isOn
    ? clamp(S.intensity+dt/dur,0,1)
    : clamp(S.intensity-dt/dur,0,1);

  let flk=0;
  if (S.flicker){
    S.flickerPhase+=dt*0.058;
    flk=Math.sin(S.flickerPhase*7.5)*0.5+0.5;
    if (S.flickerPhase>11){S.flicker=false;S.flickerPhase=0;}
  }
  const eff=S.intensity*(1-flk*0.10);

  renderGlow(eff);
  const {x,y}=getLightPos();
  updateParticles(dt,x,y,eff);
  updateFilament(eff);
  updateBloom(eff);

  /* Sync class body/scene — hanya ditambah/hapus sekali */
  if (S.isOn){
    if (!document.body.classList.contains('is-on')){
      document.body.classList.add('is-on');
      scene.classList.add('is-on');
    }
  } else if (S.intensity<0.01){
    document.body.classList.remove('is-on');
    scene.classList.remove('is-on');
  }

  const busy=
    (S.isOn && S.intensity<1)||
    (!S.isOn && S.intensity>0)||
    S.flicker||S.particles.length>0;

  S.rafId=busy?requestAnimationFrame(loop):null;
}

function startLoop(){
  if (S.rafId) return;
  S.lastTs=performance.now();
  S.rafId=requestAnimationFrame(loop);
}

/* ══════════════════════════════════════════════════════════
   TOGGLE — satu fungsi, satu sumber kebenaran
══════════════════════════════════════════════════════════ */
function toggle(){
  initAudio();
  S.isOn=!S.isOn;

  /* aria-checked = satu-satunya state yang dikontrol */
  toggleBtn.setAttribute('aria-checked', S.isOn?'true':'false');

  playClick(S.isOn);

  if (S.isOn){
    S.flicker=true; S.flickerPhase=0;
    document.body.classList.add('is-on');
    scene.classList.add('is-on');
    /* Burst partikel awal */
    const {x,y}=getLightPos();
    for(let i=0;i<20;i++) S.particles.push(makeParticle(x,y));
  }

  startLoop();
}

/* ── EVENTS ─────────────────────────────────────────────── */
toggleBtn.addEventListener('click', toggle);
toggleBtn.addEventListener('keydown', e=>{
  if (e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(); }
});
/* Klik area lampu juga toggle */
lampWrap.addEventListener('click', toggle);

/* ── INIT ───────────────────────────────────────────────── */
renderGlow(0);

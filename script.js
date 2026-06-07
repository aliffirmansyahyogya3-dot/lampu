/**
 * SCRIPT.JS — Edison Bulb v4
 * ════════════════════════════════════════════════════════════
 * FITUR BARU:
 *   • Flicker engine realistis setelah lampu menyala >5 detik
 *   • Flicker acak: kadang kedip cepat, kadang redup sebentar
 *   • Intensitas cahaya lebih tinggi dari v3
 *   • Ray hanya ke atas
 *   • Partikel debu melayang ke atas
 *   • Suara klik + relay Web Audio
 * ════════════════════════════════════════════════════════════
 */
'use strict';

/* ── CONFIG ─────────────────────────────────────────────── */
const CFG = {
  ON_DUR:  300,
  OFF_DUR: 460,

  FILAMENT: {
    off:  {r:42,  g:20, b:0},
    warm: {r:255, g:148,b:0},
    hot:  {r:255, g:218,b:68},
  },

  /* GLOW lebih terang dari v3 */
  GLOW_LAYERS: [
    {radius:.075, alpha:.95, color:[255,238,118]},
    {radius:.20,  alpha:.62, color:[255,195,44]},
    {radius:.38,  alpha:.36, color:[255,138,0]},
    {radius:.60,  alpha:.18, color:[228,92,0]},
    {radius:.90,  alpha:.09, color:[188,58,0]},
  ],

  /* Ray sinar hanya ke ATAS (angles sekitar 270°) */
  RAYS:[
    {angle:270, spread:48, alpha:.10},
    {angle:252, spread:26, alpha:.062},
    {angle:288, spread:26, alpha:.062},
    {angle:235, spread:20, alpha:.038},
    {angle:305, spread:20, alpha:.038},
  ],

  /* ── FLICKER ENGINE ──
     Mulai setelah lampu ON lebih dari 5 detik.
     Beberapa jenis flicker:
       'dip'   : redup sebentar (0.3-0.7s)
       'blink' : kedip cepat 1-3x
       'hum'   : noise kecil terus-menerus
  */
  FLICKER: {
    START_DELAY_MS: 5000,    // mulai setelah 5 detik
    BASE_NOISE:     0.018,   // noise kecil konstan saat "hum"
    DIP_CHANCE:     0.004,   // per-frame chance untuk "dip"
    BLINK_CHANCE:   0.0015,  // per-frame chance untuk "blink"
    DIP_DEPTH:      0.28,    // seberapa redup saat dip (0=gelap, 1=no dip)
    DIP_DURATION:   [200,600],// ms min..max
    BLINK_COUNT:    [1,4],   // jumlah kedip
    BLINK_RATE:     80,       // ms per kedip
  },

  PARTICLE_MAX: 58,
  PARTICLE_COLS:[
    [255,228,102],[255,198,64],[255,158,32],[222,132,0],[255,248,162]
  ],
};

/* ── STATE ──────────────────────────────────────────────── */
const S = {
  isOn:    false,
  intensity: 0,
  lastTs:  0,
  rafId:   null,
  /* waktu kapan lampu dinyalakan */
  onSince: 0,

  /* Flicker state */
  flicker: {
    started:   false,   // apakah 5-detik sudah lewat
    noise:     0,       // nilai noise saat ini (0..1, 1=penuh terang)
    mode:     'idle',   // 'idle'|'hum'|'dip'|'blink'
    dipTimer:  0,       // sisa waktu dip (ms)
    dipDepth:  1,       // 1=terang, <1=redup
    blinkCount:0,
    blinkTimer:0,
    blinkState:true,    // true=nyala, false=mati
    /* startup flicker (baru dinyalakan) */
    startup:  true,
    startupPhase: 0,
  },

  particles: [],
  audioCtx:  null,
};

/* ── DOM ────────────────────────────────────────────────── */
const glowCanvas = document.getElementById('glowCanvas');
const gCtx       = glowCanvas.getContext('2d');
const partCanvas = document.getElementById('particleCanvas');
const pCtx       = partCanvas.getContext('2d');
const toggleBtn  = document.getElementById('toggleSwitch');
const scene      = document.querySelector('.scene');
const lampWrap   = document.querySelector('.lamp-wrap');
const filWires   = document.querySelectorAll('.filament-wire');
const litGlass   = document.getElementById('litGlass');
const bloom      = document.getElementById('bloomLayer');
const bloomOut   = document.getElementById('bloomLayerOuter');

/* ── RESIZE ─────────────────────────────────────────────── */
function resize(){
  glowCanvas.width = partCanvas.width  = window.innerWidth;
  glowCanvas.height= partCanvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

/* ── HELPERS ────────────────────────────────────────────── */
const lerp  = (a,b,t)=> a+(b-a)*t;
const clamp = (v,lo,hi)=>Math.min(Math.max(v,lo),hi);
const rand  = (lo,hi)=>lo+Math.random()*(hi-lo);

/*
  Pusat cahaya = pusat globe SVG.
  Globe: viewBox Y=168..456, center Y=312.
  lamp-wrap tinggi = 1.846× lebar.
  Pusat globe di Y = 312/480 = 65% dari tinggi lamp-wrap.
*/
function getLightPos(){
  const r=lampWrap.getBoundingClientRect();
  return {
    x: r.left + r.width*0.50,
    y: r.top  + r.height*0.65,
    radius: r.width*0.45,
  };
}

/* ══════════════════════════════════════════════════════════
   AUDIO
══════════════════════════════════════════════════════════ */
function initAudio(){
  if(S.audioCtx) return;
  try{ S.audioCtx=new(window.AudioContext||window.webkitAudioContext)(); }
  catch(e){}
}
function playClick(on){
  const ac=S.audioCtx; if(!ac) return;
  const t=ac.currentTime;
  /* noise burst klik */
  const nb=ac.createBuffer(1,Math.floor(ac.sampleRate*.045),ac.sampleRate);
  const nd=nb.getChannelData(0);
  for(let i=0;i<nd.length;i++) nd[i]=(Math.random()*2-1)*Math.pow(1-i/nd.length,3);
  const ns=ac.createBufferSource(); ns.buffer=nb;
  const bp=ac.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=1850; bp.Q.value=1.2;
  const ng=ac.createGain(); ng.gain.setValueAtTime(.78,t); ng.gain.exponentialRampToValueAtTime(.001,t+.045);
  ns.connect(bp); bp.connect(ng); ng.connect(ac.destination);
  ns.start(t); ns.stop(t+.05);
  /* thud */
  const os=ac.createOscillator(); os.type='sine';
  os.frequency.setValueAtTime(88,t); os.frequency.exponentialRampToValueAtTime(26,t+.065);
  const tg=ac.createGain(); tg.gain.setValueAtTime(.44,t); tg.gain.exponentialRampToValueAtTime(.001,t+.075);
  os.connect(tg); tg.connect(ac.destination);
  os.start(t); os.stop(t+.08);
  /* relay buzz saat ON */
  if(on){
    const rb=ac.createBuffer(1,Math.floor(ac.sampleRate*.07),ac.sampleRate);
    const rd=rb.getChannelData(0);
    for(let i=0;i<rd.length;i++)
      rd[i]=Math.sin(2*Math.PI*120*i/ac.sampleRate)*(Math.random()*.3+.7)*Math.pow(1-i/rd.length,1.4)*.28;
    const rs=ac.createBufferSource(); rs.buffer=rb;
    const rg=ac.createGain(); rg.gain.setValueAtTime(.40,t+.025); rg.gain.exponentialRampToValueAtTime(.001,t+.115);
    rs.connect(rg); rg.connect(ac.destination);
    rs.start(t+.018); rs.stop(t+.12);
  }
}

/* ══════════════════════════════════════════════════════════
   FLICKER ENGINE
══════════════════════════════════════════════════════════ */
/**
 * Menghitung multiplier flicker (0..1) untuk frame ini.
 * @returns {number} 0 = mati total, 1 = terang penuh
 */
function computeFlicker(dt){
  const fk = S.flicker;
  const cfg = CFG.FLICKER;

  /* Startup flicker: 400ms pertama saat baru menyala */
  if(fk.startup){
    fk.startupPhase += dt * .06;
    /* oscillasi cepat → stabil */
    const noise = Math.sin(fk.startupPhase*8.2)*0.5+0.5;
    if(fk.startupPhase > 12){ fk.startup=false; fk.startupPhase=0; }
    return 1 - noise*0.12; /* flicker kecil saat startup */
  }

  /* Belum 5 detik: hanya hum kecil */
  const elapsed = performance.now() - S.onSince;
  if(!fk.started){
    if(elapsed < cfg.START_DELAY_MS){
      /* hum sangat kecil */
      fk.noise = Math.sin(elapsed*.003)*0.008;
      return 1 - Math.abs(fk.noise);
    }
    fk.started = true;
    fk.mode    = 'hum';
  }

  /* ── Mode switching ── */
  if(fk.mode === 'idle' || fk.mode === 'hum'){
    /* Hum: noise sinusoidal kecil */
    fk.noise = Math.sin(elapsed*.0045)*cfg.BASE_NOISE
             + Math.sin(elapsed*.0128)*cfg.BASE_NOISE*0.5;

    /* Probabilitas event flicker */
    if(Math.random() < cfg.DIP_CHANCE * dt){
      fk.mode     = 'dip';
      fk.dipTimer = rand(...cfg.DIP_DURATION);
      fk.dipDepth = 1 - rand(.12, cfg.DIP_DEPTH);
    } else if(Math.random() < cfg.BLINK_CHANCE * dt){
      fk.mode       = 'blink';
      fk.blinkCount = Math.round(rand(...cfg.BLINK_COUNT));
      fk.blinkTimer = cfg.BLINK_RATE;
      fk.blinkState = false; /* mulai gelap */
    }
    return 1 - Math.abs(fk.noise);
  }

  if(fk.mode === 'dip'){
    fk.dipTimer -= dt;
    /* Smooth dip: parabola turun-naik */
    const progress = 1 - fk.dipTimer / rand(...CFG.FLICKER.DIP_DURATION);
    /* Ramp: turun cepat, naik lambat */
    let factor;
    if(progress < 0.35) factor = lerp(1, fk.dipDepth, progress/0.35);
    else                factor = lerp(fk.dipDepth, 1, (progress-.35)/.65);

    if(fk.dipTimer <= 0){
      fk.mode   = 'hum';
      fk.dipTimer=0;
      return 1;
    }
    return clamp(factor, 0.05, 1);
  }

  if(fk.mode === 'blink'){
    fk.blinkTimer -= dt;
    if(fk.blinkTimer <= 0){
      fk.blinkState = !fk.blinkState;
      fk.blinkTimer = CFG.FLICKER.BLINK_RATE + rand(-20,20);
      if(fk.blinkState === true) fk.blinkCount--;
      if(fk.blinkCount <= 0){
        fk.mode='hum';
        return 1;
      }
    }
    /* Saat blink OFF: tidak mati total, hanya redup 15% */
    return fk.blinkState ? 1 : 0.15;
  }

  return 1;
}

/* ══════════════════════════════════════════════════════════
   PARTICLES
══════════════════════════════════════════════════════════ */
function makeParticle(cx,cy){
  const col=CFG.PARTICLE_COLS[Math.floor(Math.random()*CFG.PARTICLE_COLS.length)];
  return{
    x:cx+rand(-72,72), y:cy+rand(-18,38),
    vx:rand(-.38,.38), vy:rand(-.80,-.16),
    sz:rand(.7,2.7), alpha:rand(.18,.56),
    decay:rand(.0012,.0034), color:col,
    wobble:rand(0,Math.PI*2), wobbleSpd:rand(.8,2.0),
  };
}
function updateParticles(dt,cx,cy,eff){
  if(S.isOn && eff>.25 && S.particles.length<CFG.PARTICLE_MAX)
    if(Math.random()<eff*.36*dt) S.particles.push(makeParticle(cx,cy));

  pCtx.clearRect(0,0,partCanvas.width,partCanvas.height);
  for(let i=S.particles.length-1;i>=0;i--){
    const p=S.particles[i];
    p.wobble+=p.wobbleSpd*dt*.05;
    p.x+=p.vx+Math.sin(p.wobble)*.28;
    p.y+=p.vy; p.vy-=.0018;
    p.alpha-=p.decay;
    if(!S.isOn) p.alpha-=.008;
    if(p.alpha<=0){S.particles.splice(i,1);continue;}
    const ea=p.alpha*eff; if(ea<.01) continue;
    const[r,g,b]=p.color;
    pCtx.save();
    pCtx.globalAlpha=ea;
    pCtx.shadowColor=`rgb(${r},${g},${b})`;
    pCtx.shadowBlur=p.sz*5;
    pCtx.fillStyle=`rgb(${r},${g},${b})`;
    pCtx.beginPath(); pCtx.arc(p.x,p.y,p.sz,0,Math.PI*2); pCtx.fill();
    pCtx.restore();
  }
}

/* ══════════════════════════════════════════════════════════
   GLOW CANVAS
══════════════════════════════════════════════════════════ */
function renderGlow(eff){
  const W=glowCanvas.width,H=glowCanvas.height;
  const{x,y,radius}=getLightPos();
  gCtx.clearRect(0,0,W,H);
  if(eff<.002) return;

  /* Ray sinar ke atas */
  gCtx.save();
  gCtx.globalCompositeOperation='screen';
  CFG.RAYS.forEach(ray=>{
    const aRad=(ray.angle*Math.PI)/180;
    const sRad=(ray.spread*Math.PI)/180;
    const len=H*.92;
    const tx=x+Math.cos(aRad)*radius*.22;
    const ty=y+Math.sin(aRad)*radius*.22;
    const a=ray.alpha*eff;
    const g=gCtx.createRadialGradient(tx,ty,0,tx,ty,len);
    g.addColorStop(0,   `rgba(255,218,85,${a.toFixed(3)})`);
    g.addColorStop(.18, `rgba(255,172,36,${(a*.62).toFixed(3)})`);
    g.addColorStop(.46, `rgba(232,110,0,${(a*.26).toFixed(3)})`);
    g.addColorStop(1,   `rgba(200,68,0,0)`);
    gCtx.beginPath();
    gCtx.moveTo(tx,ty);
    gCtx.arc(tx,ty,len,aRad-sRad/2,aRad+sRad/2);
    gCtx.closePath();
    gCtx.fillStyle=g; gCtx.fill();
  });
  gCtx.restore();

  /* Multi-layer radial glow */
  gCtx.save();
  gCtx.globalCompositeOperation='screen';
  CFG.GLOW_LAYERS.forEach(layer=>{
    const r=layer.radius*Math.max(W,H);
    const a=layer.alpha*eff;
    const[cr,cg,cb]=layer.color;
    const g=gCtx.createRadialGradient(x,y,0,x,y,r);
    g.addColorStop(0,   `rgba(${cr},${cg},${cb},${a.toFixed(3)})`);
    g.addColorStop(.38, `rgba(${cr},${cg},${cb},${(a*.46).toFixed(3)})`);
    g.addColorStop(.74, `rgba(${cr},${cg},${cb},${(a*.12).toFixed(3)})`);
    g.addColorStop(1,   `rgba(${cr},${cg},${cb},0)`);
    gCtx.beginPath(); gCtx.arc(x,y,r,0,Math.PI*2);
    gCtx.fillStyle=g; gCtx.fill();
  });
  gCtx.restore();

  /* Corona sangat terang dekat bohlam */
  gCtx.save();
  gCtx.globalCompositeOperation='screen';
  gCtx.filter='blur(5px)';
  const cR=radius*(1.28+.42*eff);
  const ca=.80*eff;
  const cg=gCtx.createRadialGradient(x,y,radius*.14,x,y,cR);
  cg.addColorStop(0,   `rgba(255,250,178,${ca.toFixed(3)})`);
  cg.addColorStop(.25, `rgba(255,195,48,${(ca*.56).toFixed(3)})`);
  cg.addColorStop(.62, `rgba(255,110,0,${(ca*.18).toFixed(3)})`);
  cg.addColorStop(1,   `rgba(200,60,0,0)`);
  gCtx.beginPath(); gCtx.arc(x,y,cR,0,Math.PI*2);
  gCtx.fillStyle=cg; gCtx.fill();
  gCtx.filter='none';
  gCtx.restore();

  /* Ambient ke atas saja */
  gCtx.save();
  gCtx.globalCompositeOperation='screen';
  const wG=gCtx.createLinearGradient(x,y,x,0);
  wG.addColorStop(0,  `rgba(255,168,42,${(.048*eff).toFixed(3)})`);
  wG.addColorStop(.5, `rgba(255,122,18,${(.022*eff).toFixed(3)})`);
  wG.addColorStop(1,  `rgba(200,82,0,0)`);
  gCtx.fillStyle=wG; gCtx.fillRect(0,0,W,y);
  gCtx.restore();

  /* Vignette edge */
  gCtx.save();
  gCtx.globalCompositeOperation='multiply';
  const sg=gCtx.createRadialGradient(x,y,radius*1.5,x,y,Math.max(W,H)*.92);
  sg.addColorStop(0,   `rgba(0,0,0,0)`);
  sg.addColorStop(.65, `rgba(0,0,0,${(.12*eff).toFixed(3)})`);
  sg.addColorStop(1,   `rgba(0,0,0,${(.36*eff).toFixed(3)})`);
  gCtx.fillStyle=sg; gCtx.fillRect(0,0,W,H);
  gCtx.restore();
}

/* ══════════════════════════════════════════════════════════
   FILAMENT + BLOOM UPDATE
══════════════════════════════════════════════════════════ */
function updateFilament(eff){
  const{off,warm,hot}=CFG.FILAMENT;
  let r,g,b;
  if(eff<.5){
    const t=eff*2;
    r=Math.round(lerp(off.r,warm.r,t));
    g=Math.round(lerp(off.g,warm.g,t));
    b=Math.round(lerp(off.b,warm.b,t));
  } else {
    const t=(eff-.5)*2;
    r=Math.round(lerp(warm.r,hot.r,t));
    g=Math.round(lerp(warm.g,hot.g,t));
    b=Math.round(lerp(warm.b,hot.b,t));
  }
  const col=`rgb(${r},${g},${b})`;
  const a=eff.toFixed(3);
  filWires.forEach(w=>{
    w.style.stroke=col;
    if(eff>.025){
      const g1=(eff*6).toFixed(1);
      const g2=(eff*14).toFixed(1);
      const g3=(eff*28).toFixed(1);
      w.style.filter=
        `drop-shadow(0 0 ${g1}px rgba(255,220,65,${a}))`+
        `drop-shadow(0 0 ${g2}px rgba(255,158,0,${(eff*.72).toFixed(3)}))`+
        `drop-shadow(0 0 ${g3}px rgba(255,95,0,${(eff*.40).toFixed(3)}))`;
    } else { w.style.filter='none'; }
  });
  litGlass.style.opacity=(eff*.45).toFixed(3);
}

function updateBloom(eff){
  bloom.style.opacity   =eff.toFixed(3);
  bloomOut.style.opacity=(eff*.90).toFixed(3);
  const sc=1+eff*.22;
  bloom.style.transform   =`translateX(-50%) scale(${sc.toFixed(3)})`;
  bloomOut.style.transform=`translateX(-50%) scale(${(sc*1.15).toFixed(3)})`;
}

/* ══════════════════════════════════════════════════════════
   MAIN LOOP
══════════════════════════════════════════════════════════ */
function loop(ts){
  const dt=Math.min(ts-(S.lastTs||ts),50);
  S.lastTs=ts;

  /* Ramp intensity */
  const dur=S.isOn?CFG.ON_DUR:CFG.OFF_DUR;
  S.intensity=S.isOn
    ? clamp(S.intensity+dt/dur,0,1)
    : clamp(S.intensity-dt/dur,0,1);

  /* Flicker multiplier (hanya saat lampu ON & sudah penuh menyala) */
  let flickMul=1;
  if(S.isOn && S.intensity>.85){
    flickMul=computeFlicker(dt);
  } else if(!S.isOn){
    /* Reset flicker state saat dimatikan */
    S.flicker.started=false;
    S.flicker.mode='idle';
    S.flicker.startup=true;
    S.flicker.startupPhase=0;
  }

  const eff=S.intensity*flickMul;

  renderGlow(eff);
  const{x,y}=getLightPos();
  updateParticles(dt,x,y,eff);
  updateFilament(eff);
  updateBloom(eff);

  /* Sync class */
  if(S.isOn){
    if(!document.body.classList.contains('is-on')){
      document.body.classList.add('is-on');
      scene.classList.add('is-on');
    }
  } else if(S.intensity<.01){
    document.body.classList.remove('is-on');
    scene.classList.remove('is-on');
  }

  /* Lanjutkan loop */
  const busy=
    (S.isOn && S.intensity<1)||
    (!S.isOn && S.intensity>.002)||
    S.particles.length>0||
    (S.isOn && S.flicker.started); /* terus loop saat flicker aktif */

  S.rafId = busy ? requestAnimationFrame(loop) : null;
}

function startLoop(){
  if(S.rafId) return;
  S.lastTs=performance.now();
  S.rafId=requestAnimationFrame(loop);
}

/* ══════════════════════════════════════════════════════════
   TOGGLE
══════════════════════════════════════════════════════════ */
function toggle(){
  initAudio();
  S.isOn=!S.isOn;
  toggleBtn.setAttribute('aria-checked',S.isOn?'true':'false');
  playClick(S.isOn);

  if(S.isOn){
    S.onSince=performance.now();
    /* Reset flicker untuk sesi baru */
    S.flicker.started=false;
    S.flicker.mode='idle';
    S.flicker.startup=true;
    S.flicker.startupPhase=0;
    document.body.classList.add('is-on');
    scene.classList.add('is-on');
    /* Burst partikel awal */
    const{x,y}=getLightPos();
    for(let i=0;i<22;i++) S.particles.push(makeParticle(x,y));
  }
  startLoop();
}

/* ── EVENTS ─────────────────────────────────────────────── */
toggleBtn.addEventListener('click', toggle);
toggleBtn.addEventListener('keydown',e=>{
  if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle();}
});
lampWrap.addEventListener('click', toggle);

/* ── INIT ───────────────────────────────────────────────── */
renderGlow(0);

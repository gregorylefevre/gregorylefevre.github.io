import { EngineAudio, PROFILES } from './engine.js';
import { GpsSource, MotionSensor, SpeedEstimator } from './motion.js';

const $ = (s) => document.querySelector(s);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const NUM_FONT = "'Rajdhani', 'Segoe UI', system-ui, sans-serif";
const lerp = (a, b, t) => a + (b - a) * t;
const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem('torque.' + k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('torque.' + k, JSON.stringify(v)); } catch {} },
};

// ---------- Boîte de vitesses virtuelle ----------
class Drivetrain {
  constructor(p) { this.setProfile(p); }
  setProfile(p) { this.p = p; this.gear = 0; this.rpm = p.idle; this.shiftTimer = 0; }
  rpmIn(g, kmh) { return (this.p.redline * kmh) / this.p.gears[g - 1]; }

  update(kmh, thr, dt, ev) {
    const p = this.p;
    this.shiftTimer -= dt;
    if (this.gear === 0 && kmh >= 2) this.gear = 1;
    else if (this.gear > 0 && kmh < 1.5 && thr < 0.05) this.gear = 0;

    if (this.gear > 0 && this.shiftTimer <= 0) {
      const up = thr < 0.15 ? p.redline * 0.9 : p.redline * lerp(0.42, 0.97, thr);
      const down = p.redline * lerp(0.26, 0.5, thr);
      const r = this.rpmIn(this.gear, kmh);
      if (r > up && this.gear < p.gears.length) {
        this.gear++; this.shiftTimer = 0.45; ev.push('up');
      } else if (this.gear > 1 && r < down && this.rpmIn(this.gear - 1, kmh) < up * 0.9) {
        this.gear--; this.shiftTimer = 0.45; ev.push('down');
      }
    }

    let target;
    if (this.gear === 0) {
      target = p.idle + thr * (p.redline - p.idle) * 0.65;
    } else {
      target = this.rpmIn(this.gear, kmh);
      if (this.gear === 1 && kmh < 20) {
        const slip = p.idle * 1.4 + thr * p.redline * 0.45;
        target = Math.max(target, lerp(slip, target, kmh / 20));
      }
      target = Math.max(target, p.idle);
    }
    target = Math.min(target, p.limiter);

    // Ralenti légèrement instable, comme un vrai moteur
    if (target < p.idle * 1.2) target += Math.sin(performance.now() / 180) * 12 + Math.sin(performance.now() / 67) * 6;

    this.rpm = approach(this.rpm, target, this.shiftTimer > 0.3 ? 22 : 9, dt);
    if (this.rpm >= p.limiter - 30 && thr > 0.5) { this.rpm -= 380; ev.push('limiter'); }
    return this.rpm;
  }
}

// ---------- Compte-tours ----------
function drawTach(cv, s) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const p = s.profile;
  const cx = W / 2, cy = H / 2 + H * 0.04, R = Math.min(W, H * 1.08) / 2 * 0.9;
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
  const maxR = Math.ceil((p.limiter + 300) / 1000) * 1000;
  const ang = (r) => a0 + (a1 - a0) * clamp(r / maxR, 0, 1);
  const arc = (r, from, to) => { g.beginPath(); g.arc(cx, cy, r, from, to); g.stroke(); };
  const shiftLight = s.rpm > p.redline * 0.93;
  const flash = shiftLight && Math.floor(performance.now() / 70) % 2 === 0;

  g.lineCap = 'round';
  g.lineWidth = R * 0.075;
  g.strokeStyle = 'rgba(255,255,255,0.06)';
  arc(R, a0, a1);

  g.lineCap = 'butt';
  g.strokeStyle = 'rgba(255,45,70,0.45)';
  arc(R, ang(p.redline), a1);

  const grad = g.createLinearGradient(cx - R, cy, cx + R, cy);
  grad.addColorStop(0, s.accent + '55');
  grad.addColorStop(1, shiftLight ? '#ff2d46' : s.accent);
  g.lineCap = 'round';
  g.strokeStyle = grad;
  g.shadowColor = shiftLight ? '#ff2d46' : s.accent;
  g.shadowBlur = R * 0.15;
  arc(R, a0, Math.max(a0 + 0.001, ang(s.rpm)));
  g.shadowBlur = 0;

  for (let r = 0; r <= maxR; r += 250) {
    const major = r % 1000 === 0;
    const a = ang(r);
    const r1 = R * (major ? 0.8 : 0.85), r2 = R * 0.9;
    g.strokeStyle = r >= p.redline ? 'rgba(255,70,90,0.9)' : major ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.25)';
    g.lineWidth = major ? 2.5 : 1.2;
    g.lineCap = 'butt';
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
    g.stroke();
    if (major) {
      g.fillStyle = r >= p.redline ? '#ff4d63' : 'rgba(255,255,255,0.7)';
      g.font = `600 ${Math.round(R * 0.09)}px ${NUM_FONT}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(r / 1000), cx + Math.cos(a) * R * 0.68, cy + Math.sin(a) * R * 0.68);
    }
  }

  const na = ang(s.rpm);
  g.save();
  g.shadowColor = s.accent; g.shadowBlur = 12;
  g.strokeStyle = '#fff'; g.lineWidth = 3; g.lineCap = 'round';
  g.beginPath();
  g.moveTo(cx + Math.cos(na) * R * 0.22, cy + Math.sin(na) * R * 0.22);
  g.lineTo(cx + Math.cos(na) * R * 0.95, cy + Math.sin(na) * R * 0.95);
  g.stroke();
  g.restore();

  g.beginPath();
  g.arc(cx, cy, R * 0.2, 0, Math.PI * 2);
  g.fillStyle = flash ? '#ff2d46' : 'rgba(10,12,18,0.92)';
  g.fill();
  g.lineWidth = 2; g.strokeStyle = shiftLight ? '#ff2d46' : s.accent + 'aa';
  g.stroke();

  g.fillStyle = flash ? '#fff' : s.accent;
  g.font = `800 ${Math.round(R * 0.22)}px ${NUM_FONT}`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(s.gear === 0 ? 'N' : String(s.gear), cx, cy + 2);

  g.fillStyle = 'rgba(255,255,255,0.45)';
  g.font = `500 ${Math.round(R * 0.065)}px system-ui`;
  g.fillText('× 1000 tr/min', cx, cy + R * 0.42);
}

// ---------- Application ----------
const audio = new EngineAudio();
const state = {
  profileKey: store.get('profile', 'v8'),
  mode: store.get('mode', 'gps'),
  volume: store.get('volume', 0.8),
  running: false,
  kmh: 0, thr: 0, rpm: 0, gear: 0,
  pedal: false, brake: false,
  simV: 0,
};
if (!PROFILES[state.profileKey]) state.profileKey = 'v8';
const profile = () => PROFILES[state.profileKey];
const drive = new Drivetrain(profile());
state.rpm = profile().idle;

const chipGps = $('#chipGps'), chipEngine = $('#chipEngine'), chipImu = $('#chipImu');
const setChip = (el) => (kind, text) => { el.textContent = text; el.dataset.state = kind; };
const estimator = new SpeedEstimator();
const imu = new MotionSensor(setChip(chipImu));
let lastFix = null;
const gps = new GpsSource((v, sigma) => {
  const t = performance.now();
  if (lastFix && t - lastFix.t < 5000) imu.learn((v - lastFix.v) / ((t - lastFix.t) / 1000));
  lastFix = { v, t };
  estimator.update(v, sigma);
}, setChip(chipGps));

function startSensors() {
  estimator.reset();
  lastFix = null;
  gps.start();
}
function stopSensors() {
  gps.stop();
  imu.stop();
}
let wakeLock = null;

const ALPHAS = [12, 14, 22, 28, 35, 40, 45, 50, 60];
function setAlphaVars(el, name, hex) {
  el.style.setProperty(`--${name}`, hex);
  for (const a of ALPHAS) {
    el.style.setProperty(`--${name}-${a}`, hex + Math.round((a / 100) * 255).toString(16).padStart(2, '0'));
  }
}

function applyAccent() {
  const p = profile();
  setAlphaVars(document.documentElement, 'accent', p.accent);
  $('#engineName').textContent = p.name;
  $('#engineSpec').textContent = p.spec;
}

function renderEngines() {
  const wrap = $('#engines');
  wrap.innerHTML = '';
  for (const [key, p] of Object.entries(PROFILES)) {
    const b = document.createElement('button');
    b.className = 'engine' + (key === state.profileKey ? ' active' : '');
    setAlphaVars(b, 'c', p.accent);
    b.innerHTML = `<span class="cyl">${p.cylinders}<small>cyl</small></span>
      <span class="txt"><b>${p.name}</b><small>${p.spec}</small></span>
      <span class="red">${(p.redline / 1000).toFixed(1)}k</span>`;
    b.addEventListener('click', () => selectEngine(key));
    wrap.appendChild(b);
  }
}

function selectEngine(key) {
  state.profileKey = key;
  store.set('profile', key);
  drive.setProfile(profile());
  state.rpm = profile().idle;
  audio.setProfile(profile());
  applyAccent();
  renderEngines();
}

function setMode(mode) {
  state.mode = mode;
  store.set('mode', mode);
  document.querySelectorAll('.mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  document.body.dataset.mode = mode;
  state.simV = state.kmh / 3.6;
  if (state.running) {
    if (mode === 'gps') { imu.start(); startSensors(); } else stopSensors();
  }
}

async function toggleEngine() {
  const btn = $('#start');
  if (!state.running) {
    state.running = true;
    btn.classList.add('on');
    chipEngine.textContent = 'Moteur · en marche';
    chipEngine.dataset.state = 'ok';
    drive.setProfile(profile());
    // Demandé avant tout "await" : iOS n'accorde l'accès aux capteurs que pendant le clic
    const imuReady = state.mode === 'gps' ? imu.start() : null;
    await audio.start(profile(), state.volume);
    if (state.mode === 'gps') { await imuReady; startSensors(); }
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  } else {
    state.running = false;
    btn.classList.remove('on');
    chipEngine.textContent = 'Moteur · coupé';
    chipEngine.dataset.state = 'off';
    stopSensors();
    audio.stop();
    try { await wakeLock?.release(); } catch {}
    wakeLock = null;
  }
}

function bindHold(el, key) {
  const on = (e) => { e.preventDefault(); state[key] = true; el.classList.add('pressed'); };
  const off = () => { state[key] = false; el.classList.remove('pressed'); };
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerup', off);
  el.addEventListener('pointerleave', off);
  el.addEventListener('pointercancel', off);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

function simulate(dt) {
  const p = profile();
  const vmax = (p.gears[p.gears.length - 1] * p.limiter) / p.redline / 3.6;
  const target = state.pedal ? 1 : 0;
  state.thr = approach(state.thr, target, state.pedal ? 9 : 14, dt);
  const v = state.simV;
  const g = Math.max(1, drive.gear);
  let a = state.thr * (8.5 / (1 + 0.3 * (g - 1))) * (1 - (v / vmax) ** 2);
  if (drive.shiftTimer > 0.3) a *= 0.15;
  a -= state.thr < 0.05 ? 0.7 + 0.0009 * v * v : 0.0004 * v * v;
  if (state.brake) a -= 9;
  state.simV = clamp(v + a * dt, 0, vmax);
  return state.simV * 3.6;
}

let prevThr = 0, prevGear = -1, last = performance.now(), uiTimer = 0;
function frame(now) {
  const dt = clamp((now - last) / 1000, 0, 0.1);
  last = now;
  const p = profile();

  if (state.mode === 'demo') {
    state.kmh = simulate(dt);
  } else if (state.running) {
    estimator.predict(dt, imu.accel());
    // Avec l'accéléromètre la charge est quasi instantanée, on peut donc la suivre plus vite
    state.kmh = approach(state.kmh, estimator.v * 3.6, 10, dt);
    state.thr = approach(state.thr, estimator.throttle(), estimator.imu ? 12 : 5, dt);
  } else {
    state.kmh = approach(state.kmh, 0, 3, dt);
    state.thr = approach(state.thr, 0, 6, dt);
  }

  if (state.running) {
    const ev = [];
    state.rpm = drive.update(state.kmh, state.thr, dt, ev);
    state.gear = drive.gear;
    for (const e of ev) {
      if (e === 'up') audio.shift(true, state.thr);
      else if (e === 'down') audio.shift(false, state.thr);
      else if (e === 'limiter') audio.limiter();
    }
    if (prevThr > 0.55 && state.thr < 0.25) audio.liftOff(state.rpm);
    if (state.gear !== prevGear) { prevGear = state.gear; audio.setGear(state.gear); }
    audio.update(state.rpm, state.thr, dt);
  } else {
    state.rpm = approach(state.rpm, 0, 4, dt);
    state.gear = 0;
  }
  prevThr = state.thr;

  drawTach($('#tach'), { profile: p, rpm: state.rpm, gear: state.gear, accent: p.accent });

  uiTimer -= dt;
  if (uiTimer <= 0) {
    uiTimer = 0.05;
    $('#speed').textContent = Math.round(state.kmh);
    $('#rpm').textContent = Math.round(state.rpm / 10) * 10;
    $('#gearTxt').textContent = state.gear === 0 ? 'N' : state.gear;
    $('#throttleBar').style.transform = `scaleX(${state.thr.toFixed(3)})`;
    $('#throttlePct').textContent = Math.round(state.thr * 100) + ' %';
  }
  requestAnimationFrame(frame);
}

// ---------- Initialisation ----------
applyAccent();
renderEngines();
setMode(state.mode);
$('#volume').value = state.volume;
$('#volume').addEventListener('input', (e) => {
  state.volume = parseFloat(e.target.value);
  store.set('volume', state.volume);
  audio.setVolume(state.volume);
});
$('#start').addEventListener('click', toggleEngine);
document.querySelectorAll('.mode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
bindHold($('#pedal'), 'pedal');
bindHold($('#brake'), 'brake');
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'ArrowUp' || e.code === 'KeyW') state.pedal = true;
  if (e.code === 'ArrowDown' || e.code === 'KeyS') state.brake = true;
  if (e.code === 'Enter') toggleEngine();
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'ArrowUp' || e.code === 'KeyW') state.pedal = false;
  if (e.code === 'ArrowDown' || e.code === 'KeyS') state.brake = false;
});
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.running && !wakeLock) {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  }
});
requestAnimationFrame(frame);


// Moteur thermique en modèle physique simplifié, exécuté dans le thread audio.
// - chaque cylindre émet une bouffée d'échappement à son angle de vilebrequin (ordre d'allumage réel),
//   composée d'un coup de pression initial (bouffée de détente) et d'une phase d'évacuation plus lente
// - les bouffées traversent des tubes résonants (collecteur puis ligne) : les résonances restent
//   fixes quand le régime monte, seule la cadence des combustions change, comme sur un vrai moteur
// - s'y ajoutent : admission, bruits mécaniques, détonations (retours de flamme / anti-lag),
//   turbo (sifflement, flutter, soupape), sifflement de boîte à pignons droits et démarreur

const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  _set(b0, b1, b2, a0, a1, a2) {
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  _w(f) { return (TAU * clamp(f, 10, sampleRate * 0.45)) / sampleRate; }
  lowpass(f, q = 0.707) { const w = this._w(f), c = Math.cos(w), a = Math.sin(w) / (2 * q); return this._set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + a, -2 * c, 1 - a); }
  highpass(f, q = 0.707) { const w = this._w(f), c = Math.cos(w), a = Math.sin(w) / (2 * q); return this._set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + a, -2 * c, 1 - a); }
  bandpass(f, q = 1) { const w = this._w(f), c = Math.cos(w), a = Math.sin(w) / (2 * q); return this._set(a, 0, -a, 1 + a, -2 * c, 1 - a); }
  peaking(f, q, db) {
    const A = Math.pow(10, db / 40), w = this._w(f), c = Math.cos(w), a = Math.sin(w) / (2 * q);
    return this._set(1 + a * A, -2 * c, 1 - a * A, 1 + a / A, -2 * c, 1 - a / A);
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

// Tube ouvert à une extrémité : ligne à retard bouclée avec réflexion négative et pertes
class Tube {
  constructor(lengthM, soundSpeed, refl, damp) {
    const len = Math.max(2, Math.round(((2 * lengthM) / soundSpeed) * sampleRate));
    this.buf = new Float32Array(len); this.i = 0; this.refl = refl; this.damp = damp; this.lp = 0;
  }
  process(x) {
    const d = this.buf[this.i];
    this.lp += this.damp * (d - this.lp);
    const y = x + this.refl * this.lp;
    this.buf[this.i] = y;
    if (++this.i >= this.buf.length) this.i = 0;
    return y;
  }
}

const TABLE_N = 1024;
function table(fn) {
  const t = new Float32Array(TABLE_N + 1);
  let peak = 0;
  for (let i = 0; i <= TABLE_N; i++) { t[i] = fn(i / TABLE_N); peak = Math.max(peak, Math.abs(t[i])); }
  for (let i = 0; i <= TABLE_N; i++) t[i] /= peak;
  t[TABLE_N] = 0;
  return t;
}
// Phase d'évacuation : montée rapide puis décroissance douce
const BODY = table((u) => (u < 0.12 ? Math.sin((Math.PI / 2) * (u / 0.12)) : 1) * Math.exp(-4.2 * Math.max(0, u - 0.12)) * (1 - u));
// Bouffée de détente à l'ouverture de la soupape : pic très bref
const SPIKE = table((u) => (1 - Math.exp(-u / 0.006)) * Math.exp(-u / 0.045));
const lookup = (t, u) => {
  const x = u * TABLE_N, i = x | 0;
  return i >= TABLE_N ? 0 : t[i] + (t[i + 1] - t[i]) * (x - i);
};

const DEFAULTS = {
  sharp: 0.6, radiate: 0.5, radHz: 160, burble: 0.25, bang: 0.6, rasp: 0, raspF: [2200, 0.7], idleAmp: 0.3,
  whine: 0, whineTeeth: [23, 13, 16, 19, 22, 25, 28, 31],
  turbo: 0, turboF: [1600, 6000], flutter: 0, als: 0, bov: 0,
};

class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 800, minValue: 0, maxValue: 20000, automationRate: 'k-rate' },
      { name: 'throttle', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    this.ready = false;
    this.seed = 0x12345678;
    this.active = [];
    this.free = [];
    for (let i = 0; i < 96; i++) this.free.push({ pos: 0, len: 1, amp: 0, sharp: 0, noise: 0, bank: 0, delay: 0, intake: 0 });
    this.bangs = [];
    this.bangFree = [];
    for (let i = 0; i < 12; i++) this.bangFree.push({ delay: 0, env: 0, dk: 0, th: 0, dkt: 0, ph: 0, f: 0, amp: 0 });
    this.gear = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
    const init = options && options.processorOptions && options.processorOptions.profile;
    if (init) this.setup(init);
  }

  rand() {
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x;
    return (x >>> 0) / 4294967296;
  }
  noise() { return this.rand() * 2 - 1; }

  onMessage(m) {
    if (m.type === 'profile') this.setup(m);
    else if (m.type === 'cut') { this.cut = Math.max(this.cut || 0, Math.round((m.ms / 1000) * sampleRate)); this.cutPops = m.pops || 0; }
    else if (m.type === 'liftoff') this.liftoff = Math.round(1.3 * sampleRate);
    else if (m.type === 'start') { this.startS = 0; this.starting = true; }
    else if (m.type === 'gear') this.gear = m.gear | 0;
  }

  setup(m) {
    const s = { ...DEFAULTS, ...m.sound };
    this.s = s; this.idle = m.idle; this.redline = m.redline;
    const n = s.angles.length;
    this.nc = n;
    this.baseAng = Float64Array.from(s.angles);
    this.ang = Float64Array.from(s.angles);
    this.bankOf = Uint8Array.from(s.banks);
    this.nb = Math.max(...s.banks) + 1;
    this.seed = 0x9e3779b9 ^ (n * 7919);
    this.bias = new Float32Array(n);
    this.runner = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      this.bias[i] = 1 + (this.rand() - 0.5) * 2 * s.imbalance;
      this.runner[i] = Math.round((this.rand() * s.runnerSpread) * sampleRate);
    }
    const c = s.soundSpeed;
    this.hdr = []; this.tail = []; this.rad = [];
    for (let b = 0; b < 2; b++) {
      this.hdr.push(new Tube(s.header * (1 + b * 0.04), c, s.headerRefl, s.headerDamp));
      this.tail.push(new Tube(s.tail * (1 + b * 0.03), c, s.tailRefl, s.tailDamp));
      this.rad.push(new Biquad().highpass(s.radHz, 0.6));
    }
    this.raspBP = [0, 1].map(() => new Biquad().bandpass(s.raspF[0], s.raspF[1]));
    this.muff = [new Biquad(), new Biquad()];
    this.body = [0, 1].map(() => new Biquad().peaking(s.body[0], s.body[1], s.body[2]));
    this.pres = [0, 1].map(() => new Biquad().peaking(s.presence[0], s.presence[1], s.presence[2]));
    this.dc = [new Biquad().highpass(28), new Biquad().highpass(28)];
    this.intakeBP = new Biquad().bandpass(s.intake[0], s.intake[1]);
    this.intakeBP2 = new Biquad().bandpass(s.intake[0] * 2.7, s.intake[1] * 1.5);
    this.roarBP = new Biquad().bandpass(s.roar[0], s.roar[1]);
    this.mechHP = new Biquad().highpass(s.mech[0], 0.9);
    // Détonations : traversent la fin de ligne mais pas le silencieux
    this.bangHP = new Biquad().highpass(90, 0.7);
    this.bangLP = new Biquad().lowpass(7000, 0.7);
    this.bangTube = new Tube(s.tail * 0.6, c, -0.45, 0.45);
    // Turbo
    this.whBP1 = new Biquad(); this.whBP2 = new Biquad();
    this.whooshBP = new Biquad().bandpass(2600, 0.6);
    this.flBP = new Biquad().bandpass(1900, 1.4);
    this.flLP = new Biquad().lowpass(420, 0.8);
    this.bovBP = new Biquad().bandpass(3500, 2.5);
    this.active.forEach((p) => this.free.push(p));
    this.active.length = 0;
    this.bangs.forEach((b) => this.bangFree.push(b));
    this.bangs.length = 0;
    this.phase = 0; this.next = 0; this.rpm = m.idle;
    this.cut = 0; this.liftoff = 0; this.intEnv = 0; this.mechEnv = 0;
    this.spool = 0; this.whPh = 0; this.wob = 0; this.flEnv = 0; this.flPh = 0; this.flRate = 20;
    this.bovEnv = 0; this.bovT = 0; this.recentThr = 0; this.als = 0; this.alsNext = 0;
    this.wPh1 = 0; this.wPh2 = 0;
    this.stPhase = 0; this.starting = false;
    this.ready = true;
  }

  rejitter(jitDeg) {
    for (let i = 0; i < this.nc; i++) this.ang[i] = this.baseAng[i] + (this.rand() - 0.5) * jitDeg;
  }

  spawn(bank, amp, sharp, len, noise, delay, intake) {
    const p = this.free.pop();
    if (!p) return;
    p.pos = 0; p.len = Math.max(8, len); p.amp = amp; p.sharp = sharp; p.noise = noise;
    p.bank = bank; p.delay = delay; p.intake = intake;
    this.active.push(p);
  }

  // Détonation dans l'échappement : claquement large bande + coup sourd
  bang(level, big, delaySec = 0) {
    const b = this.bangFree.pop();
    if (!b) return;
    const sr = sampleRate;
    b.delay = Math.round(delaySec * sr);
    b.amp = level;
    b.env = 1; b.dk = Math.exp(-1 / ((big ? 0.008 : 0.0022 + this.rand() * 0.0018) * sr));
    b.th = big ? 1 : 0.5; b.dkt = Math.exp(-1 / ((big ? 0.02 : 0.012) * sr));
    b.ph = 0; b.f = big ? 65 + this.rand() * 45 : 90 + this.rand() * 60;
    this.bangs.push(b);
  }

  crackle(level) {
    const n = 1 + ((this.rand() * 3) | 0);
    for (let i = 0; i < n; i++) this.bang(level * (0.5 + 0.5 * this.rand()), false, i === 0 ? 0 : this.rand() * 0.03);
  }

  fire(i, rpm, thr, rn, cranking) {
    const s = this.s;
    const bank = this.bankOf[i];
    const len = (s.pulseDeg / Math.max(rpm * 6, 1)) * sampleRate;
    if (cranking) {
      this.spawn(bank, 0.05 + this.rand() * 0.03, 0.2, len * 0.8, 0.2, this.runner[i], 0.03);
      return;
    }
    const cutting = this.cut > 0;
    // Frein moteur : combustions faibles et irrégulières (ratés)
    const overrun = clamp((0.08 - thr) / 0.08, 0, 1) * clamp((rn - 0.03) / 0.1, 0, 1);
    if (cutting) {
      this.spawn(bank, 0.08, 0, len, 0.5, this.runner[i], 0.05);
    } else {
      const jit = 0.05 + s.lope * (1 - thr) * (1 - rn) + 0.25 * overrun;
      let amp = (s.idleAmp + (1 - s.idleAmp) * Math.pow(thr, 0.75)) * this.bias[i] * (1 + (this.rand() - 0.5) * 2 * jit);
      amp *= 1 - 0.55 * overrun;
      if (overrun > 0 && this.rand() < s.burble * overrun) amp *= 0.15;
      if (thr < 0.05 && rn < 0.1 && this.rand() < s.lope * 0.12) amp *= 0.35;
      const sharp = s.sharp * (0.25 + 0.75 * thr) * (0.6 + 0.6 * rn) * (1 - 0.6 * overrun);
      this.spawn(bank, amp, sharp, len, s.noise * (0.6 + 0.6 * thr), this.runner[i], -0.7 * amp);
    }
    this.mechEnv = 1;

    let prob = 0;
    if (cutting) prob = this.cutPops * 0.5;
    else if (overrun > 0) prob = s.pops * rn * overrun * (this.liftoff > 0 ? 0.2 : 0.025);
    if (prob > 0 && this.rand() < prob) this.crackle((0.4 + 0.6 * this.rand()) * (0.5 + 0.5 * rn));
  }

  process(inputs, outputs, params) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    if (!this.ready) { L.fill(0); if (R !== L) R.fill(0); return true; }
    const s = this.s, n = L.length, sr = sampleRate;
    let rpmT = params.rpm[0];
    let thr = params.throttle[0];
    let cranking = false, starterAmp = 0;

    if (this.starting) {
      const t = this.startS / sr;
      if (t < 0.6) { cranking = true; rpmT = 240; starterAmp = 1; this.rpm = 240; }
      else if (t < 2.2) {
        const x = (t - 0.6) / 1.6;
        const flare = x < 0.22 ? x / 0.22 : Math.exp(-(x - 0.22) * 4.5);
        rpmT = this.idle * (1 + 1.4 * flare);
        thr = Math.max(thr, 0.55 * flare);
      } else this.starting = false;
      this.startS += n;
    }

    const blockSec = n / sr;
    const rn = clamp((this.rpm - this.idle) / (this.redline - this.idle), 0, 1);
    const cutoff = s.muffler[0] + s.muffler[1] * (0.35 * thr + 0.65 * thr * rn) + s.muffler[2] * rn;
    this.muff[0].lowpass(cutoff, 0.8); this.muff[1].lowpass(cutoff, 0.8);
    this.roarBP.bandpass(s.roar[0] * (0.7 + 0.8 * rn), s.roar[1]);

    // Lever de pied après une phase en charge : déclenche flutter / soupape / anti-lag
    const lifted = thr < 0.12 && this.recentThr > 0.5;
    this.recentThr = Math.max(thr, this.recentThr * Math.exp(-blockSec / 0.4));
    if (lifted) {
      this.recentThr = 0;
      if (s.turbo > 0 && this.spool > 0.3) {
        if (s.flutter > 0) { this.flEnv = Math.min(1, this.spool * 1.2); this.flPh = 0; this.flRate = 15 + 9 * this.spool; }
        if (s.bov > 0) { this.bovEnv = this.spool; this.bovT = 0; }
      }
      if (s.als > 0 && rn > 0.25) { this.als = (1.3 + this.rand() * 1.4) * sr; this.alsNext = 0.03 * sr; }
    }
    if (thr > 0.25 || this.rpm < this.idle * 1.35) this.als = 0;

    // Anti-lag : détonations irrégulières, le turbo reste en pression
    if (this.als > 0) {
      this.als -= n;
      this.alsNext -= n;
      while (this.alsNext <= 0) {
        this.bang((0.55 + 0.45 * this.rand()) * s.als, true, this.rand() * blockSec);
        this.alsNext += (this.rand() < 0.3 ? 0.015 + this.rand() * 0.02 : 0.05 + this.rand() * 0.17) * sr;
      }
    }

    // Turbo : la vitesse de l'arbre monte avec du retard et chute dès qu'on lâche (sauf anti-lag)
    if (s.turbo > 0) {
      const target = thr > 0.25 ? thr * Math.pow(rn, 0.5) : this.als > 0 ? 0.8 * this.spool : 0;
      const tau = target > this.spool ? 0.95 - 0.55 * rn : this.als > 0 ? 2.5 : 0.3;
      this.spool += (target - this.spool) * (1 - Math.exp(-blockSec / tau));
      this.wob += blockSec;
      const wf = (s.turboF[0] + this.spool * s.turboF[1]) * (1 + 0.004 * Math.sin(TAU * 3.1 * this.wob) + 0.002 * Math.sin(TAU * 7.7 * this.wob));
      this.whF = wf;
      this.whBP1.bandpass(wf, 32); this.whBP2.bandpass(wf * 1.47, 26);
      if (this.flEnv > 0.001) this.flRate = Math.max(9, this.flRate * Math.exp(-blockSec / 1.2));
    }
    if (this.bovEnv > 0) {
      this.bovBP.bandpass(Math.max(900, 3800 - this.bovT * 6000), 2.2);
      this.bovT += blockSec;
    }

    const rpmK = 1 - Math.exp(-1 / (0.018 * sr));
    const jitDeg = 0.6 + s.lope * 6 * (1 - thr) * (1 - rn);
    const mechDecay = Math.exp(-1 / (0.0006 * sr));
    const intDecay = Math.exp(-1 / (0.01 * sr));
    const bovDecay = Math.exp(-1 / (0.18 * sr));
    const flDecay = Math.exp(-1 / (0.45 * sr));
    const width = s.width, cross = s.cross, radiate = s.radiate;
    const exGain = s.exGain * (0.75 + 0.45 * thr);
    const drive = s.drive * (0.7 + 0.5 * thr);
    const driveNorm = 1 / Math.tanh(drive);
    const whAmp = s.turbo * this.spool * this.spool * (0.35 + 0.65 * thr) * 0.12;
    const whooshAmp = s.turbo * this.spool * thr * 0.06;
    const whF = this.whF || 0;
    const whineAmp = s.whine * 0.016 * (0.25 + rn) * (0.55 + 0.9 * Math.abs(thr - 0.45));
    const teeth = s.whineTeeth;
    const gearTeeth = this.gear > 0 ? teeth[Math.min(this.gear, teeth.length - 1)] : 0;
    const bangGain = s.bang;
    const rasp = s.rasp * (0.35 + 0.65 * thr) * (0.6 + 0.6 * rn);

    for (let k = 0; k < n; k++) {
      this.rpm += (rpmT - this.rpm) * rpmK;
      const rpm = this.rpm;
      this.phase += (rpm * 6) / sr;
      if (this.phase >= 720) { this.phase -= 720; this.next = 0; this.rejitter(jitDeg); }
      while (this.next < this.nc && this.phase >= this.ang[this.next]) {
        this.fire(this.next, rpm, thr, rn, cranking);
        this.next++;
      }
      if (this.cut > 0) this.cut--;
      if (this.liftoff > 0) this.liftoff--;

      let a = 0, b = 0, ea = 0, eb = 0, intk = 0;
      const act = this.active;
      for (let j = act.length - 1; j >= 0; j--) {
        const p = act[j];
        if (p.delay > 0) { p.delay--; continue; }
        const u = p.pos / p.len;
        const body = lookup(BODY, u);
        const v = p.amp * (body + p.sharp * lookup(SPIKE, u)) * (1 + p.noise * this.noise());
        if (p.bank === 0) { a += v; ea += p.amp * body; } else { b += v; eb += p.amp * body; }
        intk += p.intake * body;
        if (++p.pos >= p.len) { act[j] = act[act.length - 1]; act.pop(); this.free.push(p); }
      }
      if (this.nb === 1) { b = a; eb = ea; }


      let ya = this.tail[0].process(this.hdr[0].process(a + cross * b));
      let yb = this.tail[1].process(this.hdr[1].process(b + cross * a));
      // Rayonnement en sortie d'échappement : la pression rayonnée suit la variation du débit
      ya += radiate * (this.rad[0].process(ya) - ya);
      yb += radiate * (this.rad[1].process(yb) - yb);
      let exL = (ya * (0.5 + 0.5 * width) + yb * (0.5 - 0.5 * width)) * exGain;
      let exR = (yb * (0.5 + 0.5 * width) + ya * (0.5 - 0.5 * width)) * exGain;
      exL = this.pres[0].process(this.body[0].process(this.muff[0].process(exL)));
      exR = this.pres[1].process(this.body[1].process(this.muff[1].process(exR)));
      exL = Math.tanh(exL * drive) * driveNorm;
      exR = Math.tanh(exR * drive) * driveNorm;
      // Bruit d'écoulement turbulent modulé par chaque bouffée : le côté rauque de l'échappement
      // (ajouté après la saturation, sinon il est écrasé au moment même où il est le plus fort)
      if (rasp > 0) {
        exL += this.raspBP[0].process(this.noise()) * (ea * (0.5 + 0.5 * width) + eb * (0.5 - 0.5 * width)) * rasp;
        exR += this.raspBP[1].process(this.noise()) * (eb * (0.5 + 0.5 * width) + ea * (0.5 - 0.5 * width)) * rasp;
      }

      this.intEnv = Math.max(Math.abs(intk), this.intEnv * intDecay);
      let eng = (this.intakeBP.process(intk) + 0.5 * this.intakeBP2.process(intk)) * s.intakeMix * (0.3 + thr);
      eng += this.roarBP.process(this.noise()) * s.roarMix * (0.1 + thr) * rn * (0.4 + this.intEnv);
      this.mechEnv *= mechDecay;
      eng += this.mechHP.process(this.noise()) * this.mechEnv * s.mechMix * (0.4 + 0.6 * rn);

      if (this.bangs.length) {
        let bs = 0;
        const bg = this.bangs;
        for (let j = bg.length - 1; j >= 0; j--) {
          const x = bg[j];
          if (x.delay > 0) { x.delay--; continue; }
          x.ph += (TAU * x.f) / sr;
          bs += x.amp * (this.noise() * x.env + 0.35 * Math.sin(x.ph) * x.th);
          x.env *= x.dk; x.th *= x.dkt;
          if (x.env < 1e-4 && x.th < 1e-4) { bg[j] = bg[bg.length - 1]; bg.pop(); this.bangFree.push(x); }
        }
        const bo = this.bangTube.process(this.bangLP.process(this.bangHP.process(bs)));
        eng += Math.tanh(bo * 1.6) * 0.9 * bangGain;
      } else {
        this.bangTube.process(0);
      }

      if (s.turbo > 0) {
        this.whPh += whF / sr;
        if (this.whPh > 1) this.whPh -= 1;
        const nz = this.noise();
        eng += ((this.whBP1.process(nz) + 0.5 * this.whBP2.process(nz)) * 7 + Math.sin(TAU * this.whPh) * 0.35) * whAmp;
        eng += this.whooshBP.process(this.noise()) * whooshAmp;
        if (this.flEnv > 0.001) {
          this.flPh += this.flRate / sr;
          const sn = Math.sin(TAU * this.flPh);
          const pulse = sn > 0 ? sn * sn * sn : 0;
          eng += (this.flBP.process(this.noise()) * 0.9 + this.flLP.process(this.noise()) * 1.4) * pulse * this.flEnv * s.flutter * 3.2;
          this.flEnv *= flDecay;
        }
        if (this.bovEnv > 0.001) {
          eng += this.bovBP.process(this.noise()) * this.bovEnv * 0.55 * s.bov;
          this.bovEnv *= bovDecay;
        }
      }

      // Boîte à pignons droits : engrènement permanent (lié au régime) + pignon du rapport engagé
      if (whineAmp > 0) {
        this.wPh1 += (rpm / 60) * teeth[0] / sr;
        if (this.wPh1 > 1) this.wPh1 -= 1;
        let w = Math.sin(TAU * this.wPh1) * 0.6 + Math.sin(2 * TAU * this.wPh1) * 0.15;
        if (gearTeeth) {
          this.wPh2 += (rpm / 60) * gearTeeth / sr;
          if (this.wPh2 > 1) this.wPh2 -= 1;
          w += Math.sin(TAU * this.wPh2) + 0.25 * Math.sin(2 * TAU * this.wPh2);
        }
        eng += w * whineAmp * (1 + 0.15 * this.noise());
      }

      if (starterAmp > 0) {
        this.stPhase += 1150 / sr;
        if (this.stPhase > 1) this.stPhase -= 1;
        const st = Math.sin(TAU * this.stPhase) + 0.4 * Math.sin(2 * TAU * this.stPhase + 1);
        eng += st * 0.035 * (0.6 + 0.4 * Math.sin(TAU * this.phase / 180));
      }

      const l = this.dc[0].process(exL + eng) * s.gain;
      const r = this.dc[1].process(exR + eng) * s.gain;
      L[k] = l > 1 || l < -1 ? Math.tanh(l) : l;
      if (R !== L) R[k] = r > 1 || r < -1 ? Math.tanh(r) : r;
    }
    return true;
  }
}

registerProcessor('engine', EngineProcessor);

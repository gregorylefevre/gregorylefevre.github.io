// Moteur thermique en modèle physique simplifié, exécuté dans le thread audio.
// - chaque cylindre émet une bouffée d'échappement à son angle de vilebrequin (ordre d'allumage réel)
// - les bouffées traversent des tubes résonants (collecteur puis ligne) : les résonances restent
//   fixes quand le régime monte, seule la cadence des combustions change, comme sur un vrai moteur
// - admission, bruits mécaniques, retours de flamme, turbo et démarreur sont ajoutés par-dessus

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

// Forme d'une bouffée d'échappement : montée rapide puis décroissance
const SHAPE_N = 512;
const SHAPE = new Float32Array(SHAPE_N + 1);
for (let i = 0; i <= SHAPE_N; i++) {
  const u = i / SHAPE_N;
  const rise = u < 0.12 ? Math.sin((Math.PI / 2) * (u / 0.12)) : 1;
  SHAPE[i] = rise * Math.exp(-4.2 * Math.max(0, u - 0.12)) * (1 - u);
}
const shapeAt = (u) => {
  const x = u * SHAPE_N, i = x | 0;
  return i >= SHAPE_N ? 0 : SHAPE[i] + (SHAPE[i + 1] - SHAPE[i]) * (x - i);
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
    for (let i = 0; i < 96; i++) this.free.push({ pos: 0, len: 1, amp: 0, noise: 0, bank: 0, delay: 0, intake: 0 });
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
  }

  setup(m) {
    const s = m.sound;
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
    this.hdr = [], this.tail = [];
    for (let b = 0; b < Math.max(2, this.nb); b++) {
      this.hdr.push(new Tube(s.header * (1 + b * 0.04), c, s.headerRefl, s.headerDamp));
      this.tail.push(new Tube(s.tail * (1 + b * 0.03), c, s.tailRefl, s.tailDamp));
    }
    this.muff = [new Biquad(), new Biquad()];
    this.body = [new Biquad().peaking(s.body[0], s.body[1], s.body[2]), new Biquad().peaking(s.body[0], s.body[1], s.body[2])];
    this.pres = [new Biquad().peaking(s.presence[0], s.presence[1], s.presence[2]), new Biquad().peaking(s.presence[0], s.presence[1], s.presence[2])];
    this.dc = [new Biquad().highpass(28), new Biquad().highpass(28)];
    this.intakeBP = new Biquad().bandpass(s.intake[0], s.intake[1]);
    this.intakeBP2 = new Biquad().bandpass(s.intake[0] * 2.7, s.intake[1] * 1.5);
    this.roarBP = new Biquad().bandpass(s.roar[0], s.roar[1]);
    this.mechHP = new Biquad().highpass(s.mech[0], 0.9);
    this.crackHP = new Biquad().highpass(1800, 0.7);
    this.hissBP = new Biquad().bandpass(6500, 2);
    this.bovBP = new Biquad().bandpass(3500, 2.5);
    this.active.forEach((p) => this.free.push(p));
    this.active.length = 0;
    this.phase = 0; this.next = 0; this.rpm = m.idle;
    this.cut = 0; this.liftoff = 0; this.intEnv = 0; this.mechEnv = 0; this.crackEnv = 0;
    this.boost = 0; this.whPhase = 0; this.bovEnv = 0; this.bovT = 0; this.prevThr = 0;
    this.stPhase = 0; this.starting = false;
    this.ready = true;
  }

  rejitter(jitDeg) {
    for (let i = 0; i < this.nc; i++) this.ang[i] = this.baseAng[i] + (this.rand() - 0.5) * jitDeg;
  }

  spawn(bank, amp, len, noise, delay, intake) {
    const p = this.free.pop();
    if (!p) return;
    p.pos = 0; p.len = Math.max(8, len); p.amp = amp; p.noise = noise; p.bank = bank; p.delay = delay; p.intake = intake;
    this.active.push(p);
  }

  fire(i, rpm, thr, rn, cranking) {
    const s = this.s;
    const bank = this.bankOf[i];
    const len = (s.pulseDeg / Math.max(rpm * 6, 1)) * sampleRate;
    if (cranking) {
      this.spawn(bank, 0.05 + this.rand() * 0.03, len * 0.8, 0.2, this.runner[i], 0.03);
      return;
    }
    const cutting = this.cut > 0;
    if (cutting) {
      this.spawn(bank, 0.1, len, 0.5, this.runner[i], 0.05);
    } else {
      const jit = 0.05 + s.lope * (1 - thr) * (1 - rn);
      let amp = (0.3 + 0.7 * Math.pow(thr, 0.75)) * this.bias[i] * (1 + (this.rand() - 0.5) * 2 * jit);
      if (thr < 0.05 && rn < 0.1 && this.rand() < s.lope * 0.12) amp *= 0.35;
      this.spawn(bank, amp, len, s.noise * (0.6 + 0.6 * thr), this.runner[i], -0.7 * amp);
    }
    this.mechEnv = 1;

    // Retours de flamme : carburant imbrûlé qui explose dans la ligne en décélération
    const overrun = thr < 0.1 && rn > 0.2;
    let prob = 0;
    if (cutting) prob = this.cutPops * 0.5;
    else if (overrun) prob = s.pops * rn * (this.liftoff > 0 ? 0.22 : 0.025);
    if (prob > 0 && this.rand() < prob) {
      const pb = this.nb > 1 ? (this.rand() * this.nb) | 0 : 0;
      const pAmp = (1.6 + this.rand() * 2.2) * (0.5 + 0.5 * s.pops);
      this.spawn(pb, pAmp, (0.0015 + this.rand() * 0.003) * sampleRate, 1.6, ((this.rand() * 0.02) * sampleRate) | 0, 0);
      this.crackEnv = Math.max(this.crackEnv, 0.6 + this.rand() * 0.6);
    }
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

    const rn = clamp((this.rpm - this.idle) / (this.redline - this.idle), 0, 1);
    const cutoff = s.muffler[0] + s.muffler[1] * (0.35 * thr + 0.65 * thr * rn) + s.muffler[2] * rn;
    this.muff[0].lowpass(cutoff, 0.8); this.muff[1].lowpass(cutoff, 0.8);
    this.roarBP.bandpass(s.roar[0] * (0.7 + 0.8 * rn), s.roar[1]);

    // Turbo : pression qui monte avec du retard, chute dès qu'on lâche
    if (s.turbo > 0) {
      const target = thr > 0.3 ? thr * Math.pow(rn, 0.5) : 0;
      const tau = target > this.boost ? 0.8 : 0.12;
      const prev = this.boost;
      this.boost += (target - this.boost) * (1 - Math.exp(-n / (tau * sr)));
      if (prev > 0.4 && thr < 0.12 && this.prevThr >= 0.12) { this.bovEnv = prev; this.bovT = 0; }
    }
    this.prevThr = thr;
    if (this.bovEnv > 0) {
      this.bovBP.bandpass(Math.max(900, 3800 - this.bovT * 6000), 2.2);
      this.bovT += n / sr;
    }

    const rpmK = 1 - Math.exp(-1 / (0.018 * sr));
    const jitDeg = 0.6 + s.lope * 6 * (1 - thr) * (1 - rn);
    const mechDecay = Math.exp(-1 / (0.0006 * sr));
    const crackDecay = Math.exp(-1 / (0.004 * sr));
    const intDecay = Math.exp(-1 / (0.01 * sr));
    const bovDecay = Math.exp(-1 / (0.18 * sr));
    const whFreq = 2200 + this.boost * 7800;
    const width = s.width, cross = s.cross;
    const exGain = s.exGain * (0.75 + 0.45 * thr);
    const drive = s.drive * (0.7 + 0.5 * thr);
    const driveNorm = 1 / Math.tanh(drive);

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

      let a = 0, b = 0, intk = 0;
      const act = this.active;
      for (let j = act.length - 1; j >= 0; j--) {
        const p = act[j];
        if (p.delay > 0) { p.delay--; continue; }
        const sh = shapeAt(p.pos / p.len);
        const v = p.amp * sh * (1 + p.noise * this.noise());
        if (p.bank === 0) a += v; else b += v;
        intk += p.intake * sh;
        if (++p.pos >= p.len) { act[j] = act[act.length - 1]; act.pop(); this.free.push(p); }
      }

      const ya = this.tail[0].process(this.hdr[0].process(a + cross * b));
      const yb = this.nb > 1 ? this.tail[1].process(this.hdr[1].process(b + cross * a)) : ya;
      let exL = (ya * (0.5 + 0.5 * width) + yb * (0.5 - 0.5 * width)) * exGain;
      let exR = (yb * (0.5 + 0.5 * width) + ya * (0.5 - 0.5 * width)) * exGain;
      exL = this.pres[0].process(this.body[0].process(this.muff[0].process(exL)));
      exR = this.pres[1].process(this.body[1].process(this.muff[1].process(exR)));
      exL = Math.tanh(exL * drive) * driveNorm;
      exR = Math.tanh(exR * drive) * driveNorm;

      this.intEnv = Math.max(Math.abs(intk), this.intEnv * intDecay);
      let eng = (this.intakeBP.process(intk) + 0.5 * this.intakeBP2.process(intk)) * s.intakeMix * (0.3 + thr);
      eng += this.roarBP.process(this.noise()) * s.roarMix * (0.1 + thr) * rn * (0.4 + this.intEnv);
      this.mechEnv *= mechDecay;
      eng += this.mechHP.process(this.noise()) * this.mechEnv * s.mechMix * (0.4 + 0.6 * rn);

      if (this.crackEnv > 0.0005) {
        eng += this.crackHP.process(this.noise()) * this.crackEnv * 0.5;
        this.crackEnv *= crackDecay;
      }
      if (s.turbo > 0) {
        this.whPhase += whFreq / sr;
        if (this.whPhase > 1) this.whPhase -= 1;
        eng += (Math.sin(TAU * this.whPhase) * 0.6 + this.hissBP.process(this.noise()) * 0.8) * this.boost * this.boost * s.turbo * 0.09;
        if (this.bovEnv > 0.001) {
          eng += this.bovBP.process(this.noise()) * this.bovEnv * 0.55;
          this.bovEnv *= bovDecay;
        }
      }
      if (starterAmp > 0) {
        this.stPhase += 1150 / sr;
        if (this.stPhase > 1) this.stPhase -= 1;
        const st = Math.sin(TAU * this.stPhase) + 0.4 * Math.sin(2 * TAU * this.stPhase + 1);
        eng += st * 0.035 * (0.6 + 0.4 * Math.sin(TAU * this.phase / 180));
      }

      let l = this.dc[0].process(exL + eng) * s.gain;
      let r = this.dc[1].process(exR + eng) * s.gain;
      L[k] = l > 1 || l < -1 ? Math.tanh(l) : l;
      if (R !== L) R[k] = r > 1 || r < -1 ? Math.tanh(r) : r;
    }
    return true;
  }
}

registerProcessor('engine', EngineProcessor);

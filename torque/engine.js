// Pilotage du moteur audio (AudioWorklet "engine-worklet.js") et profils des moteurs.
// Les paramètres "sound" décrivent l'architecture (angles d'allumage, bancs) et l'acoustique
// (longueurs de collecteur / ligne, silencieux, admission…) de chaque moteur.

const evenAngles = (n) => Array.from({ length: n }, (_, i) => (i * 720) / n);
const alternate = (n) => Array.from({ length: n }, (_, i) => i % 2);

export const PROFILES = {
  v8: {
    name: 'V8 Muscle', spec: '5.0 L · V8 vilebrequin croisé', accent: '#ff5a1f',
    cylinders: 8, idle: 750, redline: 6800, limiter: 7100,
    gears: [62, 98, 135, 172, 210, 255],
    sound: {
      // Ordre 1-8-4-3-6-5-7-2 : intervalles irréguliers par banc = grondement typique
      angles: evenAngles(8), banks: [0, 1, 1, 0, 1, 0, 0, 1],
      imbalance: 0.06, runnerSpread: 0.0004, soundSpeed: 470,
      header: 0.7, headerRefl: -0.5, headerDamp: 0.5,
      tail: 2.4, tailRefl: -0.6, tailDamp: 0.3,
      pulseDeg: 80, noise: 0.35, lope: 0.35,
      muffler: [450, 2800, 2200], body: [95, 1.1, 6], presence: [1800, 1, 3],
      intake: [240, 2.5], intakeMix: 0.35, roar: [900, 1.2], roarMix: 0.1,
      mech: [3500], mechMix: 0.03, pops: 1, turbo: 0,
      width: 0.55, cross: 0.12, exGain: 1, drive: 1.8, gain: 0.5,
    },
  },
  flat6: {
    name: 'Flat-6 GT', spec: '4.0 L · 6 cyl. à plat atmo', accent: '#2fd2ff',
    cylinders: 6, idle: 950, redline: 9000, limiter: 9200,
    gears: [68, 102, 138, 172, 208, 245, 300],
    sound: {
      angles: evenAngles(6), banks: alternate(6),
      imbalance: 0.04, runnerSpread: 0.0002, soundSpeed: 520,
      header: 0.5, headerRefl: -0.5, headerDamp: 0.55,
      tail: 1.5, tailRefl: -0.55, tailDamp: 0.35,
      pulseDeg: 60, noise: 0.3, lope: 0.12,
      muffler: [900, 4500, 4000], body: [210, 1.2, 5], presence: [2600, 1.2, 4],
      intake: [480, 3], intakeMix: 0.55, roar: [1600, 1.5], roarMix: 0.35,
      mech: [4200], mechMix: 0.08, pops: 0.55, turbo: 0,
      width: 0.4, cross: 0.35, exGain: 1, drive: 2.4, gain: 0.5,
    },
  },
  v10: {
    name: 'V10 Supercar', spec: '5.2 L · V10 atmo', accent: '#b6ff3b',
    cylinders: 10, idle: 1000, redline: 8500, limiter: 8700,
    gears: [70, 108, 145, 185, 225, 270, 320],
    sound: {
      angles: evenAngles(10), banks: alternate(10),
      imbalance: 0.04, runnerSpread: 0.0002, soundSpeed: 520,
      header: 0.48, headerRefl: -0.5, headerDamp: 0.55,
      tail: 1.35, tailRefl: -0.55, tailDamp: 0.35,
      pulseDeg: 55, noise: 0.3, lope: 0.1,
      muffler: [1000, 5000, 4500], body: [170, 1.1, 5], presence: [3000, 1, 4],
      intake: [560, 3], intakeMix: 0.5, roar: [1800, 1.4], roarMix: 0.4,
      mech: [4500], mechMix: 0.05, pops: 0.75, turbo: 0,
      width: 0.45, cross: 0.3, exGain: 1, drive: 2.6, gain: 0.5,
    },
  },
  v12: {
    name: 'V12 Hypercar', spec: '6.5 L · V12 atmo', accent: '#ff2e63',
    cylinders: 12, idle: 1000, redline: 9500, limiter: 9700,
    gears: [75, 115, 155, 195, 240, 285, 340],
    sound: {
      angles: evenAngles(12), banks: alternate(12),
      imbalance: 0.03, runnerSpread: 0.00015, soundSpeed: 540,
      header: 0.4, headerRefl: -0.5, headerDamp: 0.6,
      tail: 1.2, tailRefl: -0.5, tailDamp: 0.4,
      pulseDeg: 50, noise: 0.25, lope: 0.06,
      muffler: [1300, 6000, 6000], body: [240, 1, 4], presence: [3500, 1, 5],
      intake: [650, 3], intakeMix: 0.55, roar: [2200, 1.5], roarMix: 0.5,
      mech: [5000], mechMix: 0.04, pops: 0.4, turbo: 0,
      width: 0.4, cross: 0.45, exGain: 1, drive: 2.2, gain: 0.5,
    },
  },
  i4t: {
    name: 'Rally Turbo', spec: '2.0 L · 4 cyl. turbo', accent: '#ffd400',
    cylinders: 4, idle: 900, redline: 7200, limiter: 7400,
    gears: [55, 88, 120, 155, 190, 230],
    sound: {
      angles: evenAngles(4), banks: [0, 0, 0, 0],
      imbalance: 0.05, runnerSpread: 0.0003, soundSpeed: 480,
      header: 0.6, headerRefl: -0.5, headerDamp: 0.5,
      tail: 2.0, tailRefl: -0.6, tailDamp: 0.3,
      pulseDeg: 85, noise: 0.45, lope: 0.2,
      muffler: [500, 3000, 2000], body: [130, 1.2, 6], presence: [2000, 1, 3],
      intake: [380, 2.5], intakeMix: 0.25, roar: [1200, 1.2], roarMix: 0.15,
      mech: [3800], mechMix: 0.05, pops: 1.3, turbo: 1,
      width: 0.15, cross: 0, exGain: 1, drive: 3, gain: 0.36,
    },
  },
};

export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.running = false;
    this.profile = null;
  }

  async _init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule(new URL('./engine-worklet.js', import.meta.url));
    this.node = new AudioWorkletNode(this.ctx, 'engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });

    // Petite correction "habitacle" : basses renforcées, haut-médium adouci
    const low = this.ctx.createBiquadFilter();
    low.type = 'lowshelf'; low.frequency.value = 110; low.gain.value = 3;
    const harsh = this.ctx.createBiquadFilter();
    harsh.type = 'peaking'; harsh.frequency.value = 4200; harsh.Q.value = 0.8; harsh.gain.value = -3;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 3.5;
    comp.attack.value = 0.004; comp.release.value = 0.2;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    this.node.connect(low).connect(harsh).connect(comp).connect(this.master).connect(this.ctx.destination);
  }

  _sendProfile() {
    const p = this.profile;
    this.node.port.postMessage({ type: 'profile', sound: p.sound, idle: p.idle, redline: p.redline });
  }

  async start(profile, volume) {
    if (!this.ctx) await this._init();
    await this.ctx.resume();
    this.running = true;
    this.profile = profile;
    this._sendProfile();
    this.node.port.postMessage({ type: 'start' });
    this.update(profile.idle, 0);
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(volume, now);
    this.volume = volume;
  }

  async stop() {
    if (!this.ctx || !this.running) return;
    this.running = false;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(0, now, 0.12);
    await new Promise((r) => setTimeout(r, 800));
    if (!this.running) await this.ctx.suspend();
  }

  setVolume(v) {
    this.volume = v;
    if (this.ctx && this.running) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setProfile(p) {
    this.profile = p;
    if (!this.ctx || !this.running) return;
    const now = this.ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(0, now, 0.04);
    setTimeout(() => {
      if (!this.running) return;
      this._sendProfile();
      this.node.port.postMessage({ type: 'start' });
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }, 180);
  }

  update(rpm, throttle) {
    if (!this.ctx || !this.running) return;
    const now = this.ctx.currentTime;
    this.node.parameters.get('rpm').setTargetAtTime(rpm, now, 0.02);
    this.node.parameters.get('throttle').setTargetAtTime(throttle, now, 0.03);
  }

  liftOff() {
    if (this.running) this.node.port.postMessage({ type: 'liftoff' });
  }

  // Coupure d'allumage pendant le passage de rapport (avec "brap" à pleine charge)
  shift(up, throttle) {
    if (!this.running) return;
    this.node.port.postMessage({ type: 'cut', ms: up ? 70 : 30, pops: up && throttle > 0.7 ? 0.6 : 0 });
  }

  limiter() {
    if (this.running) this.node.port.postMessage({ type: 'cut', ms: 35, pops: 0.15 });
  }
}

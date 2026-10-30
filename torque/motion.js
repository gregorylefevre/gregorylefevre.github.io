// Estimation de la vitesse et de l'accélération longitudinale avec le moins de retard possible.
// - GPS : environ 1 mesure/s, vitesse fiable mais en retard
// - accéléromètre (téléphone, ou voiture si le navigateur l'expose) : instantané mais dérive
// Un filtre de Kalman combine les deux : l'accéléromètre donne la réactivité, le GPS recale la vitesse.

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.sqrt(dot(a, a));
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const unit = (a) => { const l = len(a); return l > 1e-9 ? scale(a, 1 / l) : [0, 0, 0]; };
const ema = (cur, x, dt, tau) => cur + (x - cur) * (1 - Math.exp(-dt / tau));
const emaV = (cur, x, dt, tau) => { const k = 1 - Math.exp(-dt / tau); return add(cur, scale(sub(x, cur), k)); };

function haversine(a, b) {
  const R = 6371000, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem('torque.' + k)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem('torque.' + k, JSON.stringify(v)); } catch {} },
};

// ---------- GPS ----------
export class GpsSource {
  constructor(onFix, onStatus) { this.onFix = onFix; this.onStatus = onStatus; this.id = null; }
  start() {
    if (!('geolocation' in navigator)) { this.onStatus('err', 'GPS · indisponible'); return; }
    if (this.id != null) return;
    this.last = null;
    this.onStatus('wait', 'GPS · recherche…');
    this.id = navigator.geolocation.watchPosition(
      (pos) => this._fix(pos),
      (err) => this.onStatus('err', err.code === 1 ? 'GPS · refusé' : 'GPS · erreur'),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  }
  stop() {
    if (this.id != null) navigator.geolocation.clearWatch(this.id);
    this.id = null; this.last = null;
    this.onStatus('off', 'GPS · off');
  }
  _fix(pos) {
    const c = pos.coords, t = pos.timestamp;
    const here = { lat: c.latitude, lon: c.longitude, t };
    // Vitesse Doppler fournie par la puce GPS : bien plus précise que la distance entre deux points
    let v = Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null;
    let sigma = 0.4;
    if (v === null) {
      if (!this.last) { this.last = here; return; }
      const dt = (t - this.last.t) / 1000;
      if (dt < 0.2) return;
      v = haversine(this.last, here) / dt;
      sigma = clamp(c.accuracy / dt / 3, 0.8, 5);
    }
    this.last = here;
    this.onStatus('ok', `GPS · ±${Math.round(c.accuracy)} m`);
    this.onFix(v < 0.5 ? 0 : v, sigma);
  }
}

// ---------- Accéléromètre ----------
export class MotionSensor {
  constructor(onStatus) {
    this.onStatus = onStatus;
    this.handler = (e) => this._onMotion(e);
    this.reset();
  }
  reset() {
    this.samples = 0; this.up = null; this.gLP = null; this.h = [0, 0, 0];
    this.hSum = [0, 0, 0]; this.hT = 0;
    this.S = [0, 0, 0]; this.W = 0; this.n = 0;
    this.fwd = null; this.along = 0; this.lastT = 0; this.listening = false;
  }
  get calibrated() { return this.fwd !== null; }
  // Accélération longitudinale (m/s², positive en accélérant) ou null si indisponible
  accel() { return this.calibrated && performance.now() - this.lastT < 500 ? this.along : null; }

  // À appeler depuis un clic (iOS exige une permission demandée lors d'un geste de l'utilisateur)
  async start() {
    if (this.listening) return;
    if (typeof window.DeviceMotionEvent === 'undefined') { this.onStatus('off', 'Capteur · absent'); return; }
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        if ((await DeviceMotionEvent.requestPermission()) !== 'granted') { this.onStatus('err', 'Capteur · refusé'); return; }
      } catch { this.onStatus('err', 'Capteur · refusé'); return; }
    }
    this.reset();
    this.listening = true;
    window.addEventListener('devicemotion', this.handler);
    this.onStatus('wait', 'Capteur · détection…');
    clearTimeout(this.detect);
    this.detect = setTimeout(() => { if (this.listening && this.samples < 5) this.onStatus('off', 'Capteur · absent'); }, 3000);
  }
  stop() {
    window.removeEventListener('devicemotion', this.handler);
    clearTimeout(this.detect);
    this.listening = false;
    this.onStatus('off', 'Capteur · off');
  }

  _onMotion(e) {
    const ai = e.accelerationIncludingGravity, al = e.acceleration;
    if (!ai || ai.x == null || ai.y == null || ai.z == null) return;
    const now = performance.now();
    const dt = this.lastT ? clamp((now - this.lastT) / 1000, 0.001, 0.2) : 0.016;
    this.lastT = now;
    const gi = [ai.x, ai.y, ai.z];
    let lin;
    if (al && al.x != null) {
      // Le système a déjà séparé la gravité grâce au gyroscope
      lin = [al.x, al.y, al.z];
      this.gLP = this.gLP ? emaV(this.gLP, sub(gi, lin), dt, 0.5) : sub(gi, lin);
    } else {
      this.gLP = this.gLP ? emaV(this.gLP, gi, dt, 2.5) : gi;
      lin = sub(gi, this.gLP);
    }
    this.up = unit(this.gLP);
    // On ne garde que la composante horizontale (avant/arrière + latérale)
    const hz = sub(lin, scale(this.up, dot(lin, this.up)));
    this.h = emaV(this.h, hz, dt, 0.06);
    this.hSum = add(this.hSum, scale(this.h, dt));
    this.hT += dt;
    this.samples++;

    if (this.samples === 30) this._restore();
    if (this.fwd) this.along = dot(this.h, this.fwd);
    if (this.samples === 5) this.onStatus('wait', this.fwd ? 'Capteur · actif' : 'Capteur · calibrage…');
  }

  // Calibrage automatique : la direction "avant" est celle qui corrèle avec les accélérations vues par le GPS
  learn(aGps) {
    if (!this.listening || this.hT < 0.3) return;
    const mean = scale(this.hSum, 1 / this.hT);
    this.hSum = [0, 0, 0]; this.hT = 0;
    if (Math.abs(aGps) < 0.5 || !this.up) return;
    const c = scale(mean, aGps);
    this.S = add(scale(this.S, 0.95), c);
    this.W = this.W * 0.95 + len(mean) * Math.abs(aGps);
    this.n++;
    const consistency = len(this.S) / (this.W || 1);
    if (this.n >= 4 && consistency > 0.6) {
      const f = unit(sub(this.S, scale(this.up, dot(this.S, this.up))));
      const fresh = !this.fwd;
      this.fwd = this.fwd ? unit(add(scale(this.fwd, 0.8), scale(f, 0.2))) : f;
      store.set('imu', { up: this.up, fwd: this.fwd });
      if (fresh) this.onStatus('ok', 'Capteur · actif');
    }
  }

  // Réutilise le calibrage précédent si l'appareil est resté dans la même position
  _restore() {
    const saved = store.get('imu');
    if (!saved || !this.up || !Array.isArray(saved.up) || !Array.isArray(saved.fwd)) return;
    if (dot(saved.up, this.up) > 0.97) {
      this.fwd = unit(sub(saved.fwd, scale(this.up, dot(saved.fwd, this.up))));
      this.onStatus('ok', 'Capteur · actif');
    }
  }
}

// ---------- Fusion (filtre de Kalman à 2 états) ----------
// Avec accéléromètre : état [vitesse, biais de l'accéléromètre]
// Sans : état [vitesse, accélération], modèle à accélération quasi constante
export class SpeedEstimator {
  // Agitation supposée de l'accélération (m/s³)² : plus haut = plus réactif mais plus instable
  static jerk = 20;
  constructor() { this.reset(); }
  reset() {
    this.v = 0; this.x2 = 0; this.P = [[25, 0], [0, 4]];
    this.imu = false; this.a = 0; this.lastFix = 0; this.vFix = null;
  }

  predict(dt, aImu) {
    const useImu = aImu != null;
    if (useImu !== this.imu) {
      this.imu = useImu;
      this.x2 = 0;
      this.P[1][1] = useImu ? 0.25 : 4; this.P[0][1] = this.P[1][0] = 0;
    }
    const P = this.P;
    let q00, q01, q11, f01;
    if (useImu) {
      this.a = aImu - this.x2;
      this.v += this.a * dt;
      f01 = -dt;
      q00 = 0.35 ** 2 * dt; q01 = 0; q11 = 0.02 ** 2 * dt;
    } else {
      // Sans nouvelle mesure GPS depuis un moment, on cesse d'extrapoler l'accélération
      if (performance.now() - this.lastFix > 2500) this.x2 *= Math.exp(-dt / 0.5);
      this.a = this.x2;
      this.v += this.a * dt;
      f01 = dt;
      const q = SpeedEstimator.jerk;
      q00 = (q * dt ** 3) / 3; q01 = (q * dt ** 2) / 2; q11 = q * dt;
    }
    const p00 = P[0][0] + 2 * f01 * P[0][1] + f01 * f01 * P[1][1] + q00;
    const p01 = P[0][1] + f01 * P[1][1] + q01;
    const p11 = P[1][1] + q11;
    this.P = [[p00, p01], [p01, p11]];
    if (this.v < 0) this.v = 0;
  }

  update(vMeas, sigma) {
    const P = this.P;
    const r = sigma * sigma;
    const s = P[0][0] + r;
    const k0 = P[0][0] / s, k1 = P[1][0] / s;
    const y = vMeas - this.v;
    this.v += k0 * y;
    this.x2 += k1 * y;
    if (this.imu) this.x2 = clamp(this.x2, -1.5, 1.5);
    else this.x2 = clamp(this.x2, -12, 12);
    this.P = [[(1 - k0) * P[0][0], (1 - k0) * P[0][1]], [P[1][0] - k1 * P[0][0], P[1][1] - k1 * P[0][1]]];
    this.lastFix = performance.now();
    if (vMeas === 0 && this.v < 0.3) this.v = 0;
  }

  // Charge moteur déduite de l'accélération (le navigateur n'a pas accès à la pédale)
  throttle() {
    if (this.v < 0.5 && this.a < 0.4) return 0;
    if (this.a < -0.3) return 0;
    return clamp(0.15 + this.a / 2.6, 0, 1);
  }
}

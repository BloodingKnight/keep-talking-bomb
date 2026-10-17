// Seeded pseudo-random generator + small helpers shared across the game engine.
// Deterministic per (seed) so a bomb can be regenerated for tests/replays.

export function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  constructor(seed) {
    this.state = (typeof seed === 'number' ? seed : hashStr(String(seed))) >>> 0 || 0x9e3779b9;
  }
  next() {
    // xorshift32
    let x = this.state;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.state = x || 0x9e3779b9;
    return this.state / 0x100000000;
  }
  int(n) { return Math.floor(this.next() * n); }
  range(lo, hi) { return lo + this.int(hi - lo + 1); }
  pick(arr) { return arr[this.int(arr.length)]; }
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  sample(arr, n) { return this.shuffle(arr).slice(0, n); }
  bool(p = 0.5) { return this.next() < p; }
}

export const SERIAL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
export const SERIAL_VOWELS = ['A', 'E', 'I', 'O', 'U'];

export function makeSerial(rng) {
  const l = () => rng.pick(SERIAL_LETTERS);
  const d = () => String(rng.int(10));
  return `${l()}${l()}${d()}${l()}${d()}${d()}`;
}

export function hasVowel(serial) {
  return SERIAL_VOWELS.some((v) => serial.includes(v));
}

export function serialLastDigit(serial) {
  return Number(serial[serial.length - 1]);
}

export function serialOdd(serial) {
  return serialLastDigit(serial) % 2 === 1;
}

export function fmtTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

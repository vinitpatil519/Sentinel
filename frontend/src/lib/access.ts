/**
 * Console access gate.
 *
 * What this is: a screen lock that keeps the console closed to anyone without
 * the code, and keeps the telemetry socket closed until the code is entered —
 * nothing is fetched or held in memory behind the lock screen.
 *
 * What this is not: access control. The check runs in the browser, so anyone
 * with the bundle and patience can get past it, and the backend API on :8010
 * answers whoever asks. Real access control belongs in front of the backend.
 *
 * Only a salted SHA-256 of the code ships in the bundle, so reading the source
 * does not reveal it. The code is hashed as typed, including the terminating
 * `#` (e.g. `123456#`). To change it without editing this file, set
 * NEXT_PUBLIC_SENTINEL_ACCESS_HASH (read at build time) to the hex digest of
 * `${SALT}<code>`:
 *
 *   python -c "import hashlib;print(hashlib.sha256(b'sentinel/access/v1:123456#').hexdigest())"
 *
 * SHA-256 is implemented here rather than taken from `crypto.subtle`, because
 * `crypto.subtle` exists only in a secure context, and the console is commonly
 * served over plain HTTP on a LAN address (the Jetson), where it is undefined.
 */

const SALT = "sentinel/access/v1:";
const DEFAULT_HASH = "cf08c6f729a15d536d9cabb8133ecde547a31633dd5c4e04f7868fce5accb2c9";
const ACCESS_HASH = (process.env.NEXT_PUBLIC_SENTINEL_ACCESS_HASH ?? DEFAULT_HASH).toLowerCase();

/** Session flag: cleared when the tab closes, so every new tab asks again. */
export const SESSION_KEY = "sentinel.access";
const LOCKOUT_KEY = "sentinel.lockout";

export function verifyCode(code: string): boolean {
  return sha256Hex(SALT + code) === ACCESS_HASH;
}

// ---- lockout ----------------------------------------------------------------

export type Lockout = { failures: number; until: number };

export const FREE_ATTEMPTS = 3;

/**
 * How long the keypad stays locked after `failures` consecutive wrong codes:
 * free attempts first, then a lockout that doubles with each further miss.
 */
export function lockoutFor(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  return Math.min(30_000 * 2 ** (failures - FREE_ATTEMPTS), 15 * 60_000);
}

// Lockout lives in localStorage so that reloading the page does not reset it.
export function readLockout(): Lockout {
  try {
    const raw = localStorage.getItem(LOCKOUT_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Lockout;
      if (typeof v.failures === "number" && typeof v.until === "number") return v;
    }
  } catch {
    /* storage unavailable: no persisted lockout */
  }
  return { failures: 0, until: 0 };
}

export function writeLockout(v: Lockout) {
  try {
    if (v.failures === 0) localStorage.removeItem(LOCKOUT_KEY);
    else localStorage.setItem(LOCKOUT_KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

export function readGranted(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === "granted";
  } catch {
    return false;
  }
}

export function writeGranted(granted: boolean) {
  try {
    if (granted) sessionStorage.setItem(SESSION_KEY, "granted");
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable: access lasts for this page load only */
  }
}

// ---- SHA-256 (FIPS 180-4) ---------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const ror = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export function sha256Hex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const total = ((bytes.length + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  const bits = bytes.length * 8;
  view.setUint32(total - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(total - 4, bits >>> 0);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Uint32Array(64);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = ror(W[i - 15], 7) ^ ror(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = ror(W[i - 2], 17) ^ ror(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = W[i - 16] + s0 + W[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] += a;
    H[1] += b;
    H[2] += c;
    H[3] += d;
    H[4] += e;
    H[5] += f;
    H[6] += g;
    H[7] += h;
  }
  return Array.from(H, (x) => x.toString(16).padStart(8, "0")).join("");
}

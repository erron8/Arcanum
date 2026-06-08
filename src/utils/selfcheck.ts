import { calculateATHDrawdown } from './indicators';

/**
 * Verification self-check from the plan:
 *   calculateATHDrawdown([1,2,3,2,1.5],[1,2,3,2,1.5])
 *   ⇒ ath=[1,2,3,3,3], drawdownPct≈[0,0,0,33.33,50]
 */
function approxEqual(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

const highs = [1, 2, 3, 2, 1.5];
const closes = [1, 2, 3, 2, 1.5];
const result = calculateATHDrawdown(highs, closes);

const expectedAth = [1, 2, 3, 3, 3];
const expectedDd = [0, 0, 0, (1 / 3) * 100, 50]; // 33.333…

let pass = result.length === expectedAth.length;
for (let i = 0; i < expectedAth.length && pass; i++) {
  const r = result[i]!;
  if (r.ath === null || !approxEqual(r.ath, expectedAth[i]!)) pass = false;
  if (r.drawdownPct === null || !approxEqual(r.drawdownPct, expectedDd[i]!)) pass = false;
}

console.log('ath        =', result.map((r) => r.ath));
console.log('drawdownPct=', result.map((r) => (r.drawdownPct === null ? null : Number(r.drawdownPct.toFixed(2)))));
console.log(pass ? 'PASS' : 'FAIL');

if (!pass) process.exit(1);

// Line diff (LCS) for spec revisions. Inputs are bounded by the 64 KiB source limit.
export interface DiffLine { op: ' ' | '+' | '-'; text: string; a?: number; b?: number }

export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  if (n * m > 4_000_000) return [{ op: '-', text: '(diff too large to compute)' }];
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ op: ' ', text: A[i], a: i + 1, b: j + 1 }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: '-', text: A[i], a: i + 1 }); i++; }
    else { out.push({ op: '+', text: B[j], b: j + 1 }); j++; }
  }
  while (i < n) { out.push({ op: '-', text: A[i], a: i + 1 }); i++; }
  while (j < m) { out.push({ op: '+', text: B[j], b: j + 1 }); j++; }
  return out;
}

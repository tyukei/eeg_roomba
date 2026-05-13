/**
 * Tiny radix-2 in-place complex FFT and helpers for computing a 1-channel
 * PSD via Welch's method, all in browser JS. Designed for the live buffer
 * (50 Hz, 500 samples).
 */

/** Cooley-Tukey radix-2 FFT in place. n must be a power of 2. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const idx = i + k;
        const jdx = i + k + len / 2;
        const tRe = curRe * re[jdx] - curIm * im[jdx];
        const tIm = curRe * im[jdx] + curIm * re[jdx];
        re[jdx] = re[idx] - tRe;
        im[jdx] = im[idx] - tIm;
        re[idx] += tRe;
        im[idx] += tIm;
        const ncRe = curRe * wRe - curIm * wIm;
        const ncIm = curRe * wIm + curIm * wRe;
        curRe = ncRe; curIm = ncIm;
      }
    }
  }
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/**
 * Welch PSD estimate of a 1-D time series.
 * Returns frequencies (Hz) and PSD (μV²/Hz).
 *
 * @param x       Real-valued samples.
 * @param fs      Sampling rate (Hz).
 * @param nperseg FFT length (power of 2). Default 128.
 * @param overlap Fraction overlap, default 0.5.
 */
export function welch(
  x: number[] | Float64Array,
  fs: number,
  nperseg = 128,
  overlap = 0.5,
): { freqs: Float64Array; psd: Float64Array } {
  // Pad/truncate nperseg to power of two.
  let nfft = 1; while (nfft < nperseg) nfft <<= 1;
  const step = Math.max(1, Math.floor(nfft * (1 - overlap)));
  const w = hann(nfft);
  // Window normalization for PSD (Σ w²).
  let wsum2 = 0;
  for (let i = 0; i < nfft; i++) wsum2 += w[i] * w[i];

  const half = nfft / 2 + 1;
  const psd = new Float64Array(half);
  let segs = 0;

  // Detrend (subtract mean) once.
  let mean = 0;
  for (let i = 0; i < x.length; i++) mean += x[i];
  mean /= Math.max(1, x.length);

  for (let start = 0; start + nfft <= x.length; start += step) {
    const re = new Float64Array(nfft);
    const im = new Float64Array(nfft);
    for (let i = 0; i < nfft; i++) re[i] = (x[start + i] - mean) * w[i];
    fft(re, im);
    for (let k = 0; k < half; k++) {
      const mag2 = re[k] * re[k] + im[k] * im[k];
      // density: divide by fs and window energy
      psd[k] += mag2 / (fs * wsum2);
    }
    segs++;
  }
  if (segs > 0) for (let k = 0; k < half; k++) psd[k] /= segs;
  // Double-side -> one-side (Nyquist + DC stay single)
  for (let k = 1; k < half - 1; k++) psd[k] *= 2;

  const freqs = new Float64Array(half);
  for (let k = 0; k < half; k++) freqs[k] = (k * fs) / nfft;
  return { freqs, psd };
}

/** Pearson correlation between two equal-length arrays. */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  const denom = Math.sqrt(da * db);
  return denom > 0 ? num / denom : 0;
}

/** Compute full NCH x NCH correlation matrix. */
export function corrMatrix(channels: number[][]): number[][] {
  const n = channels.length;
  const m: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    m[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const r = pearson(channels[i], channels[j]);
      m[i][j] = r; m[j][i] = r;
    }
  }
  return m;
}

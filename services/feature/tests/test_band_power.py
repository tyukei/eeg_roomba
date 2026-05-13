"""Unit tests for feature._band_power.

Verifies the band-power integral against analytic expectations on a flat PSD.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import _band_power  # noqa: E402


def test_band_power_flat_psd_one_channel() -> None:
    """For a constant PSD of 1 V²/Hz, integral over [lo, hi] should equal (hi - lo)."""
    freqs = np.linspace(0, 50, 501)  # 0.1 Hz resolution
    psd = np.ones_like(freqs)
    p = _band_power(freqs, psd, 8.0, 13.0)
    # trapezoidal integration of constant 1 over [8,13] ≈ 5
    assert abs(float(p) - 5.0) < 0.05


def test_band_power_multi_channel_shape() -> None:
    """psd_t shape [ch, F] → result shape [ch]."""
    freqs = np.linspace(0, 50, 101)
    psd_t = np.ones((4, freqs.size)) * np.arange(1, 5)[:, None]  # ch i has psd=i+1
    out = _band_power(freqs, psd_t, 8.0, 13.0)
    assert out.shape == (4,)
    # ch0 = 1*5, ch1 = 2*5, ch2 = 3*5, ch3 = 4*5 (approximately)
    np.testing.assert_allclose(out, [5.0, 10.0, 15.0, 20.0], atol=0.1)


def test_band_power_excludes_outside_band() -> None:
    """A delta-like PSD spike outside the band must not contribute."""
    freqs = np.linspace(0, 50, 501)
    psd = np.zeros_like(freqs)
    # Place huge spike at 20 Hz, outside α band 8-13
    psd[np.argmin(np.abs(freqs - 20.0))] = 1e6
    p = _band_power(freqs, psd, 8.0, 13.0)
    assert float(p) < 1.0  # essentially zero


def test_band_power_alpha_band_picks_up_alpha_spike() -> None:
    """A spike at 10 Hz must be captured by the α band."""
    freqs = np.linspace(0, 50, 501)
    psd = np.zeros_like(freqs)
    psd[np.argmin(np.abs(freqs - 10.0))] = 100.0
    p = _band_power(freqs, psd, 8.0, 13.0)
    assert float(p) > 0.0


def test_band_power_realistic_eeg_alpha() -> None:
    """Roughly-uniform PSD of 10 μV²/Hz across α band should give ~50 μV²."""
    freqs = np.linspace(0, 50, 501)
    psd = np.where((freqs >= 8) & (freqs <= 13), 10.0, 0.0)
    p = _band_power(freqs, psd, 8.0, 13.0)
    # 10 μV²/Hz * 5 Hz = 50 μV²
    assert 40.0 < float(p) < 60.0

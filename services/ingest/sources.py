"""EEG source adapters. Swap LSL ⇄ MQTT ⇄ file-replay without touching ingest."""
from __future__ import annotations

import abc
import time
from collections.abc import Iterator
from dataclasses import dataclass


@dataclass
class Chunk:
    samples: list[list[float]]   # shape: [n_samples][n_channels]
    timestamps: list[float]      # unix epoch seconds, len == n_samples


class EEGSource(abc.ABC):
    @property
    @abc.abstractmethod
    def srate(self) -> float: ...
    @property
    @abc.abstractmethod
    def n_channels(self) -> int: ...

    @abc.abstractmethod
    def stream(self) -> Iterator[Chunk]: ...

    def close(self) -> None: ...


class LSLSource(EEGSource):
    def __init__(self, name: str, timeout: float = 10.0) -> None:
        from pylsl import StreamInlet, local_clock, resolve_byprop  # type: ignore

        streams = resolve_byprop("name", name, timeout=timeout)
        if not streams:
            raise RuntimeError(f"LSL stream '{name}' not found")
        self._inlet = StreamInlet(streams[0], max_buflen=60, recover=True)
        info = self._inlet.info()
        self._srate = info.nominal_srate()
        self._nch = info.channel_count()
        # LSL local_clock ≠ unix time; capture offset once.
        self._lsl_to_unix = time.time() - local_clock()

    @property
    def srate(self) -> float:
        return self._srate

    @property
    def n_channels(self) -> int:
        return self._nch

    def stream(self) -> Iterator[Chunk]:
        while True:
            samples, ts = self._inlet.pull_chunk(timeout=1.0, max_samples=64)
            if not samples:
                continue
            yield Chunk(samples=samples, timestamps=[t + self._lsl_to_unix for t in ts])


class FileReplaySource(EEGSource):
    """Replay a .npy / .csv file as if it were live (for demos / CI)."""

    def __init__(self, path: str, srate: float = 250.0, nch: int = 16) -> None:
        import numpy as np

        if path.endswith(".npy"):
            self._data = np.load(path).astype("float32")
        else:
            self._data = np.loadtxt(path, delimiter=",", dtype="float32")
        if self._data.shape[1] != nch:
            raise ValueError(f"expected {nch} channels, got {self._data.shape[1]}")
        self._srate = srate
        self._nch = nch

    @property
    def srate(self) -> float:
        return self._srate

    @property
    def n_channels(self) -> int:
        return self._nch

    def stream(self) -> Iterator[Chunk]:
        chunk = 25  # 100 ms
        period = chunk / self._srate
        i = 0
        next_tick = time.perf_counter()
        while True:
            block = self._data[i : i + chunk]
            if len(block) == 0:
                i = 0
                continue
            now = time.time()
            ts = [now + k / self._srate for k in range(len(block))]
            yield Chunk(samples=block.tolist(), timestamps=ts)
            i += chunk
            next_tick += period
            sleep = next_tick - time.perf_counter()
            if sleep > 0:
                time.sleep(sleep)
            else:
                next_tick = time.perf_counter()

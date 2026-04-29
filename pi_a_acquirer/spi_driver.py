"""PiEEG-16 SPI driver.

Extracted from upstream `2.Graph_Gpio_D _1_5_4_OS.py`. Two ADS129x chips on
SPI0/SPI1, 16ch total at 250 Hz, 24-bit signed samples scaled to microvolts.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass

import gpiod
import spidev

# Conversion: ±4.5V full scale across 24-bit signed → uV
_UV_SCALE = 1_000_000 * 4.5 / (2**23 - 1)

_FRAME_BYTES = 27  # 3 status + 8ch * 3byte
_CS_LINE = 19      # GPIO line for chip-select multiplexing
_GPIO_CHIP = "gpiochip4"


def _open_spi(bus: int) -> spidev.SpiDev:
    spi = spidev.SpiDev()
    spi.open(bus, 0)
    spi.max_speed_hz = 1_000_000
    spi.mode = 0b01  # CPOL=0, CPHA=1
    spi.bits_per_word = 8
    return spi


def _init_chip(spi: spidev.SpiDev) -> None:
    # Reset + stop continuous + write registers
    spi.xfer2([0x06])  # RESET
    spi.xfer2([0x11])  # SDATAC
    # CONFIG1=0x96 (250 SPS), CONFIG2=0xD4, CONFIG3=0xFF
    spi.xfer2([0x41, 0x00, 0x96])
    spi.xfer2([0x42, 0x00, 0xD4])
    spi.xfer2([0x43, 0x00, 0xFF])
    # All channels normal input gain 24 (0x60)
    for reg in range(0x05, 0x0D):
        spi.xfer2([0x40 | reg, 0x00, 0x60])
    spi.xfer2([0x10])  # RDATAC
    spi.xfer2([0x08])  # START


def _decode_frame(buf: bytes) -> list[float]:
    """27 bytes → 8 float32 µV values."""
    out: list[float] = []
    for i in range(8):
        b0, b1, b2 = buf[3 + i * 3], buf[4 + i * 3], buf[5 + i * 3]
        # 24-bit signed
        raw = (b0 << 16) | (b1 << 8) | b2
        if raw & 0x800000:
            raw -= 0x1000000
        out.append(raw * _UV_SCALE)
    return out


@dataclass
class FrameStats:
    samples: int = 0
    spi_errors: int = 0


class PiEEG16:
    """Two-chip 16-channel reader. Blocking, returns one 16ch sample per call."""

    def __init__(self) -> None:
        self.spi_a = _open_spi(0)
        self.spi_b = _open_spi(1)
        chip = gpiod.Chip(_GPIO_CHIP)
        self.cs_line = chip.get_line(_CS_LINE)
        self.cs_line.request(consumer="pieeg-cs", type=gpiod.LINE_REQ_DIR_OUT)
        _init_chip(self.spi_a)
        _init_chip(self.spi_b)
        self.stats = FrameStats()

    def read_sample(self) -> list[float]:
        try:
            self.cs_line.set_value(0)
            a = bytes(self.spi_a.xfer2([0x00] * _FRAME_BYTES))
            b = bytes(self.spi_b.xfer2([0x00] * _FRAME_BYTES))
            self.cs_line.set_value(1)
        except OSError:
            self.stats.spi_errors += 1
            raise
        self.stats.samples += 1
        return _decode_frame(a) + _decode_frame(b)

    def close(self) -> None:
        try:
            self.spi_a.close()
            self.spi_b.close()
            self.cs_line.release()
        except Exception:
            pass

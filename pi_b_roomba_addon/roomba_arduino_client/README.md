# roomba_arduino_client

Pi-B 側で動く **Arduino シリアル制御 + USB カメラ MJPEG** の FastAPI ブリッジ。
上流リポ `roomba_arudino_raspberrypi_client` のスナップショットを eeg_roomba 内に
取り込んだもの。`8000/tcp` で listen し、PC 側 `services/api` がこれを叩く。

## eeg_roomba との関係

| eeg_roomba コンポーネント | このサービスから使う | 場所 |
|---|---|---|
| `services/api` `/control/{cmd}` proxy | `POST /command/{cmd}` | PC |
| `services/api` `/camera/stream` proxy | `GET  /camera/stream` (MJPEG) | PC |
| `services/api` `/autopilot/*` orchestrator | `GET /camera/stream` のみ | PC |
| `pi_b_roomba_addon/mqtt_state_publisher.py` | `GET /command/__probe__` 経由でserial state | Pi-B |

このサービス自身も `/autopilot/*` を持つが (`auto_pilot.py` の Gemini Robotics 連携)、
**eeg_roomba は PC 側で autopilot を実行する**ため、ここの `/autopilot/*` は使わない。
スタンドアロン運用 (eeg_roomba を経由せず直接ブラウザから操作) 用に残してある。

## ハードウェア構成

```
[USB Camera] ──USB──┐
                    ├─→ [Raspberry Pi 4] ──USB──→ [Arduino Uno] ──TTL(5V)──→ [iRobot Roomba]
[GPIO]              ┘     (このサービス)              (roomba.ino)               (Mini-DIN 7pin)
```

### 配線

Arduino Uno と Roomba (Open Interface 対応モデル) のシリアル接続:

| Arduino Pin | Roomba Mini-DIN | 信号 |
|---|---|---|
| Pin 10 | TX (pin 3) | Arduino RX (Roomba → Arduino) |
| Pin 11 | RX (pin 4) | Arduino TX (Arduino → Roomba) |
| GND    | GND (pin 6,7) | 共通グランド |

参考: [Roomba Open Interface 仕様 (Adafruit ミラー)](https://cdn-shop.adafruit.com/datasheets/create_2_Open_Interface_Spec.pdf)

### 分圧について

- **Arduino ↔ Roomba は両方 5V TTL のためレベル変換不要。** 直結で問題なし。
- ただし以下のケースでは分圧が必要:
  - **Raspberry Pi の GPIO (3.3V) を Roomba に直結する場合**:
    Roomba TX (5V) → Pi RX (3.3V) は Pi 側を破損するため、抵抗分圧 (例 10kΩ / 18kΩ で
    5V→3.2V) もしくはレベルシフタ (BSS138 など) が必須。本構成では Arduino を
    仲介させてこの問題を回避している。
  - **Roomba の Vpwr (バッテリー、約 14〜21V) から Arduino を給電する場合**:
    7805 などの 5V レギュレータか、降圧 DC-DC コンバータが必要。
    USB 給電で済むなら不要。

本サービスのデフォルト構成は **USB 給電 + Arduino 仲介** で、追加の分圧回路は
要求しない。

## 通信プロトコル

**PC (`services/api`) → このサービス**: HTTP REST
- `POST /connect`, `/disconnect`
- `POST /command/{forward|right|left|back|stop|clean|pause|dock}`
- `GET /state` (serial connection + latest Open Interface sensor snapshot)
- `POST /camera/start`, `/camera/stop`
- `GET  /camera/stream` (multipart/x-mixed-replace; boundary=frame)
- `GET  /ports`, `/camera/status`

**このサービス → Arduino**: 9600 baud USB serial, 1 byte ASCII

| char | 動作 |
|---|---|
| `'0'` (48) | 前進 |
| `'1'` (49) | 右旋回 |
| `'2'` (50) | 左旋回 |
| `'3'` (51) | 後退 |
| `'c'` | 掃除開始 |
| `'p'` | 掃除停止して Safe mode に戻る |
| `'d'` | ホームベース探索 |
| `'i'` | バンパー・壁・段差・バッテリー状態を問い合わせる |
| その他 | 停止 |

**Arduino → Roomba**: 115200 baud SoftwareSerial, Roomba OI バイナリ
- Opcode 128 (Start) → 131 (Safe mode) を起動時に送信
- Opcode 146 (Drive PWM) で左右モーター個別制御 (`motor(l, r)`)
- 1コマンドにつき 1 秒間駆動 → 自動停止 (`roomba.ino:62-70`)

## デプロイ (Pi-B)

```bash
# 1. uv で venv 構築
cd /home/pi/Documents/eeg_roomba/pi_b_roomba_addon/roomba_arduino_client
uv venv && source .venv/bin/activate
uv pip install -r <(uv pip compile pyproject.toml)
# or just:  uv pip install fastapi uvicorn[standard] pyserial pydantic opencv-python-headless python-dotenv google-genai

# 2. Arduino ファームウェアを焼く
#    Arduino IDE で roomba.ino を開いて Uno に書き込む

# 3. systemd unit を登録
sudo cp roomba-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now roomba-api
sudo systemctl status roomba-api
```

ユーザーは `dialout` グループに入れておくこと (`/dev/ttyACM0` への書き込み権限)。

## ディレクトリ

| ファイル | 役割 |
|---|---|
| `roomba.ino` | Arduino Uno ファームウェア (SoftwareSerial で Roomba OI を喋る) |
| `roomba_api.py` | FastAPI サーバー (serial + camera + autopilot) |
| `auto_pilot.py` | スタンドアロン用 Gemini Robotics autopilot (eeg_roomba は不使用) |
| `roomba_controller.py` | CLI デバッグツール (対話モードで Arduino に直接 byte を送る) |
| `roomba-api.service` | systemd unit |
| `pyproject.toml` | 依存パッケージ |

## 注意

- Roomba のボーレートはモデルにより異なる。`roomba.ino` は 115200 baud を仮定。
  異なる場合は `device.begin(...)` を変更すること。
- Arduino IDE のシリアルモニタを開いたまま API サーバーを起動するとポート競合する。

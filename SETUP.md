# セットアップ手順

3ノード (PC / Pi-A / Pi-B) を一通り立ち上げる手順。Pythonは全て **uv** で管理する。

---

## 0. 事前にすべて (各マシン共通)

### 0.1 uv のインストール
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
# シェルを再起動 or:
source $HOME/.local/bin/env
uv --version
```

### 0.2 NTP同期 (3ノード共通・必須)
時刻同期はLSL/MQTTのレイテンシ計測とDB時刻整合のために必須。
```bash
sudo timedatectl set-ntp true
timedatectl status   # System clock synchronized: yes であること
```

---

## 1. PC (解析・DB・UI 集約ノード)

### 1.1 Docker / Docker Compose
```bash
# macOS: Docker Desktop
# Linux:
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
docker compose version
```

### 1.2 リポジトリ取得 & 環境変数
```bash
git clone <this-repo> eeg_roomba && cd eeg_roomba
cp .env.example .env
# .env を編集:
#   ROOMBA_HTTP_BASE=http://<Pi-B の hostname or IP>:8000
#   ALPHA_CHANNELS=6,7   (後頭部相当の電極番号)
```

### 1.3 lockfile 生成 (任意・推奨)
各サービス毎に1回だけ:
```bash
for d in services/ingest services/feature services/decision services/api; do
  (cd $d && uv lock)
done
```
`uv.lock` ができる。これをコミットすると Docker build が `uv sync --frozen` で再現可能になる。

### 1.4 起動
```bash
docker compose up -d --build
docker compose ps    # 全部 healthy / running
docker compose logs -f ingest feature decision api
```
- WebUI: http://localhost:5173
- API: http://localhost:8080/healthz → `{"status":"ok"}`
- Mosquitto: TCP 1883 / WebSocket 9001
- TimescaleDB: localhost:5432 (eeg/eeg)

### 1.5 ローカル開発 (コンテナを使わずホスト Python で動かす場合)
```bash
cd services/api
uv sync                       # .venv を作成 + 依存解決
uv run uvicorn main:app --reload --port 8080
# 同様に他サービスも:
cd ../ingest && uv sync && uv run python main.py
```

### 1.6 動作確認 (PC側だけで完結する範囲)
```bash
# DB疎通
docker compose exec timescaledb \
  psql -U eeg -d eeg -c "SELECT count(*) FROM eeg_raw;"

# MQTT疎通
docker run --rm --network host eclipse-mosquitto:2 \
  mosquitto_sub -h localhost -t '#' -v
```

---

## 2. Pi-A (PiEEG-16 を載せた Raspberry Pi)

### 2.1 OS / SPI / GPIO 有効化
Raspberry Pi OS (64bit, Bookworm 推奨)。
```bash
sudo raspi-config            # Interface > SPI > Enable
sudo apt update
sudo apt install -y python3 python3-pip libgpiod2 git
sudo reboot
```

### 2.2 配置
```bash
sudo mkdir -p /opt/pi_a_acquirer
sudo cp -r pi_a_acquirer/. /opt/pi_a_acquirer/
sudo tee /opt/pi_a_acquirer/.env > /dev/null <<EOF
MQTT_HOST=<analysis-pc.local or IP>
MQTT_PORT=1883
LSL_STREAM_NAME=PiEEG-16
EOF
```

### 2.3 uv で依存解決 (root権限。SPI/GPIO アクセスのため)
```bash
sudo -i
curl -LsSf https://astral.sh/uv/install.sh | sh
source $HOME/.local/bin/env
cd /opt/pi_a_acquirer
uv sync                       # 初回。/opt/pi_a_acquirer/.venv 作成
uv run python acquirer.py     # フォアグラウンド試走
# → 'PiEEG-16 acquisition started: 16ch @ 250 Hz' が出れば OK。Ctrl-C で止める。
exit
```

### 2.4 systemd 化
```bash
sudo cp /opt/pi_a_acquirer/systemd/pieeg.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pieeg
sudo systemctl status pieeg
journalctl -u pieeg -f
```

### 2.5 PC側からの疎通確認
```bash
# PC側の任意の uv 環境で:
uv run --with pylsl python -c "from pylsl import resolve_streams; print(resolve_streams())"
# → name='PiEEG-16', type='EEG', srate=250, ch=16

# health
mosquitto_sub -h <analysis-pc> -t 'pieeg/health' -v
# → samples_last_sec が 250 前後で出る
```

---

## 3. Pi-B (Roomba 制御 Raspberry Pi)

> Arduino シリアル制御 + USB カメラ MJPEG の FastAPI ブリッジ (`8000/tcp`) が
> 動いている前提。リポジトリ内の `pi_b_roomba_addon/roomba_arduino_client/` に
> ソースのスナップショットがある (`roomba.ino`, `roomba_api.py`, 配線・分圧
> ドキュメント等)。新規 Pi-B 立て直しの場合はそちらの README を参照のこと。

### 3.1 既存 FastAPI の稼働確認
```bash
curl http://localhost:8000/   # 既存 API がレスポンスすること
```

### 3.2 MQTT state publisher を追加配置
```bash
sudo mkdir -p /opt/pi_b_roomba_addon
sudo cp -r pi_b_roomba_addon/. /opt/pi_b_roomba_addon/
sudo tee /opt/pi_b_roomba_addon/.env > /dev/null <<EOF
MQTT_HOST=<analysis-pc.local or IP>
MQTT_PORT=1883
ROOMBA_HTTP_BASE=http://localhost:8000
EOF
```

### 3.3 uv で依存解決
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
source $HOME/.local/bin/env
cd /opt/pi_b_roomba_addon
uv sync
uv run python mqtt_state_publisher.py   # フォアグラウンド試走
```

### 3.4 systemd 化
```bash
sudo cp /opt/pi_b_roomba_addon/roomba-state.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now roomba-state
journalctl -u roomba-state -f
```

### 3.5 確認
```bash
# PC側:
mosquitto_sub -h <analysis-pc> -t 'roomba/state' -v
# → online:true が 1Hz で
curl -X POST http://<analysis-pc>:8080/control/0   # PCのAPI経由でRoomba前進
```

---

## 4. E2E動作確認 (3ノード結合)

1. **WebUI** http://<analysis-pc>:5173 を開く
   - 上段: 16ch 波形 (10秒バッファ)
   - 中段: α band power per ch
   - 右パネル: PiEEG online / Decision idle / Roomba ok / 閾値スライダ / 手動制御
2. **開眼/閉眼テスト**: 閉眼で後頭部 ch (例: ch6/ch7) のα バーが2倍以上に伸びる
3. **閾値超過 → Roomba** : スライダで `enter` を 5 程度に下げて閉眼 → `Decision: active` に遷移、Roomba が走る
4. **`exit` を超えて idle** に戻ると Roomba 停止

---

## 5. uv 運用のチートシート

| やりたいこと | コマンド |
|---|---|
| 依存追加 | `cd services/feature && uv add scipy` |
| 依存削除 | `uv remove scipy` |
| lockfile更新 | `uv lock` |
| 完全再作成 | `rm -rf .venv && uv sync` |
| 開発依存 | `uv add --dev pytest ruff` |
| 一回限りスクリプト | `uv run --with mne python analyze.py` |
| Pythonバージョン固定 | `uv python pin 3.12` |
| Docker再ビルド (lock変更時) | `docker compose build --no-cache <svc>` |

### lockfile 運用ルール
- `uv.lock` は **コミットする** (本番再現性のため)
- 依存追加したら `uv lock` → コミット → 各ノード `git pull && uv sync --frozen`
- Dockerfile は `uv sync --frozen` で固定インストール

---

## 6. トラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| `pylsl` が PiEEG-16 を見つけない | LAN分断/ファイアウォール。`mosquitto_sub` で `pieeg/health` が見えるかまず確認。LSLは UDP multicast 必要 |
| `ingest` でDB queue full | TimescaleDB が遅い。`docker compose logs timescaledb` 確認、SSD化、`max_connections` 上げる |
| `decision_svc` で Roomba HTTP 502 | `.env` の `ROOMBA_HTTP_BASE` 誤り or Pi-B側 FastAPI 落ち |
| Pi-A で `OSError: SPI` | `raspi-config` で SPI 有効化忘れ、または別プロセスが SPI を占有 |
| α power が常時 0 | フィルタで殺し過ぎ。`feature/main.py` の HP cutoff (1Hz) と LP (40Hz) を確認 |
| `uv sync` が遅い (Pi) | `~/.cache/uv` をSSD/USB に移す、もしくは `UV_INDEX_STRATEGY=first-index` |
| Docker build で `--frozen` 失敗 | lockfile未生成。Dockerfile はフォールバックで `uv sync` する設計だが、明示的に `uv lock` を先に実行する |

---

## 7. 片付け
```bash
# PC
docker compose down -v       # ボリューム含めて削除
# Pi-A
sudo systemctl disable --now pieeg
sudo rm /etc/systemd/system/pieeg.service /opt/pi_a_acquirer -rf
# Pi-B
sudo systemctl disable --now roomba-state
sudo rm /etc/systemd/system/roomba-state.service /opt/pi_b_roomba_addon -rf
```

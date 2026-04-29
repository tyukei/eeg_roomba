# EEG → α band power → Roomba pipeline

PiEEG-16 で取得した16ch EEG から α 帯バンドパワーをリアルタイム計算し、しきい値超過で Roomba を駆動する3ノード構成のIoTパイプライン。

```
Pi-A (PiEEG)  ──LSL──▶  PC ──HTTP──▶  Pi-B (Roomba)
              ─MQTT─▶                ─MQTT─▶
```

## 構成

| ノード | 役割 | コンポーネント |
|---|---|---|
| Pi-A | EEG取得 | `pi_a_acquirer/acquirer.py` (SPI→LSL Outlet + MQTT health) |
| PC | 解析・永続化・UI | `services/{ingest,feature,decision,api}` + TimescaleDB + Mosquitto + React |
| Pi-B | Roomba制御 | 既存FastAPI + `pi_b_roomba_addon/` (MQTT state) |

## bring-up

> **詳細手順は [SETUP.md](SETUP.md) 参照**。Pythonは全サービス [uv](https://docs.astral.sh/uv/) で管理 (`pyproject.toml` + `uv.lock`)。


### 1. PC
```bash
cp .env.example .env
# .env を編集 (ROOMBA_HTTP_BASE を Pi-B の IP/hostname に)
docker compose up -d --build
```
- Frontend: http://localhost:5173
- API: http://localhost:8080
- TimescaleDB: localhost:5432
- Mosquitto: 1883 (TCP) / 9001 (WebSocket)

### 2. Pi-A (PiEEG-16 を載せた Pi)
```bash
sudo cp -r pi_a_acquirer /opt/
sudo cp pi_a_acquirer/systemd/pieeg.service /etc/systemd/system/
echo "MQTT_HOST=<analysis-pc>" | sudo tee /opt/pi_a_acquirer/.env
sudo -i bash -lc 'cd /opt/pi_a_acquirer && uv sync'
sudo systemctl enable --now pieeg
```
動作確認 (PCで):
```bash
python -c "from pylsl import resolve_streams; print(resolve_streams())"
# → name='PiEEG-16', type='EEG', srate=250, ch=16
```

### 3. Pi-B (Roomba 既存リポジトリの隣)
```bash
sudo cp -r pi_b_roomba_addon /opt/
sudo cp pi_b_roomba_addon/roomba-state.service /etc/systemd/system/
cd /opt/pi_b_roomba_addon && uv sync
sudo systemctl enable --now roomba-state
```

## トピック / API

### MQTT
| topic | publisher | 用途 | retain |
|---|---|---|---|
| `pieeg/health` | acquirer | サンプル数・SPI errors | yes |
| `eeg/chunk` | ingest | 全rate生サンプル(chunk) | no |
| `eeg/live` | ingest | 50Hz down-sampled (UI向け) | no |
| `eeg/alpha` | feature | per-ch α/β/θ band power | yes |
| `control/state` | decision | idle / active | yes |
| `control/threshold` | API | 閾値設定 (UI→decision) | yes |
| `roomba/state` | pi_b_addon | Pi-B生死 | yes |
| `roomba/cmd` | decision | 直近送信コマンド | no |

### REST (PC `api`)
- `GET /history/alpha?seconds=60[&ch=N]`
- `POST /control/{cmd}` (Roomba HTTPプロキシ)
- `POST /threshold` body: `{enter, exit, dwell_ms, channels}`
- `WS /ws` 全トピックfan-out

## 検証手順

1. **疎通**: 上記 `resolve_streams()` で `PiEEG-16` 検出
2. **DB蓄積**: `docker compose exec timescaledb psql -U eeg -d eeg -c "SELECT count(*) FROM eeg_raw;"` が増える
3. **α power**: `mosquitto_sub -h localhost -t 'eeg/alpha' -v` でJSON流れる
4. **開眼/閉眼テスト**: 後頭部相当ch (ALPHA_CHANNELS=6,7) のα powerが閉眼で2倍以上になる
5. **Roomba**: WebUI manual control / α 閾値超過で `decision_svc` ログに `state idle -> active` 表示
6. **耐障害**: Pi-A停止→`pieeg/health` が `online=false` (last-will) → UIに反映

## 比較実験フック

ingest の `EEGSource` adapter を差し替えれば LSL ⇄ ファイル再生 ⇄ MQTT を入替可能:
```bash
EEG_SOURCE=file EEG_REPLAY_PATH=./recording.npy docker compose up ingest
```
将来 `MQTTSource` を追加する際もここに足すだけ。

## 範囲外 (Phase2 候補)
- TLS / 認証 (現状 LAN前提)
- クラウド延伸 (IoT Core / Kinesis など)
- リアルタイムICA / アーティファクト除去
- LSL vs MQTT/ZeroMQ の正式ベンチ

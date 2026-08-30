# roomba_mobile

スマホをコントローラにしてルンバを動かすだけの単体アプリ。
EEG パイプライン（PiEEG / MQTT / TimescaleDB / LLM）には一切依存しない。

```
スマホのブラウザ ──HTTP/WS──> Pi-B: app.py ──serial──> Arduino ──OI──> Roomba
                                    └─MJPEG─ USB カメラ（任意）
```

## 使い方

スマホで Pi-B の 8000 番を開くだけ。

| 経路 | URL |
|---|---|
| Tailscale | `http://100.118.69.111:8000/` |
| 同一 LAN | `http://<pi-b の LAN IP>:8000/` |

ホーム画面に追加すると PWA としてフルスクリーン起動する。

- **ジョイスティック**: 倒した方向に走る。指を離すと中央に戻って自動で停止
- **停止**: 即時停止
- **掃除開始 / 一時停止 / ホームへ**: Roomba OI の clean / pause / dock
- **⚙**: シリアルポート選択・接続/切断・カメラ ON/OFF

起動時に自動でシリアル接続するので、通常は ⚙ を触る必要はない。

## 安全機構

移動コマンドは Arduino 側で「止めるまで走り続ける」実装なので、通信が切れると
ルンバが走りっぱなしになる。これを二重で塞いでいる。

1. **サーバ側ウォッチドッグ** — 移動コマンドが `ROOMBA_HOLD_TIMEOUT_MS`（既定 800ms）
   更新されなければ `stop` を送る。UI は押下中 300ms ごとに再送する
2. **WebSocket 切断 = 停止** — ソケットが閉じた時点で `stop`

画面を隠す・別アプリに切り替える・ブラウザを閉じる、のいずれでも停止する。

## 環境変数

| 変数 | 既定 | 意味 |
|---|---|---|
| `ROOMBA_SERIAL_PORT` | 空（自動検出） | Arduino のシリアルポート。Pi-B は `/dev/ttyS0` |
| `ROOMBA_BAUD` | `9600` | ボーレート（`roomba.ino` と一致させる） |
| `ROOMBA_HTTP_PORT` | `8000` | 待ち受けポート |
| `ROOMBA_HOLD_TIMEOUT_MS` | `800` | ウォッチドッグの猶予 |
| `ROOMBA_CAM_WIDTH` / `ROOMBA_CAM_HEIGHT` | `480` / `360` | 映像の解像度 |
| `ROOMBA_CAM_FPS` | `8` | 映像の fps |
| `ROOMBA_CAM_QUALITY` | `45` | JPEG 品質 (15-90) |

## HTTP API

置き換え対象の旧 `roomba_api.py` とパスを揃えてあるので、既存の利用者
（EEG スタックの `services/api`、`mqtt_state_publisher`）はそのまま動く。
`/autopilot/*` のみ削除した。

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/` | コントローラ UI |
| GET | `/healthz` | 死活確認 |
| GET | `/ports` | シリアルポート一覧 |
| POST | `/connect` `/disconnect` | シリアル接続制御 |
| POST | `/command/{cmd}` | `forward` `back` `left` `right` `stop` `clean` `pause` `dock` |
| GET | `/state` | 接続状態 + センサ（バッテリ・バンパー・段差） |
| POST | `/camera/start` `/camera/stop` | カメラ制御 |
| GET | `/camera/status` `/camera/stream` | 状態 / MJPEG |
| WS | `/ws/control` | `{"cmd": "forward"}` を送る低遅延チャネル |

## Pi-B へのデプロイ

```bash
ssh pi-b
cd ~/Documents/eeg_roomba && git pull
cd roomba_mobile && uv sync

# 旧 roomba-api.service と 8000 番を奪い合うので、先に止める
sudo systemctl disable --now roomba-api.service
sudo cp roomba-mobile.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now roomba-mobile.service
```

## カメラについて

映像は **MJPEG**（`multipart/x-mixed-replace`）で、`<img src="/camera/stream">` がそのまま再生する。
1 フレームが 1 枚の JPEG なので帯域は **fps × 画質** にほぼ比例する。既定は 480x360 / 8fps /
JPEG 品質 45 と軽めに振ってある。滑らかさが欲しければ上の環境変数で上げられる。

USB カメラは `/dev/video0-9` を走査して最初に読めたデバイスを使う
（`/dev/video10` 以降は Pi 内蔵の ISP / コーデックで映像は取れない）。
カメラ未接続なら UI のカメラ切り替えは自動的に無効になり、走行操作には影響しない。

## テスト

```bash
cd roomba_mobile && uv run pytest
```

シリアルとカメラはモックするので実機なしで通る。

# 脳波でルンバを動かす — PiEEG × Raspberry Pi × Docker で作るリアルタイムBCIパイプライン

## はじめに

「目を閉じるとルンバが走り出し、目を開けると止まる」——そんなBCI (Brain-Computer Interface) システムを、PiEEG-16・Raspberry Pi 2台・PC 1台で構築しました。

本記事では、16チャンネル脳波からαパワーをリアルタイム計算し、閾値超過でRoombaを駆動する3ノードIoTパイプラインの設計と実装を紹介します。

## システム概要

```
Pi-A (PiEEG-16)  ──LSL (UDP)──▶  PC (Docker Compose)  ──HTTP──▶  Pi-B (Roomba)
SPI 250Hz×16ch                    ingest / feature /               FastAPI既存
+ MQTT health                     decision / api / DB / UI         + MQTT state
```

### 3ノード構成

| ノード | ハードウェア | 役割 |
|---|---|---|
| **Pi-A** | Raspberry Pi + PiEEG-16 HAT | SPI で 250Hz×16ch 取得 → LSL ストリーム配信 |
| **PC** | 解析用マシン | 取込・特徴抽出・判定・DB・API・WebUI (全部 Docker Compose) |
| **Pi-B** | Raspberry Pi + Roomba | HTTP で Roomba を前進/停止制御 |

### なぜ3ノードに分けたか

SPIのリアルタイム読み出しは「絶対に落としたくない」軽量ループです。一方、PSD計算やDB書き込みはCPU/IOが重く、ジッタを生みます。同居させるとサンプル落ちが起きやすいため、取得と解析を物理的に分離しました。

## アーキテクチャ詳細

### プロトコル選定: LSL + MQTT + HTTP のハイブリッド

3つのプロトコルを「得意領域」で使い分けています。

| レイヤ | プロトコル | 理由 |
|---|---|---|
| 生波形ストリーム | **LSL** (Lab Streaming Layer) | EEG/BCIの事実標準。ナノ秒精度のtime-sync、自動discovery。MNE-Python等と互換 |
| 状態通知・制御 | **MQTT** (Mosquitto) | IoTの事実標準。retain/last-will/QoS/WebSocket対応。軽量でPiでも動く |
| Roomba駆動 | **HTTP** | Pi-B側の既存FastAPIをそのまま流用。リクエスト頻度が低いので十分 |

**他の候補を採らなかった理由:**
- **MQTTのみで生EEG**: 250Hzサンプル単位publishはオーバヘッド大。time-syncも自前で再発明が必要
- **ZeroMQ**: brokerlessで魅力だが、discovery/永続化/認証を自前実装。3ノード+1人運用にはオーバー
- **Kafka**: 単一PC・3ノード構成では完全にoverkill

### MQTTトピック設計

| トピック | 発行元 | 用途 | retain |
|---|---|---|---|
| `pieeg/health` | acquirer | PiEEG生死・統計 | yes |
| `eeg/chunk` | ingest | 全rate生サンプル (feature_svc向け) | no |
| `eeg/live` | ingest | 50Hzダウンサンプル (UI向け) | no |
| `eeg/alpha` | feature | per-ch α/β/θ帯域パワー | yes |
| `control/state` | decision | idle / active 状態 | yes |
| `control/threshold` | API/UI | 閾値動的設定 | yes |
| `roomba/cmd` | decision | 直近のRoombaコマンド | no |

## 各サービスの実装

### 1. Pi-A: SPI取得 → LSL配信 (`pi_a_acquirer/`)

PiEEG-16ボードはADS129xチップ2基をSPIで接続し、16チャンネル250Hzで脳波を取得します。

```python
# spi_driver.py — 24bit符号付きサンプルをμVに変換
_UV_SCALE = 1_000_000 * 4.5 / (2**23 - 1)

def read_sample(self) -> list[float]:
    self.cs_line.set_value(0)
    a = bytes(self.spi_a.xfer2([0x00] * 27))  # chip A: 8ch
    b = bytes(self.spi_b.xfer2([0x00] * 27))  # chip B: 8ch
    self.cs_line.set_value(1)
    return _decode_frame(a) + _decode_frame(b)  # 16ch
```

取得したサンプルはpylslで即座にpushし、同時にMQTTでヘルスビーコン（サンプル数、SPIエラー数）を1秒間隔で送信します。last-willメッセージにより、Pi-Aが落ちると自動的にoffline通知がretainされます。

### 2. ingest: LSL受信 → TimescaleDB + MQTT分配

**アダプタパターン**で入力ソースを抽象化しています。

```python
class EEGSource(abc.ABC):
    @abc.abstractmethod
    def stream(self) -> Iterator[Chunk]: ...

class LSLSource(EEGSource):    # 本番: PiEEGからのLSLストリーム
class FileReplaySource(EEGSource):  # 開発: .npy/.csvをリアルタイム再生
```

`EEG_SOURCE=file` に切り替えるだけで、PiEEGなしでもパイプライン全体を動作テストできます。

受信データは2系統に分配されます:
- **TimescaleDB**: `asyncpg.copy_records_to_table` で250Hz全rateを `eeg_raw` テーブルへバルク挿入
- **MQTT**: `eeg/chunk`(全rate、feature_svc向け)と`eeg/live`(50Hzダウンサンプル、UI向け)

### 3. feature: Welch PSD → 帯域パワー抽出

1秒のスライディングウィンドウ（250msホップ）でWelch PSDを計算し、3帯域のバンドパワーを抽出します。

| 帯域 | 周波数範囲 | 意味 |
|---|---|---|
| θ (theta) | 4–8 Hz | 眠気・瞑想 |
| **α (alpha)** | **8–13 Hz** | **閉眼でリラックス時に増大** ← 今回の判定対象 |
| β (beta) | 13–30 Hz | 集中・緊張 |

前処理として、1Hzハイパスフィルタ、40Hzローパスフィルタ、50/60Hzノッチフィルタ（商用電源ノイズ除去）を適用しています。

```python
freqs, psd = welch(x, fs=250, nperseg=min(256, x.shape[0]), axis=0)
alpha = np.trapezoid(psd[..., (freqs >= 8) & (freqs <= 13)], ...)
```

### 4. decision: ヒステリシス付き状態機械 → Roomba制御

αパワーの閾値判定には**シュミットトリガ方式のヒステリシス**を採用しています。

```
                    enter_th = 10 μV²
  idle ─────────────────────────────────▶ active (Roomba前進)
         ◀─────────────────────────────
                    exit_th = 6 μV²
              + dwell 500ms (チャタリング防止)
```

- **enter_th ≠ exit_th**: 不感帯を作ることで、ノイズによる頻繁な状態遷移を防止
- **dwell_ms**: 閾値を超えてから一定時間持続して初めて遷移。瞬間的なスパイクを無視
- 閾値はMQTT retainで動的更新。WebUIのスライダから即座に変更可能

後頭部相当のチャンネル（デフォルト: ch6, ch7）のαパワー平均値を使用します。閉眼で後頭部αが約2倍に増大する生理学的知見を利用しています。

### 5. api: FastAPI + WebSocketプロキシ

MQTTの全トピックをWebSocketで束ねてブラウザに配信します。

```
ブラウザ ←──WebSocket──→ api ←──MQTT──→ mosquitto ←── 各サービス
```

REST APIも提供:
- `GET /history/alpha?seconds=60` — TimescaleDBからα power履歴を取得
- `POST /control/{cmd}` — Pi-BのRoomba HTTPへプロキシ
- `POST /threshold` — 閾値をMQTT retainで更新

### 6. frontend: React + uPlot リアルタイムダッシュボード

16チャンネルの波形を50Hzで10秒バッファ描画します。uPlotはCanvas描画のため16系列×数千点でも軽量です。

画面構成:
- **左パネル**: 16ch EEGリアルタイム波形 + チャンネル別αパワー棒グラフ
- **右パネル**: PiEEG/Decision/Roombaの状態表示、閾値スライダ、手動制御ボタン

## データベース設計 (TimescaleDB)

PostgreSQL拡張のTimescaleDBで、生波形・特徴量・イベントを単一DBに統合しています。

```sql
-- 生波形: 1時間チャンク、chでセグメント圧縮、14日保持
CREATE TABLE eeg_raw (ts TIMESTAMPTZ, ch SMALLINT, uv REAL);
-- → hypertable化 + 自動圧縮(1日後) + 自動パージ(14日後)

-- 特徴量: α/β/θ帯域パワー
CREATE TABLE eeg_features (ts TIMESTAMPTZ, ch SMALLINT, alpha REAL, beta REAL, theta REAL);

-- イベント: 状態遷移等のログ
CREATE TABLE events (ts TIMESTAMPTZ, kind TEXT, payload JSONB);
```

`compress_segmentby = 'ch'`で16chの時系列データが効率よく圧縮されます（実測5–10倍）。後解析ではSQLで自由にクエリできるため、MNE-Python等に食わせるエクスポートも容易です。

## Docker Compose による一発起動

PC側は7コンポーネント（TimescaleDB、Mosquitto、ingest、feature、decision、api、frontend）を`docker compose up -d --build`で一発起動できます。

```yaml
services:
  timescaledb:  # TimescaleDB (PostgreSQL 16)
  mosquitto:    # Eclipse Mosquitto 2
  ingest:       # LSL→DB + MQTT fan-out (host network: LSLマルチキャスト検出用)
  feature:      # Welch PSD → α/β/θ
  decision:     # 閾値判定 → Roomba HTTP
  api:          # FastAPI + WebSocket (port 8080)
  frontend:     # React + Vite (port 5173)
```

Pi-A / Pi-Bはsystemdユニットで管理し、同一リポジトリから配備します。

## 開発Tips

### PiEEGなしでの開発

`.env`で`EEG_SOURCE=file`を設定すれば、`.npy`/`.csv`ファイルを250Hzでリプレイして全パイプラインを動かせます。

```bash
EEG_SOURCE=file EEG_REPLAY_PATH=./recording.npy docker compose up ingest
```

### パッケージ管理: uv

全PythonサービスをAstralの[uv](https://docs.astral.sh/uv/)で管理しています。`uv.lock`をコミットし、Dockerfileは`uv sync --frozen`で決定的ビルドを行います。

## レイテンシ設計

| 区間 | 目標 | 手段 |
|---|---|---|
| SPI読込→LSL出力 | < 5ms | acquirerの固定周期ループ |
| LSL→ingest受信 | < 20ms | LSL time_correction |
| Welch計算 (1秒窓) | < 50ms | scipy.welch (PC上) |
| MQTT publish→subscribe | < 20ms | LAN内Mosquitto |
| Roomba HTTP往復 | < 100ms | httpx async |
| **E2E (SPI→Roomba応答)** | **< 500ms (中央値)** | NTP同期下で結合計測 |

生データは250Hz×16ch×4byte = **約16KB/s** と非常に小さく、帯域がボトルネックになることはありません。

## まとめ

このシステムの設計思想は **「各層を得意領域のプロトコルで構成し、標準ツールで結合する」** ことです。

- **波形はLSL** (EEG業界標準、time-sync付き)
- **状態と制御はMQTT** (IoT標準、retain/last-will/QoS)
- **既存資産はHTTP** (Roomba FastAPI)
- **永続化はTimescaleDB** (SQL互換、圧縮・保持ポリシー宣言的)
- **UIはReact + uPlot** (16ch×50Hz軽量描画)

各コンポーネントはアダプタパターンとコンテナ化で疎結合にしてあり、スケール要件が変わったときに局所的に置換できる構造になっています。

### 今後の展望

- TLS/認証の追加（現状はLAN内前提で意図的に省略）
- MQTT bridge によるクラウド延伸（AWS IoT Core等）
- リアルタイムICA / アーティファクト除去
- α以外の特徴量（α/β比、CSP等）による分類精度向上
- TimescaleDB → Parquet エクスポートによるMNE-Pythonオフライン解析

---

**リポジトリ**: 全ソースコードはモノレポ構成で管理されており、`docker compose up`と2台のPiのsystemd有効化だけで動作します。

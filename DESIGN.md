# Design Rationale — EEG → Roomba パイプライン

各設計判断について「**要件 / 候補 / なぜそれを選んだか / 覆す条件**」を記載。
レビューや発表で根拠を問われたとき、この順で答える。

---

## 0. 前提となる量と制約 (これを毎回最初に提示する)

| 項目 | 値 | 含意 |
|---|---|---|
| サンプリング | 250 Hz × 16ch × 4 byte | **生データ約 16 KB/s** ≪ 1 Mbps。帯域は支配要因にならない |
| α power 推定窓 | 1 秒 / hop 250 ms | E2E レイテンシ予算 ~500 ms (中央値) |
| ノード | Pi-A (PiEEG) / Pi-B (Roomba) / PC (解析) | **LAN内3ノード**、クラウド前提なし |
| 用途 | 研究・PoC・記録残したい | 本番SLAなし、ただし**再現性と後解析**が重要 |

> **覆す条件**: ノード数が増えてWAN越えする、サンプリングが2kHz以上になる、24/7本番運用になる → 設計を見直す

---

## 1. ストリーミング層: なぜ LSL + MQTT のハイブリッドか

### 候補
1. **LSL のみ** で全部 (制御もテレメトリも)
2. **MQTT のみ** で全部 (生EEGも)
3. **ZeroMQ** brokerless
4. **Kafka** / Redis Streams で集約
5. **LSL (生EEG) + MQTT (テレメトリ・制御)** ← 採用

### なぜ採用案か
- **LSL は EEG/BCI の事実標準**。`pylsl` 数行で発行/受信、**ns 精度のtime-sync**、自動discovery、OpenBCI/MNE/BCI2000等とそのまま互換 → 後で別装置を混ぜたり既存BCIツールに食わせる時にコストゼロ。
- ただし LSL は **永続化なし・認証なし・LAN前提**。状態通知・retain・QoS・WebUI連携は不向き。
- **MQTT** は IoT の事実標準で、retain / last-will / QoS / WebSocket bridge を全部持つ。Mosquitto は Pi でも軽い。Grafana / Node-RED 等と連携が容易。
- **HTTP は既存 Roomba FastAPI を活かす** ため。新規プロトコルに置換する必然性がない (リクエスト数/秒が小さい)。
- 結論: **「波形は LSL、状態と制御は MQTT、既存資産は HTTP」**=各レイヤを得意領域で使う最小構成。

### なぜ他を採らなかったか
- **MQTT のみで生EEG**: 250 Hz サンプル単位 publish はオーバヘッド大。chunk化すれば動くが、time-sync を自分で再発明する羽目になる。BCI ツールとの互換も失う。
- **ZeroMQ**: 低レイテンシは魅力だが brokerless ゆえ discovery / 永続化 / 認証を自前実装。3ノード+1人運用には**運用コストが割に合わない**。
- **Kafka / Redis Streams**: 単一PC・単一プロデューサ・3ノード構成では**オーバキル**。fan-out 数 ≪ 10、保存は TimescaleDB が引き受ける。
- **LSL のみ**: 永続化・retain・last-will 相当を自前で書くことになる。WebUI へのfan-outも不便。

### 覆す条件
- WAN越え必要 → MQTT (TLS+認証) に寄せる、またはWebRTC DataChannel
- マルチプロデューサで信頼配信が必要 → Kafka 検討
- 計測ノードが10台超 → LSL から外部のtime-syncサービスへ移行 (PTP)

---

## 2. PC 集約・3ノード分割: なぜ acquisition と decision を分けるか

### 候補
1. **Pi-A 一台に全部** (PiEEG + 解析 + Roomba制御)
2. **Pi-A: 取得+解析 / Pi-B: Roomba** (2ノード)
3. **Pi-A: 取得 / PC: 解析+DB+UI / Pi-B: Roomba** ← 採用

### なぜ採用案か
- **責務分離**: SPIリアルタイム読み出しは「落としたくない」軽量ループ。PSD 計算と DB 書き込みは CPU/IO 重く、ジッタを生む。**同居させると取得側のサンプル落ちが起きやすい**。
- PiEEG-Pi (Pi4想定) のCPUは scipy.welch + Postgres書き込み + UI を平行で回すには厳しい。
- PC 側で Docker Compose で全サービス起動できる方が **開発・再起動・ログ閲覧が圧倒的に楽**。
- ユーザの希望 (「DBや解析用のPC1つ」) と合致。

### 覆す条件
- フィールド計測 (PCを持ち出せない) → Pi-A 一台 + USB-SSD で自己完結
- 複数被験者を同時計測 → 集約PC (今の構成) のスケールアウトで対応

---

## 2.5 なぜ Pi-B と Roomba の間に Arduino を挟むか

### 要件

- Roomba の Open Interface シリアルは **5V TTL** (mini-DIN コネクタの Pin 3/4)
- Raspberry Pi の GPIO UART は **3.3V**
- 直結すると: ① Roomba TX (5V) → Pi RX (3.3V) で Pi 側破損リスク、② Pi TX (3.3V) → Roomba RX (5V) で High が閾値以下になりコマンドが通らない可能性
- 本プロジェクトは LAN PoC レベルで、はんだ作業や治具製作の時間は最小化したい

### 候補

1. **抵抗分圧 + 3.3V→5V トランジスタ昇圧** を自作
2. **専用レベルシフタ IC** (TXB0108 等) を 1 個実装
3. **市販の USB ↔ TTL シリアル変換ケーブル** (FTDI 5V 版) を直結
4. **Arduino を間に置き、Pi-B ↔ Arduino を USB シリアル (CDC)、Arduino ↔ Roomba を 5V TTL 直結** ← 採用

### なぜ採用案か

- **電圧レベル変換が Arduino のオンボード USB-UART チップで完結する**。Pi-B から見れば `/dev/ttyACM0` の普通の CDC シリアルデバイスであり、分圧抵抗・レベルシフタ IC・はんだ作業がいずれも不要。
- Arduino 上に **ROI コマンド送出の薄いファームウェア** を置けるので、Pi-B 側のソフトウェア (FastAPI) は「Arduino に1行コマンドを書く」だけで済む。タイミングクリティカルな ROI の初期化シーケンス (`Start` → `Safe`/`Full` → `Drive` …) や、応答パケットのバイト境界処理を Arduino 側に閉じ込められる。
- USB バス給電なので、Roomba バッテリーから Arduino を電源供給する追加配線が不要。
- **失敗時の安全側挙動**: Pi-B が落ちても Arduino が watchdog で「最後のコマンドから N 秒経過したら停止」できる (現状未実装。Phase2 候補)。
- Arduino は Roomba コミュニティで最も枯れた選択肢で、ROI 関連の参考実装が大量にある (移植コストが低い)。

### なぜ他を採らなかったか

- **抵抗分圧自作**: 安いが、Pi の入力インピーダンスや立ち上がり時間 (115200 bps 程度なら問題ないが) を毎回考えるのが面倒。配線間違いで Pi を1枚焼くリスク > Arduino 1個のコスト。
- **レベルシフタ IC 単体**: 部品としては正解だが、結局ブレッドボードか専用基板が必要で、ROI ファームウェアを置く場所もない。Arduino にすると IC + マイコンを1個で兼ねられる。
- **USB-TTL 直結 (FTDI 5V)**: 物理的には最短で動くが、ROI の初期化やフレーミングを **Pi-B の Python 側で全部やる** ことになり、Pi-B 側が GC で固まったときに Roomba が予期せぬ状態で取り残されやすい。責務を Arduino に逃がせない。

### 覆す条件

- Arduino が壊れた / 在庫がない → レベルシフタ IC + 自作基板
- リアルタイム性をさらに削りたい / 部品点数を最小化したい → USB-TTL 直結 + Python 側で ROI 全部実装
- Roomba が i7 系などネットワーク経由制御に置き換わった → そもそも有線シリアル不要、HTTP/MQTT で完結

---

## 3. TimescaleDB を採用した理由

### 候補
1. **Parquet/HDF5 ファイル** を時刻命名で書き貯め
2. **InfluxDB** (時系列専用)
3. **TimescaleDB** (Postgres 拡張) ← 採用
4. **ClickHouse** (列指向OLAP)

### なぜ採用案か
- **PostgreSQL の SQL がそのまま使える**こと。pandas / asyncpg / Grafana / DBeaver どれでも標準。研究データに対して任意のクエリを後で打ちやすい。
- **hypertable + 圧縮 + retention policy** が宣言的。`compress_segmentby='ch'` で 16ch 時系列の圧縮率が良い (実測 5–10x)。
- Welch 特徴量・events など**異種テーブルを一つの DB**にまとめられる (JOINで分析)。
- Influx は Flux/InfluxQL 学習コストとエコシステム断絶。ClickHouse は管理が重く本件規模ではoverkill。Parquet は良いが「クエリが書けない・retention 管理を自前」になる。

### 覆す条件
- 数日以上の連続記録で2.7GB/日が辛くなる → Parquet 二段保管 (raw=Parquet、features=TimescaleDB)
- 分析が単純な集計のみ → ClickHouse へ

---

## 4. なぜ adapter pattern (`EEGSource`) を入れたか

### 理由
- ユーザ要望: **「LSL vs MQTT vs ZeroMQ の比較実験もしたい」**
- adapter を介せば ingest 本体に手を入れず Source 差し替えで再計測できる。
- もう一つの実利: **ファイル再生で開発・CI が回せる** (PiEEG が手元になくても)。
- コストはほぼゼロ (抽象クラス + 3 実装のうち 1 つだけ書けば動く)。**YAGNIに反しない範囲の汎化**。

### 覆す条件
- 1年経って Source 差し替えが一度も発生していない → 削除して LSL ベタ書きに戻す

---

## 5. なぜ ヒステリシス + dwell の状態機械か

### 要件
- α power はノイズで揺れる → 単純しきい値だと**チャタリング**してロボットがガタつく/急に止まる
- 開眼/閉眼の遷移は秒オーダー → 数百 ms 程度の dwell は許容

### なぜ採用案か
- 教科書的な対策: enter/exit を分離 (シュミットトリガ) + dwell time。**実装は数十行**で済み、効果は大きい。
- 閾値は MQTT retain で動的に上書き → UI から即時調整、再起動後も保持。

### 覆す条件
- αだけでは判定精度不足と判明 → 軽い分類器 (LDA/CSP) や複数帯比 (α/β比) に拡張
- レスポンスが遅すぎる → dwell を 200ms に下げる + 別チャネルでpre-arm

---

## 6. なぜ React + Vite + uPlot か

### 要件
- 16ch 50Hz 描画 (ingest が downsample 済) を 10秒バッファで滑らかに
- 閾値スライダ・状態タグ・手動制御のシンプルなUI

### なぜ採用案か
- **uPlot** は Canvas ベースで**16系列 × 数千点でも軽量**。Recharts / Chart.js は SVG/重い。
- React は当たり前の選択 (情報量・型・エコシステム)。Vite で起動 < 1秒。
- 代替: **Grafana** はダッシュボードとしては優秀だが、**MQTT 制御ボタンを置きにくい**。研究/デモでは「波形+制御+設定」を1画面に集約したい。

### 覆す条件
- 運用ダッシュボードに専念 → Grafana + MQTT data source へ移行

---

## 7. なぜ Docker Compose / モノレポか

- 7コンポーネント (DB + broker + 4 svc + frontend) を**1コマンドで起動/停止/ログ閲覧**できる。
- ノードまたぎ (Pi-A/Pi-B) は systemd unit 同梱で同じリポジトリから配備。**真実の源を1箇所**に。
- k8s は 3ノード PoC には完全にoverkill。

### 覆す条件
- ノードが10台超になる、複数チームで運用する → k3s / Nomad

---

## 8. レイテンシと信頼性の設計予算 (検証で見るべき数字)

| 区間 | 目標 | 計測手段 |
|---|---|---|
| SPI読込→LSL出力 | < 5 ms | acquirer の `local_clock()` ログ |
| LSL→ingest受信 | < 20 ms | LSL `time_correction` |
| Welch計算 (1秒窓) | < 50 ms | feature_svc にtimer挿入 |
| MQTT publish→subscribe | < 20 ms (LAN) | mosquitto_sub の time差 |
| Roomba HTTP往復 | < 100 ms | decision_svc の httpx計測 |
| **E2E (SPI→Roomba ack)** | **中央値 < 500ms / p95 < 1s** | NTP同期下で結合計測 |

これを満たさない時はまずどこが効いているかを上の表で局在化する。

---

## 9. セキュリティ・認証の現状判断

- **LAN内・単一研究室**前提。MQTT は anonymous、TLSなし。
- これは**リスクを認識した上で意図的に省略**している (PoC効率優先)。
- **覆す条件**: 学外公開、個人EEGデータの保管が長期化、複数被験者の管理 → mosquitto に password_file + TLS、Postgres は SCRAM、API に OIDC/Auth0。

---

## 10. 将来の拡張余地 (聞かれたら答える)

- **クラウド延伸**: MQTT bridge を1本足すだけで AWS IoT Core / Azure IoT Hub に転送可能 (LSL は LAN 止まり)
- **オフライン解析**: TimescaleDB → Parquet エクスポート → MNE-Python
- **モデル化**: feature_svc の出力を学習データに、軽量分類器 (sklearn) を decision_svc に挿入
- **マルチ被験者**: LSL の `source_id` で区別、ingest を被験者ごとに hypertable パーティション

---

## まとめの一文 (エレベータピッチ)

> 250Hz×16ch という**小さなデータ量**に対し、**EEG業界標準のLSLで生波形を運び、IoT標準のMQTTで状態と制御を扱い、既存HTTPでRoombaを叩く**。解析は責務分離のためPCに集約し、TimescaleDBで生データ・特徴量・イベントを単一SQLから引けるようにした。各層は標準プロトコル/標準ツールで構成され、**スケール要件が変わったら局所的に置換できる**ように adapter pattern とコンテナ化で結合度を下げてある。

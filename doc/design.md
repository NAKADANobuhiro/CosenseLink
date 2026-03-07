# CosenseLink — 設計書

**バージョン:** 1.0
**作成日:** 2026-03-07

---

## 1. アーキテクチャ概要

CosenseLink は**フロントエンドのみで完結するシングルページアプリケーション（SPA）**である。バックエンドサーバーを持たず、静的ファイルとして配布される。

```
[ブラウザ]
  ├── HTML（CosenseLink-A6J.html）   レイアウト定義
  ├── データ（a6j.js）               window.COSENSE_DATA にデータを注入
  ├── コアエンジン（cosense-graph.js）グラフ構築・描画・インタラクション
  └── スタイル（cosense-graph.css）  ダークテーマ UI
```

外部依存は D3.js v7（CDN）のみ。D3 はフォースシミュレーションとズーム操作に利用し、描画自体は Canvas 2D API で行う（SVG は使用しない）。

---

## 2. モジュール設計

コアエンジン `cosense-graph.js` は単一ファイルに以下のモジュール相当のブロックを持つ。

| ブロック | 役割 |
|---|---|
| ERROR HANDLING | グローバルエラーキャッチ、オーバーレイ表示、ログバー |
| STATE | グラフデータ・シミュレーション状態のモジュールスコープ変数群 |
| SCREEN | ローディング画面 ↔ アプリ画面の切り替え |
| GRAPH BUILD | `buildGraph(json)` — JSONをノード・エッジのデータ構造に変換 |
| INIT GRAPH | `initGraph(json)` — D3シミュレーション起動・公開 API |
| CANVAS DRAW | `draw()` — Canvas 2D による毎フレーム描画 |
| POINTER EVENTS | `initPointerEvents()` — クリック/ドラッグ/ホバー判定 |
| SELECT / NAVIGATE | `selectNode()` / `navigateTo()` — ノード選択と遷移 |
| COSENSE MARKUP | `cosenseToHtml()` — マークアップのHTMLレンダリング |
| DOCUMENT PAGE | `buildCard()` — サイドパネルのDOM構築 |
| PANEL | `openCard()` / `closePanel()` — パネルの開閉制御 |
| HISTORY | `renderHistory()` — 閲覧履歴バーの更新 |
| SEARCH | インクリメンタルサーチUIのイベントハンドラ |
| AUTO START | `DOMContentLoaded` での自動初期化 |

---

## 3. データフロー

```
[a6j.js]
  └─ window.COSENSE_DATA（Cosense エクスポートJSON）
        │
        ▼
  buildGraph(json)
        │ ページ配列 → ノード配列
        │ linksLc を解決 → 有向エッジセット
        │ 双方向判定 → リンク配列（bidirectional フラグ）
        │ neighborMap / backlinkMap を構築
        ▼
  graphData オブジェクト
  ┌─────────────────────────────┐
  │ nodes[]      ページノード配列 │
  │ links[]      エッジ配列      │
  │ nodeById     Map<id, node>   │
  │ neighborMap  Map<id, Set<id>>│
  │ backlinkMap  Map<id, id[]>   │
  │ meta         プロジェクト情報 │
  └─────────────────────────────┘
        │
        ▼
  D3 ForceSimulation（simNodes / simLinks）
        │ tick イベント
        ▼
  draw() → Canvas 2D API → 画面表示
```

---

## 4. グラフ構築アルゴリズム（buildGraph）

### 4.1 ノード生成

各ページを 1 ノードとして生成する。ノードのプロパティは以下の通り。

```
id, title       : ページタイトル（一致がキーとなる）
lines           : 本文行配列
linksLc         : 出リンク（小文字）
views, updated  : メタ情報
degree          : リンク次数（エッジ構築後に加算）
category        : 'date' | 'movie' | 'person' | 'default'
```

### 4.2 エッジ生成（2パス方式）

**1st pass：** 全ノードの `linksLc` を走査し、実在するページへの有向エッジを `Set<"src\0tgt">` に収集する。大文字小文字の揺れは `titleByLower` マップで正規化する。

**2nd pass：** 有向エッジセットから無向ペアを導出する。同一ペア（ソートして比較）が双方向に存在する場合 `bidirectional: true`、片方のみの場合 `bidirectional: false` とする。

同一ペアの重複排除により、エッジ数は `O(ページ数)` 程度に収まる。

### 4.3 補助マップ

| マップ | キー | 値 | 用途 |
|---|---|---|---|
| `neighborMap` | ノード ID | `Set<ノードID>` | ハイライト時の隣接判定 |
| `backlinkMap` | ノード ID | `string[]` | サイドパネルのバックリンク表示 |

---

## 5. 描画設計（Canvas 2D）

### 5.1 描画レイヤー順序

毎フレーム（D3 tick または操作時）以下の順で描画する（画家のアルゴリズム）。

1. 背景クリア（`#0d1117`）
2. 非ハイライト・相互参照エッジ（実線、低透明度）
3. 非ハイライト・片方向エッジ（破線、低透明度）
4. 非ハイライト・片方向矢印（ズーム 0.3 以上）
5. ハイライト・相互参照エッジ（青実線）
6. ハイライト・片方向エッジ（青破線）
7. ハイライト・片方向矢印（青）
8. 全ノード（カテゴリ色、選択時は赤、非関連は暗転）
9. ラベル（条件に応じて表示）

### 5.2 ノード半径

```js
rScale(degree) = 3.5 + (degree / maxDegree) * 14
// 最小: 3.5px（次数0）、最大: 17.5px（最高次数）
```

### 5.3 矢印描画

片方向エッジの矢印はターゲットノードの円周上（半径 + 1px）に先端が来るように計算される。矢羽根の角度は 30°、長さはズーム倍率に反比例（`8 / k`）して常に一定サイズに見える。

### 5.4 ラベル表示条件

```
ズーム k >= 0.5  かつ  (選択中 OR 隣接 OR 次数 >= 8 OR k >= 1.5)
```

ラベルは最大24文字で切り捨て（`…` 付き）。フォントサイズも `k` に反比例して補正する。

### 5.5 D3 フォースシミュレーション設定

| フォース | パラメータ |
|---|---|
| forceLink | distance: 70, strength: 0.4 |
| forceManyBody | strength: -120, distanceMax: 260 |
| forceCenter | キャンバス中心 |
| forceCollide | radius: `4 + degree / 2` |
| alphaDecay | 0.025 |

---

## 6. ポインターイベント設計

### 6.1 ヒットテスト

```js
hitNode(cx, cy):
  ワールド座標 = (クライアント座標 - transform.x, .y) / transform.k
  ノードを逆順（前面優先）にループし:
    距離 ≤ rScale(degree) + 5 なら そのノードを返す
```

### 6.2 クリック vs ドラッグの区別

`pointerdown` 〜 `pointerup` の間に `pointermove`（`buttons > 0`）が発生した場合 `moved = true` とし、`pointerup` 時に `moved` なら選択処理をスキップする。これにより、パン操作がノード選択と競合しない。

### 6.3 AbortController によるイベントクリーンアップ

`initPointerEvents()` は呼び出すたびに前回の `AbortController` を `abort()` し、古いイベントリスナーをまとめて削除する。これにより `initGraph()` が複数回呼ばれた場合のイベント多重登録を防ぐ。

---

## 7. パネルとナビゲーション

### 7.1 ナビゲーションスタック

`navStack`（現セッションの戻りスタック）と `navHist`（閲覧履歴、最大20件）の2つの配列を持つ。

- `selectNode()` 時に両方に追加する。
- 「戻る」ボタンは `navStack` から末尾2件をポップして1つ前のページへ移動する。
- パネルを閉じると `navStack` はリセットされる（`navHist` は保持）。

### 7.2 flyTo アニメーション

選択されたノードへのズームアニメーションは D3 の `transition().duration(600)` + `zoomBeh.transform` で実装する。現在のズーム倍率が 1.2 未満の場合は 1.2 倍に拡大する。

---

## 8. マークアップレンダリング（cosenseToHtml）

処理は以下の順序で正規表現による文字列置換を行う。

1. HTMLエスケープ（`escHtml`）
2. 太字・大見出し・取り消し線等の記法
3. 画像 URL
4. 動画 URL（YouTube / Vimeo）
5. ラベル付きリンク
6. 裸の URL リンク
7. 内部リンク `[ページ名]` → `<span class="ilink" data-link="...">`
8. ハッシュタグ `#tag`（HTMLタグ内部は除外）
9. インラインコード

本文行の処理は `buildCard()` 内でインデントレベルを解析し、コードブロック・引用・通常行を判別してDOMを直接構築する（正規表現だけでなく DOM API を活用）。

---

## 9. 状態管理

グローバル状態はモジュールスコープ変数（`let`）で管理する。

| 変数 | 型 | 内容 |
|---|---|---|
| `graphData` | object \| null | `buildGraph()` が返すグラフ全体 |
| `simNodes` | array | D3シミュレーションに渡すノードコピー |
| `simLinks` | array | D3シミュレーションに渡すリンクコピー |
| `simulation` | D3Simulation \| null | 現在のシミュレーションインスタンス |
| `zoomBeh` | D3Zoom \| null | ズーム動作インスタンス |
| `transform` | D3ZoomTransform | 現在のズーム状態（x, y, k） |
| `highlight` | `{ sel, nbrs }` | 選択ノードIDと隣接ノードSet |
| `maxDegree` | number | ノード半径計算用の最大次数 |
| `navStack` | array | パネル内の戻りスタック |
| `navHist` | array | 閲覧履歴（最大20件） |
| `eventCtrl` | AbortController | ポインターイベントのクリーンアップ用 |

---

## 10. スタイリング設計

ダークテーマを CSS カスタムプロパティ（`:root` 変数）で一元管理する。

```css
--bg: #0d1117        /* 背景 */
--panel: #161b22     /* ヘッダー・サイドパネル背景 */
--card: #1c2128      /* カード背景 */
--border: #30363d    /* 境界線 */
--text: #e6edf3      /* 本文テキスト */
--muted: #8b949e     /* 補助テキスト */
--blue: #58a6ff      /* リンク・選択色 */
--green: #3fb950     /* バックリンク・隣接色 */
--red: #f78166       /* 選択ノード色 */
--yellow: #e3b341    /* 日付ノード・イタリック色 */
```

GitHub ダークテーマ（Primer）の配色に準拠している。

---

## 11. 拡張・カスタマイズポイント

| 項目 | 方法 |
|---|---|
| 別プロジェクトのデータを表示 | 方式 A: `window.COSENSE_DATA = {...}` を設定した JS ファイルを用意する |
| 非同期データ取得 | 方式 B: `fetch(url).then(r => r.json()).then(initGraph)` |
| カテゴリ追加 | `buildGraph()` 内のカテゴリ判定条件と `NODE_COLORS` を拡張する |
| フォースパラメータ調整 | `initGraph()` 内の `d3.forceSimulation` の各設定値を変更する |
| UI 配色変更 | `cosense-graph.css` の `:root` 変数を上書きする |

---

## 12. 既知の設計上のトレードオフ

| トレードオフ | 採用した選択 | 理由 |
|---|---|---|
| Canvas vs SVG | Canvas | ノード数が多い場合のレンダリングパフォーマンスを優先 |
| 全データ同梱 vs 動的フェッチ | 全データ同梱（`a6j.js`） | サーバー不要で配布できる利便性を優先 |
| 状態管理ライブラリ | なし（モジュールスコープ変数） | 依存を最小化し、ファイル単体での動作を維持 |
| ビルドツール | なし（生JS） | 静的ファイルとしての手軽さと可搬性を優先 |

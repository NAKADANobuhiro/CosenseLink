# 🕸️ CosenseLink

**Cosense（旧 Scrapbox）のページ間リンクをインタラクティブなネットワークグラフで可視化するブラウザアプリ**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Static](https://img.shields.io/badge/hosting-static%20files-blue)
![D3.js](https://img.shields.io/badge/D3.js-v7-orange)

---

## 特徴

- **フォース有向グラフ** — D3.js のフォースシミュレーションでページ間のリンク関係を自動レイアウト
- **双方向 / 片方向リンクの可視化** — 相互参照は実線、片側参照は破線＋矢印で区別
- **ノードカテゴリ色分け** — 日付・映画・人物・その他を色で識別
- **サイドパネル** — クリックでページ本文・出リンク・バックリンクをその場で確認
- **Cosense マークアップ対応** — 太字・見出し・コードブロック・画像・内部リンクなどをレンダリング
- **インクリメンタルサーチ** — ページ名をリアルタイム絞り込み
- **閲覧履歴** — 直近 20 件をワンクリックで再訪
- **サーバー不要** — 静的ファイルのみ。ダブルクリックで開くか任意の HTTP サーバーで動作

---

## クイックスタート

### アトロク2ファンサイト版を見る

[アトロク2 CosensLink](https://link.ironsite.net/CosenseLink-A6J.html)にアクセスしてください。


### アトロク2ファンサイト版をローカル環境で動かす

リポジトリをクローンして `CosenseLink-A6J.html` をブラウザで開くだけです。

```bash
git clone https://github.com/NAKADANobuhiro/CosenseLink.git
# CosenseLink-A6J.html をブラウザで開く
```

> **Note:** D3.js を CDN から読み込むため、初回はインターネット接続が必要です。

---

## ファイル構成

```
CosenseLink/
├── CosenseLink-A6J.html   # アトロク2ファンサイト向けエントリーポイント
├── a6j.js                 # データファイル（window.COSENSE_DATA）
├── js/
│   └── cosense-graph.js   # コアグラフエンジン（汎用・再利用可）
├── css/
│   └── cosense-graph.css  # スタイルシート（ダークテーマ）
├── spec.md                # 仕様書
└── design.md              # 設計書
```

---

## 自分のプロジェクトで使う

コアエンジン `cosense-graph.js` は **任意の Cosense プロジェクトで再利用できます**。

### 方式 A — データファイルを同梱する（サーバー不要）

Cosense の JSON エクスポートを変数に代入した `.js` ファイルを用意し、`cosense-graph.js` より前に読み込みます。

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>My Project</title>
  <link rel="stylesheet" href="css/cosense-graph.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
  <script src="my-data.js"></script><!-- window.COSENSE_DATA = { ... } -->
</head>
<body>
  <!-- CosenseLink-A6J.html と同じ HTML 構造を記述 -->
  <script src="js/cosense-graph.js"></script>
</body>
</html>
```

`my-data.js` の中身:

```js
window.COSENSE_DATA = { /* Cosense エクスポートJSON */ };
```

### 方式 B — 非同期フェッチ（HTTP サーバー必須）

```html
<script src="js/cosense-graph.js"></script>
<script>
  fetch('data.json')
    .then(r => r.json())
    .then(initGraph);
</script>
```

---

## 操作方法

| 操作 | 動作 |
|---|---|
| ノードをクリック | そのページを選択・サイドパネルを開く |
| 空白をクリック | 選択解除 |
| ドラッグ | グラフをパン（移動） |
| スクロール / ピンチ | ズームイン・アウト |
| サイドパネル内のリンク | 該当ノードへ移動 |
| ← ボタン | 直前のページへ戻る |
| 検索ボックス | ページ名をインクリメンタルサーチ |
| 履歴タグ | 過去に閲覧したページへジャンプ |

---

## ノードカテゴリ

| 色 | カテゴリ | 判定条件 |
|---|---|---|
| 🟡 黄 | 日付 | タイトルが `YYYY-MM-DD` 形式 |
| 🟣 紫 | 映画 | 本文に `[映画]` タグを含む |
| ⚪ 白 | 人物 | 本文に `[人物]` タグを含む |
| 🔵 青 | その他 | 上記以外 |

---

## 技術スタック

| 技術 | 用途 |
|---|---|
| [D3.js v7](https://d3js.org/) | フォースシミュレーション・ズーム操作 |
| HTML5 Canvas 2D | グラフ描画 |
| Vanilla JavaScript (ES2020+) | アプリロジック全般 |
| CSS カスタムプロパティ | ダークテーマ（GitHub Primer 配色） |

外部依存は D3.js のみ。ビルドツール・フレームワーク不使用。

---

## データ形式

Cosense の標準エクスポート JSON をそのまま利用できます。

```json
{
  "name": "project-id",
  "displayName": "プロジェクト名",
  "pages": [
    {
      "title": "ページタイトル",
      "lines": [{ "text": "..." }],
      "linksLc": ["リンク先（小文字）"],
      "views": 100,
      "updated": 1700000000
    }
  ]
}
```

---

## ドキュメント

- [仕様書 (spec.md)](./doc/spec.md) — 機能要件・操作仕様・データ形式の詳細
- [設計書 (design.md)](./doc/design.md) — アーキテクチャ・アルゴリズム・内部設計の詳細

---

## 作者

**中田亙洋 (NAKADANobuhiro)**

- X: [@nakadanobuhiro](https://x.com/nakadanobuhiro)
- GitHub: [@NAKADANobuhiro](https://github.com/NAKADANobuhiro)

---

## ライセンス

[MIT License](LICENSE)

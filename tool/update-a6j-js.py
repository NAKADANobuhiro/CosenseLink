#!/usr/bin/env python3
"""
<input>.json → a6j.js 変換スクリプト

Cosense のエクスポート JSON から不要フィールドを除去し、
cosense-graph.js が必要とするフィールドだけを残して a6j.js を生成する。

【常に除去するフィールド】
  lines[].created / updated / userId  — 行メタ情報
  pages[].id / created / updated / views  — ページメタ情報
  トップレベルの exported / users

【オプション】
  -f / --filter-dead-links
      存在しないページへの linksLc エントリを除去する。
      グラフエッジは変わらないが、サイドパネルの「灰色チップ」が消える。

  -e / --strip-empty-lines
      本文の空行をすべて除去する。
      サイドパネルの段落間スペースがなくなる代わりにサイズを削減できる。

  -n / --no-body
      本文をほぼ除去しグラフ専用データにする（約 97% 削減）。
      カテゴリ判定（映画・人物）に必要な行だけ保持するため、
      ノードの色分けはそのまま機能する。
      サイドパネルには本文が表示されなくなる。

使い方:
  python update-a6j-js.py <input.json> [output.js] [-f] [-e] [-n]
"""
import argparse
import json
import pathlib
import re
import sys


# ── 引数 ──────────────────────────────────────────────────────
parser = argparse.ArgumentParser(
    description="Cosense エクスポート JSON → a6j.js 変換（フィールド削減付き）"
)
parser.add_argument("input",  help="入力 JSON ファイル")
parser.add_argument("output", nargs="?", help="出力 JS ファイル（省略時: 入力と同ディレクトリの a6j.js）")
parser.add_argument("-f", "--filter-dead-links", action="store_true",
                    help="存在しないページへの linksLc エントリを除去する")
parser.add_argument("-e", "--strip-empty-lines", action="store_true",
                    help="本文の空行をすべて除去する")
parser.add_argument("-n", "--no-body", action="store_true",
                    help="本文をほぼ除去しグラフ専用データにする（カテゴリ判定行のみ保持）")
args = parser.parse_args()

src = pathlib.Path(args.input)
dst = pathlib.Path(args.output) if args.output else src.parent / "a6j.js"

if not src.exists():
    print(f"エラー: {src} が見つかりません。", file=sys.stderr)
    sys.exit(1)


# ── 読み込み ──────────────────────────────────────────────────
raw       = json.loads(src.read_text(encoding="utf-8"))
pages_raw = raw if isinstance(raw, list) else raw.get("pages", [])

# デッドリンクフィルタ用: 全タイトルの小文字セット
all_titles_lc = {p["title"].lower() for p in pages_raw if "title" in p}


# ── lines から内部リンクを抽出（新エクスポート形式対応） ──────────
_BRACKET_RE = re.compile(r'\[([^\[\]\n]+?)\]')

def _extract_links_lc(lines: list) -> list:
    """lines テキストから Cosense 内部リンクを抽出して小文字リストで返す。"""
    seen: set = set()
    links: list = []
    for line in lines:
        text = line if isinstance(line, str) else line.get("text", "")
        for m in _BRACKET_RE.finditer(text):
            inner = m.group(1).strip()
            # 外部リンク・アイコン・画像・数式・クロスプロジェクトを除外
            if re.match(r'https?://', inner):           continue
            if re.search(r'\s+https?://', inner):       continue
            if inner.endswith('.icon'):                 continue
            if re.search(r'\.(jpe?g|png|gif|svg|webp|bmp)$', inner, re.I): continue
            if inner.startswith('$'):                   continue
            if inner.startswith('/'):                   continue
            if inner.startswith('@'):                   continue
            lc = inner.lower()
            if lc in seen:
                continue
            seen.add(lc)
            if args.filter_dead_links and lc not in all_titles_lc:
                continue
            links.append(lc)
    return links


# ── フィールド削減 ────────────────────────────────────────────
def slim_page(p: dict) -> dict:
    """ページオブジェクトから必要なフィールドだけを抽出する。"""
    slimmed: dict = {"title": p["title"]}

    # lines: text 文字列だけ残す（行メタ情報をすべて除去）
    if "lines" in p:
        lines = [
            (l if isinstance(l, str) else l.get("text", ""))
            for l in p["lines"]
        ]
        if args.no_body:
            # グラフ専用モード: カテゴリ判定（映画・人物）に必要な行だけ保持
            # lines[0] はタイトル行（カテゴリ判定はスキップ）
            # 先頭の [映画] / [人物] タグ行だけ残す
            cat_line = next(
                (l for l in lines[1:] if l.startswith("[映画]") or l.startswith("[人物]")),
                None,
            )
            lines = [cat_line] if cat_line else []
        elif args.strip_empty_lines:
            lines = [l for l in lines if l.strip()]
        if lines:
            slimmed["lines"] = lines

    # linksLc: 旧形式はフィールドから、新形式は lines から抽出
    if "linksLc" in p:
        # 旧形式: linksLc フィールドが存在する場合
        seen: set = set()
        links: list = []
        for lc in p["linksLc"]:
            if lc in seen:
                continue
            seen.add(lc)
            if args.filter_dead_links and lc.lower() not in all_titles_lc:
                continue
            links.append(lc)
        if links:
            slimmed["linksLc"] = links
    elif "lines" in p:
        # 新形式: lines テキストから [リンク名] を解析して抽出
        links = _extract_links_lc(p["lines"])
        if links:
            slimmed["linksLc"] = links

    return slimmed


slim_pages = [slim_page(p) for p in pages_raw]

# トップレベルは name / displayName / exported のみ保持
slim_data: dict = {}
if isinstance(raw, dict):
    if "name"        in raw: slim_data["name"]        = raw["name"]
    if "displayName" in raw: slim_data["displayName"] = raw["displayName"]
    if "exported"    in raw: slim_data["exported"]    = raw["exported"]
slim_data["pages"] = slim_pages


# ── 書き出し ──────────────────────────────────────────────────
json_text = json.dumps(slim_data, ensure_ascii=False, separators=(",", ":"))
dst.write_text(f"window.COSENSE_DATA={json_text};", encoding="utf-8")

src_kb = src.stat().st_size / 1024
dst_kb = dst.stat().st_size / 1024
ratio  = (1 - dst_kb / src_kb) * 100 if src_kb else 0
print(f"入力  : {src.name} ({src_kb:,.0f} KB)")
print(f"出力  : {dst.name} ({dst_kb:,.0f} KB)")
print(f"削減率: {ratio:.1f}%")
if args.filter_dead_links:
    print("  ✓ デッドリンク除去 ON")
if args.strip_empty_lines:
    print("  ✓ 空行除去 ON")
if args.no_body:
    print("  ✓ 本文なし（グラフ専用）ON")
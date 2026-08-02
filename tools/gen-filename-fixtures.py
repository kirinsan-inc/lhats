#!/usr/bin/env python3
"""
ファイル名まわりのフィクスチャ生成器。

対象は 2 つある。

1. **文字コード (CP932)**
   LZH のヘッダーはファイル名を「バイト列」で持つだけで、文字コードの
   指定は無い。日本語圏で作られた書庫はほぼ CP932 である。

2. **長いファイル名 (LFN)**
   MS-DOS 期の実装は 8.3 名しか扱えず `PROGRA~1` のような名前になるが、
   これは当時の仕様どおりで追随する必要はない。一方 Windows 95 以降の
   実装 (UNLHA32.DLL / LHA32 / LHMelt など) と LHa for UNIX は、
   ヘッダーレベル 1/2 の **拡張ヘッダー 0x01 (ファイル名)** に長い名前を
   格納する。ディレクトリは **0x02** に 0xFF 区切りで入る。
   こちらは読めなければならない。

期待値の作り方:
   書庫の中に実際に入っているファイル名の**バイト列**を、生成後に自前で
   ヘッダーから読み出して CP932 でデコードしたものを正とする。
   「こういう名前で作ったはず」という思い込みを期待値にしない
   (macOS のファイル名正規化などで実際の格納内容はずれうるため)。
   内容の sha256 は入力ファイルそのものから取る。

前提:
   ./tools/build-lha-unix.sh
   python3 tools/gen-filename-fixtures.py --out test/fixtures/filenames
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

# ── 生成する名前の組 ──────────────────────────────────
# 濁点・半濁点は macOS のファイル名正規化 (NFD) で分解されうるので、
# 生成側では避ける。格納後のバイト列を正とする方針なので致命傷ではないが、
# 期待値が読みにくくなるのを防ぐ。

CASES: dict[str, dict[str, str]] = {
    # CP932 の日本語ファイル名。ひらがな・カタカナ・漢字・全角英数
    "sjis": {
        "ねこ.txt": "ひらがな",
        "ローフ.txt": "カタカナ",
        "書庫圧縮.txt": "漢字",
        "ＮｅｋｏＬｏａｆ.txt": "全角英数",
    },
    # Windows 95 以降の実装が 0x01 拡張ヘッダーに入れる長いファイル名
    "lfn": {
        "this-is-a-fairly-long-file-name-that-cannot-fit-in-8dot3.txt": "英数 60 文字級",
        ("x" * 200) + ".txt": "200 文字",
        "名前が長い日本語のファイル名で八点三形式には到底収まらないもの.txt": "日本語の長い名前",
    },
    # ディレクトリ + 日本語。0x02 拡張ヘッダーの 0xFF 区切りと
    # 文字コード変換が同時にかかる、いちばん壊れやすい組み合わせ
    "dirs": {
        "画像/第一章/表紙.txt": "日本語ディレクトリ",
        "画像/第一章/本文/ページ.txt": "深いネスト",
        "docs/日本語ファイル.txt": "英字ディレクトリ + 日本語名",
    },
}

HEADER_LEVELS = [1, 2]


def find_lha() -> str:
    """LHa for UNIX を探す。lhasa は展開専用なので弾く。"""
    for c in (
        os.environ.get("LHA_BIN"),
        os.path.expanduser("~/.cache/nekoloaf/lha-unix/prefix/bin/lha"),
        shutil.which("lha"),
    ):
        if c and os.path.isfile(c):
            probe = subprocess.run([c, "--version"], capture_output=True, text=True)
            if "LHa for UNIX" in (probe.stdout + probe.stderr):
                return c
    sys.exit(
        "LHa for UNIX が見つかりません。先に ./tools/build-lha-unix.sh を実行してください。"
    )


def stored_names(path: str) -> list[tuple[str, int]]:
    """
    書庫を自前で解析し、格納されているファイル名を (CP932 デコード結果, レベル)
    で返す。

    拡張ヘッダー 0x01 があればそれを、無ければ基本ヘッダーのファイル名欄を使う。
    0x02 (ディレクトリ名) があれば 0xFF 区切りで分割して前置する。
    """
    d = open(path, "rb").read()
    out: list[tuple[str, int]] = []
    pos = 0

    def dec(b: bytes) -> str:
        return b.decode("cp932", errors="replace")

    def dec_dir(b: bytes) -> str:
        # 0xFF はバイト列のまま分割する。デコードしてから置換すると
        # CP932 に 0xFF が無いため区切りが失われる。
        return "/".join(dec(part) for part in b.split(b"\xff"))

    while pos + 21 < len(d):
        if d[pos] == 0:
            break
        level = d[pos + 20]
        size = int.from_bytes(d[pos + 7 : pos + 11], "little")

        name = ""
        directory = ""

        if level == 2:
            total = int.from_bytes(d[pos : pos + 2], "little")
            ext, end = pos + 24, pos + total
            nxt = pos + total + size
        elif level == 1:
            base = d[pos]
            fn_len = d[pos + 21]
            name = dec(d[pos + 22 : pos + 22 + fn_len])
            ext, end = pos + base, len(d)
            nxt = None  # 拡張ヘッダーを歩いた後に確定する
        else:  # level 0 は拡張ヘッダーを持たない
            fn_len = d[pos + 21]
            out.append((dec(d[pos + 22 : pos + 22 + fn_len]), 0))
            pos += 2 + d[pos] + size
            continue

        ext_sum = 0
        while ext + 2 <= end:
            esz = int.from_bytes(d[ext : ext + 2], "little")
            if esz == 0:
                ext += 2
                break
            etype = d[ext + 2]
            if etype == 0x01:
                name = dec(d[ext + 3 : ext + esz])
            elif etype == 0x02:
                directory = dec_dir(d[ext + 3 : ext + esz])
            ext += esz
            ext_sum += esz

        if level == 1:
            # skip size は「実データ + 非ゼロ拡張ヘッダー size 合計」。
            # 終端 0x0000 の 2 バイトは含まれないので別途足す。
            nxt = pos + d[pos] + 2 + size

        out.append((directory + name, level))
        pos = nxt  # type: ignore[assignment]

    return out


def build(lha: str, out_path: str, level: int, workdir: str, names: list[str]) -> bool:
    if os.path.exists(out_path):
        os.remove(out_path)
    argv = [
        lha, "a", "-o5", f"-{level}", "-q",
        "--system-kanji-code=utf8", "--archive-kanji-code=sjis",
        out_path, *sorted(names),
    ]
    p = subprocess.run(argv, cwd=workdir, capture_output=True, text=True)
    return p.returncode == 0 and os.path.exists(out_path)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="test/fixtures/filenames")
    args = ap.parse_args()

    lha = find_lha()
    ver = subprocess.run([lha, "--version"], capture_output=True, text=True)
    version = (ver.stdout + ver.stderr).splitlines()[0].strip()
    print(f"圧縮器: {version}\n")

    os.makedirs(args.out, exist_ok=True)
    out_abs = os.path.abspath(args.out)
    manifest: dict[str, dict] = {}
    failed = 0

    for tag, names in CASES.items():
        for level in HEADER_LEVELS:
            archive = f"{tag}_h{level}.lzh"
            path = os.path.join(out_abs, archive)

            with tempfile.TemporaryDirectory() as tmp:
                # 圧縮が効くだけの内容を入れる。名前が主眼だが、
                # 名前だけ合っていて中身が壊れていては意味がない。
                bodies: dict[str, bytes] = {}
                for i, name in enumerate(names):
                    full = os.path.join(tmp, name)
                    os.makedirs(os.path.dirname(full), exist_ok=True)
                    body = (f"lhats filename fixture #{i}: {names[name]}\n"
                            .encode() * 400)
                    with open(full, "wb") as f:
                        f.write(body)
                    bodies[name] = body

                if not build(lha, path, level, tmp, list(names)):
                    print(f"  NG   {archive} (生成失敗)")
                    failed += 1
                    continue

            # lhasa に受理されることを確認する
            if shutil.which("lha"):
                t = subprocess.run(["lha", "t", path], capture_output=True, text=True)
                if t.returncode != 0 or "error" in (t.stdout + t.stderr).lower():
                    print(f"  NG   {archive} (lhasa が拒否)")
                    os.remove(path)
                    failed += 1
                    continue

            stored = stored_names(path)
            entries = {}
            for stored_name, lvl in stored:
                # 入力名とバイト列一致で対応づける。CP932 往復で表現できない
                # 名前があれば、その時点でここが一致しなくなるので気づける。
                match = next((n for n in bodies if n == stored_name), None)
                entries[stored_name] = {
                    "size": len(bodies[match]) if match else None,
                    "sha256": hashlib.sha256(bodies[match]).hexdigest() if match else None,
                    "matchedInput": match is not None,
                    "headerLevel": lvl,
                }

            manifest[archive] = {
                "headerLevel": level,
                "case": tag,
                "producer": version,
                "encoding": "cp932",
                "entries": entries,
            }
            unmatched = [n for n, e in entries.items() if not e["matchedInput"]]
            mark = "ok  " if not unmatched else "警告"
            print(f"  {mark} {archive:<16} {len(entries)} エントリ"
                  + (f"  ※入力と対応しない名前: {unmatched}" if unmatched else ""))

    with open(os.path.join(out_abs, "expected.json"), "w") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False, sort_keys=True)

    print(f"\nmanifest: {os.path.join(out_abs, 'expected.json')}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

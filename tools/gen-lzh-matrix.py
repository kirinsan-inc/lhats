#!/usr/bin/env python3
"""
LZH フィクスチャ網羅生成器

「圧縮方式 × ヘッダーレベル × ペイロード形状」を総当たりして、
本物の LHa for UNIX に圧縮させたアーカイブ群を機械的に生成する。

前提:
  ./tools/build-lha-unix.sh
  python3 scripts/gen-lzh-matrix.py --out <dir>

LHa for UNIX が書ける方式（実測で確認済み）:
  -lh0- (-z)   -lh1- (-o)   -lh5- (-o5)   -lh6- (-o6)   -lh7- (-o7)
  それぞれヘッダーレベル 0 / 1 / 2 と自由に組み合わせられる。
  -lh4- は書けない（-o4 は invalid。LHa for UNIX にエンコーダーが無い）。

生成物は必ず lhasa と libarchive の 2 つの独立したリーダーに受理させてから
採用する。あわせて manifest.json に「外部リーダーが展開した内容の sha256」を
記録する。自前の実装で自前の出力を検証しないための仕組み。
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

# ── 決定的乱数 ────────────────────────────────────────
# splitmix64。線形合同法は下位ビットの品質が悪く、出力幅も狭いため、
# `next() % total` が total より小さい範囲に貼り付く事故が起きる。


class Rng:
    MASK = (1 << 64) - 1

    def __init__(self, seed: int = 20260726) -> None:
        self.x = seed & self.MASK

    def next(self) -> int:
        self.x = (self.x + 0x9E3779B97F4A7C15) & self.MASK
        z = self.x
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & self.MASK
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & self.MASK
        return z ^ (z >> 31)

    def below(self, k: int) -> int:
        return self.next() % k


# ── ペイロード形状 ────────────────────────────────────
# デコーダーの別々の経路を踏ませることを意図して選んでいる。

def p_empty() -> bytes:
    """空ファイル。長さ 0 の境界。"""
    return b''


def p_single_byte() -> bytes:
    """1 バイト。単一シンボルのハフマン表を強制する。"""
    return b'A'


def p_runs(n: int = 300_000) -> bytes:
    """同一バイトの長大なラン。最長マッチと単一シンボル経路。"""
    return b'A' * n


def p_text(target: int = 200_000, seed: int = 20260726) -> bytes:
    """疑似テキスト。リテラルとマッチが混在し、ブロックごとに表が変わる。"""
    vocab = ('neko loaf lhats archive header decoder huffman lzss dictionary '
             'entry offset checksum extract compress fixture interop '
             'ネコ ローフ 書庫 展開 圧縮 辞書 符号 検証').split()
    rng = Rng(seed)
    out = bytearray()
    line = 0
    while len(out) < target:
        words = [vocab[rng.below(len(vocab))] for _ in range(rng.below(8) + 4)]
        out += f'{line:06d}: '.encode() + ' '.join(words).encode('utf-8') + b'\n'
        line += 1
    return bytes(out[:target])


def p_random(n: int = 131_072, seed: int = 4242) -> bytes:
    """一様乱数。非圧縮性でリテラル主体、ほぼ一様な符号長。"""
    rng = Rng(seed)
    return bytes(rng.below(256) for _ in range(n))


def p_mixed(n: int = 131_072, seed: int = 99991) -> bytes:
    """非圧縮性の塊と反復の塊が交互。ブロック境界での表の読み直しを突く。"""
    rng = Rng(seed)
    cumulative, acc = [], 0
    for i in range(256):
        acc += 1_000_000 // (i + 1)
        cumulative.append(acc)

    def draw() -> int:
        r = rng.below(acc)
        lo, hi = 0, 255
        while lo < hi:
            mid = (lo + hi) // 2
            if r < cumulative[mid]:
                hi = mid
            else:
                lo = mid + 1
        return lo

    out, chunk = bytearray(), 0
    while len(out) < n:
        if chunk % 2 == 0:
            out += bytes(draw() for _ in range(2048))
        else:
            motif = bytes(draw() for _ in range(rng.below(24) + 8))
            out += motif * (2048 // len(motif) + 1)
        chunk += 1
    return bytes(out[:n])


def p_periodic(period: int, n: int = 200_000, seed: int = 7) -> bytes:
    """指定周期の繰り返し。辞書サイズ境界でのマッチ探索を突く。"""
    rng = Rng(seed)
    motif = bytes(rng.below(256) for _ in range(period))
    return (motif * (n // period + 1))[:n]


# 辞書サイズ (lh5=8KB, lh6=32KB, lh7=64KB) の境界を跨ぐ長さ
BOUNDARY_SIZES = [0, 1, 2, 3, 4095, 4096, 4097, 8191, 8192, 8193,
                  32767, 32768, 32769, 65535, 65536, 65537]


def p_boundary(size: int, seed: int = 31337) -> bytes:
    rng = Rng(seed)
    return bytes(rng.below(256) for _ in range(size))


# ── LHa 呼び出し ──────────────────────────────────────

METHOD_FLAGS = {
    '-lh0-': '-z',
    '-lh1-': '-o',
    '-lh5-': '-o5',
    '-lh6-': '-o6',
    '-lh7-': '-o7',
}
HEADER_LEVELS = [0, 1, 2]


def find_lha() -> str:
    """LHa for UNIX の実体を探す。lhasa は展開専用なので明示的に弾く。"""
    candidates = [
        os.environ.get('LHA_BIN'),
        os.path.expanduser('~/.cache/nekoloaf/lha-unix/prefix/bin/lha'),
        shutil.which('lha'),
    ]
    for c in candidates:
        if not c or not os.path.isfile(c):
            continue
        probe = subprocess.run([c, '--version'], capture_output=True, text=True)
        if 'LHa for UNIX' in (probe.stdout + probe.stderr):
            return c
    sys.exit(
        'LHa for UNIX が見つかりません。先に ./tools/build-lha-unix.sh を実行してください。\n'
        '(brew の lha は lhasa で、展開専用なので圧縮には使えません)'
    )


# libarchive は -lh1- を展開できない ("Unsupported lzh compression method -lh1-")。
# lhasa は展開できる。したがって「両方に受理されること」を一律に要求すると
# -lh1- のフィクスチャが作れなくなる。方式ごとにどのリーダーが使えるかを持つ。
UNSUPPORTED_MARK = 'unsupported lzh compression method'


def verify(path: str) -> tuple[bool, str, list[str]]:
    """独立したリーダーに受理されるか確認する。

    Returns:
        (ok, 失敗理由, 受理したリーダー名の一覧)
    """
    accepted: list[str] = []
    for tool, argv in (('lhasa', ['lha', 't', path]),
                       ('libarchive', ['bsdtar', '-tf', path])):
        if not shutil.which(argv[0]):
            continue
        proc = subprocess.run(argv, capture_output=True, text=True)
        blob = (proc.stdout + proc.stderr).lower()
        if UNSUPPORTED_MARK in blob:
            continue  # そのリーダーが方式非対応なだけ。フィクスチャの欠陥ではない
        if proc.returncode != 0 or 'error' in blob:
            tail = (proc.stdout + proc.stderr).strip().splitlines()
            return False, f'{tool}: {tail[-1] if tail else "失敗"}', accepted
        accepted.append(tool)

    if not accepted:
        return False, '受理したリーダーが 1 つも無い', accepted
    return True, '', accepted


def entry_hashes(path: str) -> dict[str, dict]:
    """libarchive に展開させて、エントリごとの期待値を得る。

    エントリ名は入力ファイル名と一致するとは限らない（ディレクトリ区切りの
    正規化や漢字コード変換が入る）ので、必ずアーカイブ側の一覧から取る。
    """
    listing = subprocess.run(['bsdtar', '-tf', path],
                             capture_output=True, text=True)
    if listing.returncode != 0:
        return {}
    names = [n for n in listing.stdout.splitlines() if n and not n.endswith('/')]
    if not names:
        return {}

    result = {}
    for name in names:
        # libarchive を第一候補、lhasa を第二候補にする。
        # -lh1- は libarchive が非対応なので lhasa が唯一のオラクルになる。
        for oracle, argv in (('libarchive', ['bsdtar', '-xOf', path, name]),
                             ('lhasa', ['lha', 'pq', path, name])):
            if not shutil.which(argv[0]):
                continue
            proc = subprocess.run(argv, capture_output=True)
            # 空ファイルは正当に 0 バイトを返す。出力の有無で判定してはいけない。
            if proc.returncode != 0:
                continue
            result[name] = {
                'size': len(proc.stdout),
                'sha256': hashlib.sha256(proc.stdout).hexdigest(),
                'oracle': oracle,
            }
            break
        else:
            return {}  # どのリーダーでも展開できなかった
    return result


def build_archive(lha: str, out_path: str, method: str, level: int,
                  payloads: dict[str, bytes]) -> bool:
    """1 アーカイブを生成する。成功したら True。"""
    with tempfile.TemporaryDirectory() as tmp:
        for name, body in payloads.items():
            full = os.path.join(tmp, name)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, 'wb') as f:
                f.write(body)
        if os.path.exists(out_path):
            os.remove(out_path)
        # オプションの順序に注意: -o は header_level を 0 に落とすので、
        # レベル指定 (-0/-1/-2) は必ず方式フラグより後ろに置く。
        argv = [lha, 'a', METHOD_FLAGS[method], f'-{level}', '-q',
                '--system-kanji-code=utf8', '--archive-kanji-code=sjis',
                out_path] + sorted(payloads)
        proc = subprocess.run(argv, cwd=tmp, capture_output=True, text=True)
        return proc.returncode == 0 and os.path.exists(out_path)


def actual_methods(path: str) -> list[str]:
    """アーカイブを実際に読んで、各エントリの方式を返す。

    LHa は圧縮しても縮まない入力を -lh0- で格納する。指定した方式が
    本当に使われたかは、生成後にヘッダーを読んで確かめるしかない。
    """
    d = open(path, 'rb').read()
    out, pos = [], 0
    while pos + 21 < len(d):
        if d[pos] == 0:
            break  # アーカイブ終端
        lvl = d[pos + 20]
        method = d[pos + 2:pos + 7].decode('ascii', 'replace')
        if not (method.startswith('-l') or method.startswith('-p')):
            break  # 追従に失敗している。壊れた集計を出すより止める
        out.append(method)
        size = int.from_bytes(d[pos + 7:pos + 11], 'little')

        if lvl == 0:
            # header_size はオフセット 2 から数える
            pos += 2 + d[pos] + size
        elif lvl == 1:
            # header_size はオフセット 0 から数え、基本ヘッダー末尾まで。
            # そこから 2 バイトが「最初の拡張ヘッダーのサイズ欄」で、
            # size (skip size) は「非ゼロの拡張ヘッダー size 合計 + 実データ」。
            # 終端 0x0000 の 2 バイトは size に含まれないので別途足す。
            pos += d[pos] + 2 + size
        elif lvl == 2:
            # totalHeaderSize が拡張ヘッダーまで含めた全長
            pos += int.from_bytes(d[pos:pos + 2], 'little') + size
        else:
            break
    return out


# ── 生成対象の定義 ────────────────────────────────────

def payload_sets() -> dict[str, dict[str, bytes]]:
    """アーカイブ名の接尾辞 -> エントリ名:内容。"""
    sets: dict[str, dict[str, bytes]] = {
        'text': {'text.dat': p_text()},
        'random': {'random.dat': p_random()},
        'mixed': {'mixed.dat': p_mixed()},
        'runs': {'runs.dat': p_runs()},
        'tiny': {'empty.dat': p_empty(), 'one.dat': p_single_byte()},
        'periodic': {
            'p0003.dat': p_periodic(3),
            'p0256.dat': p_periodic(256),
            'p8192.dat': p_periodic(8192),
        },
        'boundary': {f'b{s:06d}.dat': p_boundary(s) for s in BOUNDARY_SIZES},
        'dirs': {
            'a/b/c/deep.dat': p_text(20_000),
            'a/b/sibling.dat': p_text(9_000),
            'a/top.dat': p_text(5_000),
        },
        'sjis': {
            'ネコローフ.dat': p_text(12_000),
            '書庫テスト.dat': p_text(9_000),
        },
        'longname': {('x' * 200) + '.dat': p_text(4_000)},
    }
    return sets


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--out', default='tests/fixtures/matrix',
                    help='出力ディレクトリ')
    ap.add_argument('--methods', nargs='*', default=list(METHOD_FLAGS),
                    help='生成する方式')
    ap.add_argument('--levels', nargs='*', type=int, default=HEADER_LEVELS)
    args = ap.parse_args()

    lha = find_lha()
    ver = subprocess.run([lha, '--version'], capture_output=True, text=True)
    version = (ver.stdout + ver.stderr).splitlines()[0].strip()
    print(f'圧縮器: {version}')
    print(f'        {lha}\n')

    os.makedirs(args.out, exist_ok=True)
    sets = payload_sets()
    manifest: dict[str, dict] = {}
    made = skipped = failed = 0

    for method in args.methods:
        for level in args.levels:
            for tag, payloads in sets.items():
                name = f'{method.strip("-")}_h{level}_{tag}.lzh'
                path = os.path.join(args.out, name)

                if not build_archive(lha, path, method, level, payloads):
                    print(f'  NG   {name}  (生成失敗)')
                    failed += 1
                    continue

                ok, why, readers = verify(path)
                if not ok:
                    print(f'  NG   {name}  {why}')
                    os.remove(path)
                    failed += 1
                    continue

                entries = entry_hashes(path)
                if not entries:
                    print(f'  NG   {name}  (期待値の取得に失敗)')
                    os.remove(path)
                    failed += 1
                    continue

                methods_used = actual_methods(path)
                manifest[name] = {
                    'requestedMethod': method,
                    'headerLevel': level,
                    'payloadSet': tag,
                    'producer': version,
                    'command': f'lha a {METHOD_FLAGS[method]} -{level} -q {name} <files>',
                    'archiveSha256': hashlib.sha256(open(path, 'rb').read()).hexdigest(),
                    'verifiedBy': readers,
                    'actualMethods': methods_used,
                    'entries': entries,
                }
                made += 1

    with open(os.path.join(args.out, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False, sort_keys=True)

    print(f'\n生成 {made} 件 / 失敗 {failed} 件 / スキップ {skipped} 件')
    print(f'manifest: {os.path.join(args.out, "manifest.json")}')

    # 指定した方式が実際に使われたかの集計
    from collections import Counter
    tally = Counter()
    for meta in manifest.values():
        for m in meta['actualMethods']:
            tally[(meta['requestedMethod'], m)] += 1
    print('\n指定方式 -> 実際に使われた方式（エントリ数）')
    for (req, act), c in sorted(tally.items()):
        mark = '' if req == act else '   ← 縮まないため無圧縮に退避'
        print(f'  {req} -> {act}  {c:4d}{mark}')

    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())

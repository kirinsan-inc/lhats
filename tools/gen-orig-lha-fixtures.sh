#!/usr/bin/env bash
#
# オリジナル LHA (MS-DOS, 吉崎栄泰, 1992) にフィクスチャを作らせる。
#
# なぜ必要か:
#   -lh1- は LHarc 1.x 世代の方式で、これを「本家が実際に吐いたバイト列」で
#   検証できるのはこの実装だけである。LHa for UNIX は後年の再実装であり、
#   本家との一致を証明する用途には使えない。
#
# 前提:
#   1. LHA.exe を取得しておく（実行は不要、lhasa で取り出せる）
#        curl -O https://ftp.vector.co.jp/00/24/521/lha255.exe
#        lha x lha255.exe            # -> LHA.exe
#      配布物の再配布条件によりバイナリはリポジトリにコミットしない。
#   2. brew install dosbox-x
#
# 使い方:
#   LHA_DOS_DIR=~/.cache/nekoloaf/lha-dos ./tools/gen-orig-lha-fixtures.sh <出力先>
#
# オプション構文は LHa for UNIX とは別物なので注意:
#   z = 無圧縮 (-lh0-)   o = LHarc 互換 (-lh1-)   既定 = -lh5-
#   -h0 / -h1 / -h2 = ヘッダーレベル
#   なお -o (LHarc 互換) はヘッダーレベルを 0 に固定する。

set -euo pipefail

OUT="${1:-test/fixtures/orig}"
LHA_DOS_DIR="${LHA_DOS_DIR:-$HOME/.cache/nekoloaf/lha-dos}"
LHA_EXE="$LHA_DOS_DIR/LHA.exe"

if [ ! -f "$LHA_EXE" ]; then
  echo "エラー: $LHA_EXE がありません。上のコメントの手順で取得してください。" >&2
  exit 1
fi
if ! command -v dosbox-x >/dev/null 2>&1; then
  echo "エラー: dosbox-x がありません。brew install dosbox-x" >&2
  exit 1
fi

OUT_ABS="$(mkdir -p "$OUT" && cd "$OUT" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp "$LHA_EXE" "$WORK/"

# DOS の 8.3 名に収まるペイロードを用意する
python3 - "$WORK" <<'PY'
import sys, pathlib
w = pathlib.Path(sys.argv[1])

class Rng:  # splitmix64
    M = (1 << 64) - 1
    def __init__(s, seed): s.x = seed & s.M
    def next(s):
        s.x = (s.x + 0x9E3779B97F4A7C15) & s.M
        z = s.x
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & s.M
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & s.M
        return z ^ (z >> 31)
    def below(s, k): return s.next() % k

vocab = ('neko loaf lhats archive header decoder huffman lzss dictionary entry '
         'offset checksum extract compress fixture interop').split()

def text(n, seed=20260726):
    r, out, line = Rng(seed), bytearray(), 0
    while len(out) < n:
        ws = [vocab[r.below(len(vocab))] for _ in range(r.below(8) + 4)]
        out += f'{line:06d}: '.encode() + ' '.join(ws).encode() + b'\n'
        line += 1
    return bytes(out[:n])

def mixed(n, seed=99991):
    r = Rng(seed)
    cum, acc = [], 0
    for i in range(256):
        acc += 1_000_000 // (i + 1); cum.append(acc)
    def draw():
        v = r.below(acc); lo, hi = 0, 255
        while lo < hi:
            mid = (lo + hi) // 2
            if v < cum[mid]: hi = mid
            else: lo = mid + 1
        return lo
    out, chunk = bytearray(), 0
    while len(out) < n:
        if chunk % 2 == 0:
            out += bytes(draw() for _ in range(2048))
        else:
            motif = bytes(draw() for _ in range(r.below(24) + 8))
            out += motif * (2048 // len(motif) + 1)
        chunk += 1
    return bytes(out[:n])

# -lh1- の辞書は 4KB・最長一致 60。境界を必ず跨ぐ大きさにする
(w / 'TEXT.DAT').write_bytes(text(60000))
(w / 'MIXED.DAT').write_bytes(mixed(40000))
(w / 'RUNS.DAT').write_bytes(b'A' * 30000)
(w / 'TINY.DAT').write_bytes(b'x')
PY

CONF="$WORK/gen.conf"
{
  echo "[autoexec]"
  echo "MOUNT C $WORK"
  echo "C:"
  for spec in "z -h0 Z_H0" "z -h1 Z_H1" "z -h2 Z_H2" \
              "o -h0 O_H0" \
              "  -h0 D_H0" "  -h1 D_H1" "  -h2 D_H2"; do
    set -- $spec
    if [ $# -eq 3 ]; then
      echo "LHA a -$1 $2 $3.LZH TEXT.DAT MIXED.DAT RUNS.DAT TINY.DAT > NUL"
    else
      echo "LHA a $1 $2.LZH TEXT.DAT MIXED.DAT RUNS.DAT TINY.DAT > NUL"
    fi
  done
} > "$CONF"

( cd "$WORK" && dosbox-x -silent -conf "$CONF" >/dev/null 2>&1 )

echo "生成結果:"
found=0
for f in "$WORK"/*.LZH; do
  [ -f "$f" ] || continue
  cp "$f" "$OUT_ABS/"
  n=$(basename "$f")
  m=$(python3 -c "
d=open('$f','rb').read(); lv=d[20]
print('%-8s level=%d' % (d[2:7].decode('ascii','replace'), lv))")
  printf "  %-10s %8d B  %s\n" "$n" "$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")" "$m"
  found=$((found + 1))
done
[ "$found" -gt 0 ] || { echo "エラー: 1 件も生成されませんでした" >&2; exit 1; }

# 原本の期待値を書き出す。lhats 自身ではなく入力そのものから取る。
python3 - "$WORK" "$OUT_ABS" <<'PY'
import sys, pathlib, hashlib, json
w, o = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
man = {p.name: {'size': p.stat().st_size,
                'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
       for p in sorted(w.glob('*.DAT'))}
(o / 'expected.json').write_text(json.dumps(man, indent=2) + '\n')
print(f"\n期待値: {o / 'expected.json'}")
PY

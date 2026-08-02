#!/usr/bin/env bash
#
# LHa for UNIX (jca02266/lha) をソースからビルドする。
#
# なぜ必要か:
#   LZH の「圧縮」ができる実装は事実上これしか残っていない。
#     - lhasa (brew install lhasa) は展開専用。usage は {lvtxep} で add が無い
#     - libarchive / bsdtar は LHA リーダーのみ。ライターは無い
#     - 7-Zip に LZH エンコーダーは歴史上一度も存在しない (-tlzh は展開専用)
#   したがってテストフィクスチャを「自前ではない実装」で作るには、
#   これをビルドするしかない。
#
# 使い方:
#   ./scripts/build-lha-unix.sh
#   LHA_BIN=$(./scripts/build-lha-unix.sh --print-path) python3 scripts/gen-lzh-fixtures.py
#
# 生成物はビルドディレクトリに置くだけで、リポジトリにはコミットしない。
# フィクスチャ生成時にのみ必要で、テスト実行には不要。

set -euo pipefail

# 既定の配置先。TMPDIR は OS に消されうるので、既定はリポジトリ外の安定した場所にする。
BUILD_ROOT="${LHA_BUILD_ROOT:-${HOME}/.cache/nekoloaf/lha-unix}"
PREFIX="${BUILD_ROOT}/prefix"
BIN="${PREFIX}/bin/lha"
REF="${LHA_UNIX_REF:-master}"

if [ "${1:-}" = "--print-path" ]; then
  echo "${BIN}"
  exit 0
fi

# すでにビルド済みなら何もしない
if [ -x "${BIN}" ] && "${BIN}" --version 2>&1 | grep -q 'LHa for UNIX'; then
  echo "既にビルド済み: ${BIN}"
  "${BIN}" --version 2>&1 | head -1
  exit 0
fi

for tool in git autoconf automake make cc; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "エラー: ${tool} が見つかりません。" >&2
    echo "  macOS: brew install autoconf automake" >&2
    echo "  Debian/Ubuntu: apt-get install -y build-essential autoconf automake" >&2
    exit 1
  fi
done

mkdir -p "${BUILD_ROOT}"
cd "${BUILD_ROOT}"

if [ ! -d src ]; then
  echo "==> clone jca02266/lha (${REF})"
  git clone --depth 1 --branch "${REF}" https://github.com/jca02266/lha.git tmp-clone
  mv tmp-clone/* tmp-clone/.git . 2>/dev/null || true
  rm -rf tmp-clone
fi

echo "==> autoreconf"
autoreconf -i >build.log 2>&1

echo "==> configure"
./configure --prefix="${PREFIX}" >>build.log 2>&1

echo "==> make"
make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" >>build.log 2>&1
make install >>build.log 2>&1

if [ ! -x "${BIN}" ]; then
  echo "エラー: ビルドに失敗しました。${BUILD_ROOT}/build.log を確認してください。" >&2
  exit 1
fi

echo "==> 完了: ${BIN}"
"${BIN}" --version 2>&1 | head -1

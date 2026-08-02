# テストフィクスチャの出所

**このディレクトリのアーカイブは lhats 自身では作っていない。**
すべて外部の LZH 実装に生成させ、さらに別の実装に検証させたものである。
自前の実装で自前の出力を検証しても、実装が間違っていれば期待値も一緒に
間違うだけで、何も保証できないため。

中身はすべて本プロジェクトで生成した合成データで、著作物は含まない。

---

## `orig/` — オリジナル LHA 2.55 (MS-DOS)

| | |
|---|---|
| 生成器 | **LHA version 2.55** (吉崎栄泰 氏, 1992-11-15) |
| 実行環境 | DOSBox-X |
| 生成スクリプト | [`tools/gen-orig-lha-fixtures.sh`](../../tools/gen-orig-lha-fixtures.sh) |
| 期待値 | `expected.json` — 書庫に入れた**原本そのもの**の sha256 |

`-lh1-` を本家の出力で検証できる唯一の手段である。LHa for UNIX は後年の
再実装であり、「本家と一致するか」の証明には使えない。

| ファイル | 方式 | ヘッダーレベル |
|---|---|---|
| `Z_H0.LZH` / `Z_H1.LZH` / `Z_H2.LZH` | `-lh0-` | 0 / 1 / 2 |
| `O_H0.LZH` | **`-lh1-`** | 0 |
| `D_H0.LZH` / `D_H1.LZH` / `D_H2.LZH` | `-lh5-` | 0 / 1 / 2 |

`-lh1-` はヘッダーレベル 0 のみ。LHA 2.55 の `-o` は LHarc 互換モードで、
レベルを 0 に固定するため。

内容は 4 種類:
`TEXT.DAT` (60KB 疑似テキスト) / `MIXED.DAT` (40KB 混在バイナリ) /
`RUNS.DAT` (30KB 同一バイト連続) / `TINY.DAT` (1 バイト)。
1 バイトの `TINY.DAT` は圧縮しても縮まないため LHA が `-lh0-` に退避する。
これも境界ケースとして意味がある。

### 再生成

`LHA.exe` は再配布条件の都合でリポジトリに含めていない。各自で取得する。

```sh
curl -O https://ftp.vector.co.jp/00/24/521/lha255.exe   # 50,357 bytes
lha x lha255.exe                                        # -> LHA.exe (36,796 bytes)
brew install dosbox-x
LHA_DOS_DIR=<LHA.exe のあるディレクトリ> ./tools/gen-orig-lha-fixtures.sh
```

`lha255.exe` は自己展開書庫だが lhasa がそのまま読めるので、
**取り出しに DOS の実行は不要**である。

`lha255b_.lzh` (2.55b) は差分パッチであり、適用には 1992 年に
NIFTY-Serve で配布された `bupdate` が必要で現在は入手困難。
2.55 → 2.55b の変更は残量チェックのバグ修正とコンパイラ差し替えのみで、
**圧縮フォーマットとアルゴリズムは変わっていない**ため 2.55 で足りる。

---

## `filenames/` — ファイル名の文字コードと長いファイル名

| | |
|---|---|
| 生成器 | **LHa for UNIX** (jca02266/lha) |
| オプション | `--system-kanji-code=utf8 --archive-kanji-code=sjis` |
| 生成スクリプト | [`tools/gen-filename-fixtures.py`](../../tools/gen-filename-fixtures.py) |
| 検証 | lhasa が受理すること |
| 期待値 | `expected.json` — 生成後の書庫ヘッダーから読み出した**実際の格納バイト列** |

期待値を「こういう名前で作ったはず」ではなく実際の格納内容から取っているのは、
macOS のファイル名正規化 (NFD) などで意図とずれうるためである。

| ファイル | 観点 |
|---|---|
| `sjis_h1.lzh` / `sjis_h2.lzh` | CP932 のひらがな・カタカナ・漢字・全角英数 |
| `lfn_h1.lzh` / `lfn_h2.lzh` | 長いファイル名 (英数 60 文字級 / 204 文字 / 日本語) |
| `dirs_h1.lzh` / `dirs_h2.lzh` | 日本語ディレクトリ名 (拡張ヘッダー 0x02 の 0xFF 区切り) |

MS-DOS 期の実装が `PROGRA~1` のように 8.3 へ丸めるのは当時の仕様どおりで、
追随の対象ではない。一方 Windows 95 以降の実装 (UNLHA32.DLL / LHA32 /
LHMelt など) と LHa for UNIX は拡張ヘッダー 0x01 に長い名前を格納するので、
そちらは読めなければならない。

### 再生成

```sh
./tools/build-lha-unix.sh
python3 tools/gen-filename-fixtures.py --out test/fixtures/filenames
```

---

## 検証に使える外部実装

| 実装 | 圧縮 | 展開 | 備考 |
|---|---|---|---|
| オリジナル LHA 2.55 (DOS) | `-lh0-` / `-lh1-` / `-lh5-` | 可 | DOSBox-X 上で実行 |
| LHa for UNIX | `-lh0-` / `-lh1-` / `-lh5-` / `-lh6-` / `-lh7-` | 可 | `-lh4-` は書けない |
| lhasa | **不可 (展開専用)** | `-lh1-` を含め広く可 | `brew install lhasa` |
| libarchive (`bsdtar`) | 不可 | **`-lh1-` は非対応** | macOS 標準 |

**7-Zip に LZH エンコーダーは歴史上存在しない** (`-tlzh` は展開専用)。

LHa for UNIX は圧縮しても縮まない入力を暗黙のうちに `-lh0-` とするため、
指定した方式が実際に使われたかは生成後にヘッダーを読んで確認すること。
生成スクリプトはいずれもその確認を行っている。

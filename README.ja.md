# lhats

Node.js とブラウザで LZH (LHA) 書庫を読むための、依存パッケージゼロの
純粋 TypeScript ライブラリ。

*[English](README.md)*

**このライブラリは書庫を読みます。作りません。** → [なぜ展開専用か](#なぜ展開専用か)

## なぜ作るのか

**このライブラリの目的は、古い書庫を読み続けられるようにすることです。**

LZH は 1980 年代後半から 1990 年代にかけて、日本で事実上の標準だった書庫形式です。
当時作られた膨大な資料が今も `.lzh` のままで残っている一方、それを開けるツールは
DOS や Windows のプログラムで、動かすこと自体が年々難しくなっています。

lhats は約 2,000 行の TypeScript だけでできていて、`Uint8Array` が動くJavaScript
実行環境であればNode.js、ブラウザ、あるいはCloudflareWorkersなど、どこでも実行可能です。

## なぜ展開専用か

2010 年、Windows でもっとも広く使われていた LZH 実装 UNLHA32.DLL の作者である
Micco 氏は、LZH のヘッダー処理における脆弱性を公表した上で開発を終了し、
**新規 LZH 書庫の作成の中止を呼びかけられました**。
形式の主要実装を担ってきた当人が、この形式を畳むべきだと判断したことの重みを
受け止めています。

経緯を踏まえれば、2026 年になって改めて LZH 書庫を作る手段を提供するのはまず
ありえないと考えています。

一方で「新しく作るのをやめる」ことと「既にある書庫が読めなくなる」ことは
まったく別の話で、当時求められたのは前者だけです。

このライブラリの目的は、あくまで過去の資産の活用にあります。

## インストール

```sh
npm install @kirinsaninc/lhats
```

## 使い方

```ts
import { LhaReader, Uint8ArrayReader, Uint8ArrayWriter } from "@kirinsaninc/lhats";

const reader = new LhaReader(new Uint8ArrayReader(archiveBytes));
for (const entry of await reader.getEntries()) {
  if (entry.directory) continue;
  const data = await entry.getData(new Uint8ArrayWriter());
  // ...
}
await reader.close();
```

`Writer` と `Uint8ArrayWriter` は**展開結果の受け皿**であって、
書庫を組み立てるためのものではありません。

### Shift_JIS (CP932) のファイル名 — 最初に読んでください

**LZH のヘッダーはファイル名をバイト列としてしか持たず、文字コードの指定欄がありません。**
日本で作られた書庫はほぼ CP932 です。lhats は文字コードを推測しません。
デコーダーを渡してください。

```ts
// TextDecoder("shift_jis") は Node にも主要ブラウザにもある
const reader = new LhaReader(new Uint8ArrayReader(bytes), {
  filenameDecoder: (b) => new TextDecoder("shift_jis").decode(b),
});
```

これを渡さないと、実在する書庫の大半で文字化けします。
既定のデコーダーは UTF-8 を試し、失敗したらバイト値を保つ Latin-1 に落ちます。

### 壊れた書庫

CRC-16 の不一致は**既定で例外を投げます**。

```ts
const reader = new LhaReader(source, {
  checkCrc: "warn",                       // 壊れた書庫から読めるだけ読みたい場合
  onCrcMismatch: ({ filename }) => console.warn(`破損: ${filename}`),
});
```

## 対応形式

| 方式 | 備考 |
|---|---|
| `-lh0-` | 無圧縮 |
| `-lh1-` | LZSS 4KB + 適応的ハフマン (LHarc 期) |
| `-lh4-` | 4KB 辞書 |
| `-lh5-` | 8KB 辞書 — もっとも多い |
| `-lh6-` | 32KB 辞書 |
| `-lh7-` | 64KB 辞書 |
| `-lz4-` | LArc、無圧縮 |
| `-lhd-` | ディレクトリエントリ |

ヘッダーレベル **0 / 1 / 2** に対応。拡張ヘッダー `0x01`（長いファイル名）と
`0x02`（ディレクトリパス）を読むので、Windows 95 以降のアーカイバ
（UNLHA32.DLL、LHA32、LHMelt など）や LHa for UNIX が書いたファイル名が
そのまま取り出せます。

MS-DOS 期の実装が `PROGRA~1` のように 8.3 形式へ丸めるのは当時の仕様どおりで、
それを復元しようとはしません。

## 検証方法

テストフィクスチャは **lhats 自身では作っていません**。外部の実装に生成させ、
さらに別の実装に検証させています。詳細は
[`test/fixtures/README.md`](test/fixtures/README.md)。

| 生成器 | 何を保証するか |
|---|---|
| **オリジナル LHA 2.55**（MS-DOS、吉崎栄泰 氏、1992）を DOSBox-X 上で実行 | `-lh0-`/`-lh1-`/`-lh5-` × ヘッダーレベル 0/1/2 が、本家の圧縮結果とバイト単位で一致すること |
| **LHa for UNIX** | CP932 のファイル名、長いファイル名、日本語のネストしたディレクトリパス |
| **lhasa** / **libarchive** | 同梱フィクスチャがすべて独立した実装に受理されること |

パストラバーサル、途中で切れたストリーム、
サイズ欄の詐称、不正なハフマン符号長表、CRC 不一致、未対応方式など、
いずれも「それらしいデータを返す」のではなく例外にします。

## 制限事項

- ヘッダーレベル 3 は非対応。
- 拡張ヘッダー `0x42`（64bit サイズ）は非対応。4GiB を超えるファイルは読めません。
- 拡張ヘッダー `0x3F`（コメント）、`0x40`/`0x41`（Windows タイムスタンプ）、
  `0x50`–`0x54`（Unix パーミッション、uid/gid）は読み飛ばします。
- シンボリックリンクは非対応。
- `-lh2-`、`-lh3-`、`-lh8-`、`-lhx-`、LArc の `-lzs-`/`-lz5-`、
  PMarc の `-pm0-`/`-pm2-` は非対応。
- 暗号化書庫、分割書庫、自己展開書庫は非対応。
- ストリーミング非対応。書庫全体をメモリに載せ、各エントリも全体を
  展開してから `Writer` に渡します。
- 展開後サイズはエントリあたり 1GiB を上限としています。
- レベル 2 のヘッダー CRC（拡張ヘッダー `0x00`）は読み飛ばします（読み取りも検証もしません）。

## 謝辞

このライブラリは先人の仕事の上に成り立っています。全文は
[NOTICE.md](NOTICE.md) にありますが、とくに次の方々に。

**吉崎栄泰 氏** — LHarc、LHA、そして `lzhuf.c` の作者。`-lh1-` 実装の
直接の出典であり、検証にも氏の LHA 2.55 が実際に出力した書庫を用いています。

**奥村晴彦 氏** — LZSS / LZARI の実装と平易な解説によって、この分野の知識を
広く共有された方。1989 年に `lzhuf.c` のコメントを英訳し、国内で生まれた実装が
世界に届く道を作られました。

**1990〜2000 年代の LHA アーカイバ作者の皆さん** — LHa for UNIX、UNLHA32.DLL、
LHMelt、そして数え切れないほどのフロントエンドや DLL の作者たち。
LZH が「読める形式」であり続けたのは、多くの人が互いの出力を読めるように
作り続けた積み重ねによるものです。

## ライセンス

MIT © kirinsan.inc

/**
 * 復号器の入力境界の検証（レビュー指摘 2 の回帰テスト）。
 *
 * 2 つの穴を塞いだことを、本物の圧縮データで確認する:
 *
 * 1. **エントリ境界**: 復号器は `dataOffset + compressedSize` を超えて
 *    読んではならない。境界が無いと、壊れた非最終エントリの復号が
 *    隣のエントリのバイトをハフマン入力として読み進め、
 *    「入力が尽きた」ことを検出できるのがアーカイブ末尾だけになる。
 *
 * 2. **ブロック途中の切断**: 完全なハフマン表ではどんなビット列も有効な
 *    シンボルに復号されるため、BitReader が終端後に返し続ける 0 の列から
 *    「それらしい」出力が originalSize まで生成されてしまう。
 *    per-symbol の exhausted 検査が無いとこれを検出できない。
 *
 * 入力にはオリジナル LHA 2.55 が生成したフィクスチャを使う。
 * フィクスチャが無い環境ではスキップする（生成方法は test/fixtures/README.md）。
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHeaders } from "../src/header.js";
import { decodeLh5 } from "../src/decoder.js";
import { decodeLh1 } from "../src/lh1.js";
import { LhaFormatError } from "../src/errors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LH5_FIXTURE = path.join(HERE, "fixtures", "orig", "D_H0.LZH");
const LH1_FIXTURE = path.join(HERE, "fixtures", "orig", "O_H0.LZH");
const available = fs.existsSync(LH5_FIXTURE) && fs.existsSync(LH1_FIXTURE);

/** フィクスチャから最初の圧縮エントリ (指定方式) を探す。 */
function firstEntryOf(file: string, method: string) {
  const data = new Uint8Array(fs.readFileSync(file));
  const entry = parseHeaders(data).find((e) => e.method === method);
  if (!entry) throw new Error(`${file} に ${method} エントリがありません`);
  return { data, entry };
}

describe.skipIf(!available)("復号器の入力境界", () => {
  it("-lh5-: ブロック途中で切断された入力は例外を投げる", () => {
    const { data, entry } = firstEntryOf(LH5_FIXTURE, "-lh5-");
    // 圧縮データを半分で切る。切断位置はブロック途中に落ちる
    const cut = entry.dataOffset + Math.floor(entry.compressedSize / 2);
    const truncated = data.slice(0, cut);
    expect(() =>
      decodeLh5(truncated, entry.dataOffset, entry.originalSize, "-lh5-")
    ).toThrow(LhaFormatError);
  });

  it("-lh5-: エントリ終端を超えて隣のバイトを読み進めない", () => {
    const { data, entry } = firstEntryOf(LH5_FIXTURE, "-lh5-");
    // アーカイブ全体を渡しつつ、end をエントリの途中に置く。
    // compressedSize 欄が実際より小さく偽られた状況に相当する。
    // 境界が無い実装では後続バイトを読み進めて「成功」してしまう
    const lyingEnd =
      entry.dataOffset + Math.floor(entry.compressedSize / 2);
    expect(() =>
      decodeLh5(data, entry.dataOffset, entry.originalSize, "-lh5-", lyingEnd)
    ).toThrow(LhaFormatError);
  });

  it("-lh5-: 正しい end を渡せば従来どおり展開できる", () => {
    const { data, entry } = firstEntryOf(LH5_FIXTURE, "-lh5-");
    const out = decodeLh5(
      data,
      entry.dataOffset,
      entry.originalSize,
      "-lh5-",
      entry.dataOffset + entry.compressedSize
    );
    expect(out.length).toBe(entry.originalSize);
  });

  it("-lh1-: ブロック途中で切断された入力は例外を投げる", () => {
    const { data, entry } = firstEntryOf(LH1_FIXTURE, "-lh1-");
    const cut = entry.dataOffset + Math.floor(entry.compressedSize / 2);
    const truncated = data.slice(0, cut);
    expect(() =>
      decodeLh1(truncated, entry.dataOffset, entry.originalSize)
    ).toThrow(LhaFormatError);
  });

  it("-lh1-: エントリ終端を超えて隣のバイトを読み進めない", () => {
    const { data, entry } = firstEntryOf(LH1_FIXTURE, "-lh1-");
    const lyingEnd =
      entry.dataOffset + Math.floor(entry.compressedSize / 2);
    expect(() =>
      decodeLh1(data, entry.dataOffset, entry.originalSize, lyingEnd)
    ).toThrow(LhaFormatError);
  });
});

/**
 * LH4〜LH7 デコーダーモジュール。
 *
 * `-lh4-` (4KB辞書), `-lh5-` (8KB辞書), `-lh6-` (32KB辞書),
 * `-lh7-` (64KB辞書) の静的ハフマン + LZSS を展開する。
 *
 * @module
 */

import { BitReader } from "./bit-reader.js";
import { MAX_ORIGINAL_SIZE } from "./sanitize.js";
import {
  LhaFormatError,
  LhaLimitError,
  LhaUnsupportedError,
  throwTruncated,
} from "./errors.js";

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/**
 * 方式ごとのパラメータ。ここが唯一の情報源であり、
 * 復号ロジック側でこの値を再導出してはならない。
 */
const METHOD_PARAMS: Record<
  string,
  { dictSize: number; np: number; pBits: number }
> = {
  "-lh4-": { dictSize: 1 << 12, np: 14, pBits: 4 },
  "-lh5-": { dictSize: 1 << 13, np: 14, pBits: 4 },
  "-lh6-": { dictSize: 1 << 15, np: 17, pBits: 5 },
  "-lh7-": { dictSize: 1 << 16, np: 17, pBits: 5 },
};

/** Character + Length コード数 (最大) */
const NC = 510;

/** T テーブル用コード数 */
const NT = 19;

/** Character テーブル引きビット数 */
const CBIT = 9;

/** T テーブル引きビット数 */
const TBIT = 5;

// ---------------------------------------------------------------------------
// ハフマンテーブル構築 (内部関数)
// ---------------------------------------------------------------------------

/** 符号長の上限。LZH のハフマン符号は 16 ビットを超えない。 */
const MAX_CODE_LENGTH = 16;

/**
 * 符号長表が復号可能な接頭符号を成しているか検証する。
 *
 * 壊れた書庫や細工された書庫は、辻褄の合わない符号長表を持ちうる。
 * 検査せずに表を組むと範囲外への書き込みが起きるが、TypeScript では
 * 型付き配列の範囲外書き込みは黙って捨てられるためクラッシュしない。
 * 代わりに**歯抜けの表ができ、誤ったデータを黙って返す**ことになる。
 * 展開器にとってこれは最悪の失敗の仕方なので、表を組む前に弾く。
 *
 * Kraft の不等式による検査で、過剰購読（符号が重なる）と
 * 不完全（未定義のビット列が残る）の両方を検出できる。
 *
 * LHa for UNIX の `make_table()` にも同等の検査が
 * CVE-2006-4335 / CVE-2006-4337 への対策として入っている。
 *
 * @param codeLens - 符号長配列
 * @param nSymbols - シンボル数
 * @throws 符号長が上限を超える、または接頭符号として成立しない場合
 */
function validateCodeLengths(codeLens: Uint8Array, nSymbols: number): void {
  let used = 0;
  // 2^-len を 2^16 倍した整数で積む（浮動小数点の誤差を避ける）
  let kraft = 0;

  for (let i = 0; i < nSymbols; i++) {
    const len = codeLens[i];
    if (len === 0) continue;
    if (len > MAX_CODE_LENGTH) {
      throw new LhaFormatError(
        `ハフマン符号長が上限を超えています: シンボル ${i} の長さ ${len} ` +
          `(上限 ${MAX_CODE_LENGTH})。書庫が壊れている可能性があります。`
      );
    }
    used++;
    kraft += 1 << (MAX_CODE_LENGTH - len);
  }

  // 符号が 1 つも無いのは「このブロックに出現しない」という正当な状態
  if (used === 0) return;
  // 単一シンボルは本来「シンボル数 0 + シンボル番号」の特殊形式で表現される
  // ため Kraft 和が 1 にならず、ここでは完全性を要求しない。
  // ただし通常形式で単一シンボルを格納した表は不完全な表になる。
  // そうした表で未割当のビット列に遭遇した場合は、decodeSymbol が
  // 例外を投げる (黙ってシンボル 0 に化けさせない) ことで塞いでいる
  if (used === 1) return;

  const complete = 1 << MAX_CODE_LENGTH;
  if (kraft > complete) {
    throw new LhaFormatError(
      "ハフマン符号表が過剰購読です（符号が重複します）。書庫が壊れている可能性があります。"
    );
  }
  if (kraft < complete) {
    throw new LhaFormatError(
      "ハフマン符号表が不完全です（未定義のビット列が残ります）。書庫が壊れている可能性があります。"
    );
  }
}

/**
 * ハフマンコードテーブルを構築する。
 *
 * Canonical Huffman コードを直接テーブルに配置する方式。
 * tableBits 以下のコード長はテーブル直引き、それ以上はツリートラバース。
 *
 * 表を組む前に {@link validateCodeLengths} で符号長表の妥当性を検査する。
 *
 * @param codeLens  - 各シンボルのコード長配列
 * @param nSymbols  - シンボル数
 * @param tableBits - テーブル引きビット数
 * @returns [table, symLen, left, right]
 *   - table[idx] ≥ 0: シンボル値
 *   - table[idx] < 0: 内部ノードへのリンク (~index)
 *   - symLen: 各シンボルの実際のコード長
 *   - left/right: ツリーの子ノード
 */
function buildHuffmanTable(
  codeLens: Uint8Array,
  nSymbols: number,
  tableBits: number
): [Int32Array, Uint8Array, Int32Array, Int32Array] {
  validateCodeLengths(codeLens, nSymbols);
  // codeLens は各呼び出し元がブロックごとに新規確保するローカル配列なので、
  // コピーせずそのまま符号長表として保持する
  const symLen = codeLens;
  const tableSize = 1 << tableBits;
  // -1 = 未使用
  const table = new Int32Array(tableSize).fill(-1);
  // 内部ノード用 (最大シンボル数*2)
  const left = new Int32Array(nSymbols * 2 + 1).fill(-1);
  const right = new Int32Array(nSymbols * 2 + 1).fill(-1);
  let nextNode = nSymbols; // 内部ノードのインデックスはnSymbols以降

  // コード長ごとのカウントと開始コード計算
  let maxLen = 0;
  for (let i = 0; i < nSymbols; i++) if (codeLens[i] > maxLen) maxLen = codeLens[i];
  if (maxLen === 0) return [table, symLen, left, right];

  const count = new Uint16Array(maxLen + 1);
  for (let i = 0; i < nSymbols; i++) if (codeLens[i] > 0) count[codeLens[i]]++;

  const nextCode = new Uint32Array(maxLen + 2);
  let code = 0;
  for (let len = 1; len <= maxLen; len++) {
    code = (code + count[len - 1]) << 1;
    nextCode[len] = code;
  }

  // 各シンボルをテーブルに配置
  for (let sym = 0; sym < nSymbols; sym++) {
    const len = codeLens[sym];
    if (len === 0) continue;
    const c = nextCode[len]++;

    if (len <= tableBits) {
      // テーブル直引き: 上位 len ビットがコード、残り fill ビットは全パターン埋める
      const fill = tableBits - len;
      const base = c << fill;
      const n = 1 << fill;
      for (let j = 0; j < n; j++) {
        table[base + j] = sym;
      }
    } else {
      // ツリーに登録
      // テーブルは上位 tableBits ビットで引く
      const top = c >>> (len - tableBits);
      if (table[top] === -1) {
        // まず内部ノードを割り当てる
        table[top] = ~nextNode; // 負数(~node = -(node+1)) でノードを示す
        nextNode++;
      }

      // tableBitsより深いビットでツリーを下る
      let node = ~table[top]; // ~(-(node+1)) = node
      for (let bit = len - tableBits - 1; bit >= 1; bit--) {
        const b = (c >>> bit) & 1;
        if (b === 0) {
          if (left[node] < 0) {
            left[node] = nextNode++;
          }
          node = left[node];
        } else {
          if (right[node] < 0) {
            right[node] = nextNode++;
          }
          node = right[node];
        }
      }
      // 最後のビットでシンボルを格納
      const lastBit = c & 1;
      if (lastBit === 0) {
        left[node] = sym;
      } else {
        right[node] = sym;
      }
    }
  }

  return [table, symLen, left, right];
}

// ---------------------------------------------------------------------------
// シンボルデコード (内部関数)
// ---------------------------------------------------------------------------

/**
 * ハフマンテーブルから 1 シンボルをデコードする。
 *
 * @param reader    - ビットリーダー
 * @param table     - ルックアップテーブル (≥0=シンボル, <0=内部ノード ~index)
 * @param symLen    - 各シンボルの実際のコード長
 * @param left      - 左子ノードテーブル
 * @param right     - 右子ノードテーブル
 * @param tableBits - テーブル引きビット数
 * @param nSymbols  - シンボル数 (リーフ判定: node < nSymbols)
 * @returns デコードされたシンボル値
 */
function decodeSymbol(
  reader: BitReader,
  table: Int32Array,
  symLen: Uint8Array,
  left: Int32Array,
  right: Int32Array,
  tableBits: number,
  nSymbols: number
): number {
  const idx = reader.peek(tableBits);
  const entry = table[idx];

  if (entry >= 0) {
    // テーブル直引き: 実際のコード長(≤tableBits)分だけ消費
    reader.read(symLen[entry]);
    return entry;
  }

  if (entry === -1) {
    // 未割当スロット。不完全な符号表 (単一シンボルを通常形式で格納した
    // 細工書庫など) でのみ到達する。ここで 0 を返すと「リテラル 0x00」と
    // 区別が付かず、壊れた入力から捏造データが黙って生成される
    throw new LhaFormatError(
      "ハフマン符号表に存在しないビット列に遭遇しました。書庫が壊れている可能性があります。"
    );
  }

  // 内部ノード: tableBits ビット消費してツリーを下る
  reader.read(tableBits);
  let node = ~entry; // ~(-(node+1)) = node
  while (node >= nSymbols) {
    const bit = reader.read(1);
    const next = bit === 0 ? left[node] : right[node];
    if (next < 0) {
      // 未割当ノード。上と同じく不完全な表でのみ到達する
      throw new LhaFormatError(
        "ハフマン符号表に存在しないビット列に遭遇しました。書庫が壊れている可能性があります。"
      );
    }
    node = next;
  }
  return node;
}

// ---------------------------------------------------------------------------
// LH5/6/7 デコーダ
// ---------------------------------------------------------------------------

/**
 * -lh4-/-lh5-/-lh6-/-lh7- 圧縮データをデコードする。
 *
 * ブロック単位で T → C → P テーブルを読み出し、
 * リテラル / 距離-長さのペアをデコードして出力バッファに書き込む。
 *
 * @param compressedData - 圧縮データを含むバイト列 (通常はアーカイブ全体)
 * @param offset         - 圧縮データの開始オフセット
 * @param originalSize   - 展開後のサイズ (バイト)
 * @param method         - 圧縮方式 (`"-lh4-"` 〜 `"-lh7-"`)
 * @param end            - 圧縮データの終端オフセット (省略時はバイト列末尾)。
 *   複数エントリの書庫では必ずエントリ終端を渡すこと。これが無いと
 *   壊れたエントリの復号が隣のエントリのバイトを読み進めてしまう。
 * @returns 展開されたデータ
 * @throws {LhaLimitError} 展開後サイズが {@link MAX_ORIGINAL_SIZE} を超える場合
 * @throws {LhaUnsupportedError} 未対応の圧縮方式の場合
 * @throws {LhaFormatError} 圧縮データが壊れている・途中で切れている場合
 */
export function decodeLh5(
  compressedData: Uint8Array,
  offset: number,
  originalSize: number,
  method: string,
  end?: number
): Uint8Array {
  // 圧縮爆弾防御: originalSize が上限を超えていたら即座にエラー
  if (originalSize > MAX_ORIGINAL_SIZE) {
    throw new LhaLimitError(
      `展開後サイズが上限 (${MAX_ORIGINAL_SIZE} bytes) を超えています: ${originalSize} bytes`
    );
  }

  const params = METHOD_PARAMS[method];
  if (params === undefined) {
    throw new LhaUnsupportedError(`未対応の圧縮方式: ${method}`, method);
  }
  const { dictSize, np, pBits } = params;
  const dictMask = dictSize - 1;

  const output = new Uint8Array(originalSize);
  const dict = new Uint8Array(dictSize).fill(0x20); // LHA 標準: 辞書はスペース(0x20)で初期化
  let dictPos = 0;
  let outPos = 0;

  const reader = new BitReader(compressedData, offset, end);

  while (outPos < originalSize) {
    // 入力を使い切っているのに出力が足りない = 途中で切れている。
    // BitReader は終端を過ぎると 0 を返し続け、完全なハフマン表では
    // どんなビット列も「有効なシンボル」に復号されてしまうため、
    // この検査が無いと切断された書庫から捏造データが生成される
    if (reader.exhausted) {
      throwTruncated(outPos, originalSize);
    }

    // ブロックサイズ (シンボル数) を読む
    const blockSize = reader.read(16);
    if (blockSize === 0) break;

    // ──── T テーブル (PT テーブル: C テーブル長のハフマン) ────
    let tTable: Int32Array;
    let tSymLen: Uint8Array = new Uint8Array(0);
    let tLeft: Int32Array;
    let tRight: Int32Array;
    let tSingleSym = -1;

    const tLen = reader.read(5);
    if (tLen === 0) {
      tSingleSym = reader.read(5);
      tTable = new Int32Array(0);
      tLeft = new Int32Array(0);
      tRight = new Int32Array(0);
    } else {
      const tCodeLens = new Uint8Array(NT);
      for (let i = 0; i < tLen; i++) {
        let cl = reader.read(3);
        if (cl === 7) {
          while (reader.read(1) === 1) cl++;
        }
        tCodeLens[i] = cl;
        if (i === 2) {
          const skip = reader.read(2);
          for (let s = 0; s < skip; s++) {
            if (i + 1 < NT) {
              i++;
              tCodeLens[i] = 0;
            }
          }
        }
      }
      const built = buildHuffmanTable(tCodeLens, NT, TBIT);
      tTable = built[0];
      tSymLen = built[1];
      tLeft = built[2];
      tRight = built[3];
    }

    const readTSym = (): number => {
      if (tSingleSym >= 0) return tSingleSym;
      return decodeSymbol(reader, tTable, tSymLen, tLeft, tRight, TBIT, NT);
    };

    // ──── C テーブル (リテラル/長さ ハフマン) ────
    let cTable: Int32Array;
    let cSymLen: Uint8Array = new Uint8Array(0);
    let cLeft: Int32Array;
    let cRight: Int32Array;
    let cSingleSym = -1;

    const cLen = reader.read(9);
    if (cLen === 0) {
      cSingleSym = reader.read(9);
      cTable = new Int32Array(0);
      cLeft = new Int32Array(0);
      cRight = new Int32Array(0);
    } else {
      const cCodeLens = new Uint8Array(NC);
      let ci = 0;
      while (ci < cLen) {
        const sym = readTSym();
        if (sym === 0) {
          cCodeLens[ci++] = 0;
        } else if (sym === 1) {
          const runLen = reader.read(4) + 3;
          for (let r = 0; r < runLen && ci < cLen; r++) cCodeLens[ci++] = 0;
        } else if (sym === 2) {
          const runLen = reader.read(9) + 20;
          for (let r = 0; r < runLen && ci < cLen; r++) cCodeLens[ci++] = 0;
        } else {
          cCodeLens[ci++] = sym - 2;
        }
      }
      const builtC = buildHuffmanTable(cCodeLens, NC, CBIT);
      cTable = builtC[0];
      cSymLen = builtC[1];
      cLeft = builtC[2];
      cRight = builtC[3];
    }

    const readCSym = (): number => {
      if (cSingleSym >= 0) return cSingleSym;
      return decodeSymbol(reader, cTable, cSymLen, cLeft, cRight, CBIT, NC);
    };

    // ──── P テーブル (ポジション ハフマン) ────
    let pTable: Int32Array;
    let pSymLen: Uint8Array = new Uint8Array(0);
    let pLeft: Int32Array;
    let pRight: Int32Array;
    let pSingleSym = -1;

    const pLen = reader.read(pBits);
    if (pLen === 0) {
      pSingleSym = reader.read(pBits);
      pTable = new Int32Array(0);
      pLeft = new Int32Array(0);
      pRight = new Int32Array(0);
    } else {
      const pCodeLens = new Uint8Array(np);
      for (let i = 0; i < pLen; i++) {
        let cl = reader.read(3);
        if (cl === 7) {
          while (reader.read(1) === 1) cl++;
        }
        pCodeLens[i] = cl;
      }
      const builtP = buildHuffmanTable(pCodeLens, np, pBits);
      pTable = builtP[0];
      pSymLen = builtP[1];
      pLeft = builtP[2];
      pRight = builtP[3];
    }

    const readPSym = (): number => {
      if (pSingleSym >= 0) return pSingleSym;
      return decodeSymbol(reader, pTable, pSymLen, pLeft, pRight, pBits, np);
    };

    // ──── ブロックデコード ────
    for (let decoded = 0; decoded < blockSize && outPos < originalSize; decoded++) {
      // ブロック途中での入力切れも検出する (lh1.ts と同じ検査)。
      // 完全な符号表では 0 埋めビット列も有効なシンボルに復号されるため、
      // ここで止めないと切断書庫から捏造データが生成され続ける
      if (reader.exhausted) {
        throwTruncated(outPos, originalSize);
      }

      const c = readCSym();

      if (c < 256) {
        // リテラルバイト
        output[outPos++] = c;
        dict[dictPos] = c;
        dictPos = (dictPos + 1) & dictMask;
      } else {
        // 距離-長さペア: 長さ = c - 256 + 3 (最小一致長 = 3)
        const matchLen = c - 256 + 3;

        const pSym = readPSym();
        let position: number;
        if (pSym <= 1) {
          position = pSym;
        } else {
          const extraBits = pSym - 1;
          const extra = reader.read(extraBits);
          position = (1 << extraBits) + extra;
        }

        // 辞書から一致データをコピー
        let srcPos = (dictPos - position - 1 + dictSize) & dictMask;
        for (let k = 0; k < matchLen && outPos < originalSize; k++) {
          const byte = dict[srcPos];
          output[outPos++] = byte;
          dict[dictPos] = byte;
          dictPos = (dictPos + 1) & dictMask;
          srcPos = (srcPos + 1) & dictMask;
        }
      }
    }
  }

  // ブロックが尽きたのに宣言されたサイズに届いていない場合、
  // 出力バッファの残りはゼロ初期化のままである。
  // ここで黙って返すと**壊れた書庫からゼロ埋めのデータが正常な結果として
  // 返る**ことになり、呼び出し側からは検知しようがない。
  if (outPos < originalSize) {
    throwTruncated(outPos, originalSize);
  }

  return output;
}

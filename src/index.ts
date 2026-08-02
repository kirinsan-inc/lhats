/**
 * lhats — 純粋 TypeScript 製の LZH (LHA) 書庫リーダー。
 *
 * Node.js / ブラウザの両環境で動作する（fs 非依存・依存パッケージなし）。
 *
 * 目的は**過去資産の継承**にある。1980〜90 年代に作られて今も残っている
 * LZH 書庫を、ネイティブバインディングも WASM も使わずに読めるようにする。
 *
 * ## 展開専用である
 *
 * このライブラリは書庫を**作らない**。意図的にそうしている。
 *
 * LZH は 2010 年、UNLHA32.DLL の作者である Micco 氏が、ヘッダー処理の
 * 脆弱性を公表した上で開発を終了し、**新規に LZH 書庫を作ることをやめる
 * よう明確に呼びかけた**形式である。当時もっとも広く使われていた実装の
 * 作者による、形式そのものを畳む判断だった。
 *
 * その経緯を踏まえれば、今あらためて LZH 書庫を作る手段を提供するのは
 * 筋が通らない。一方で「既にある書庫が読めなくなる」ことは別の問題であり、
 * そここそが本ライブラリの役割である。
 *
 * 新しく書庫が必要なら ZIP や 7z を使うこと。
 *
 * ## 対応形式
 *
 * | 方式 | 展開 | アルゴリズム |
 * |---|---|---|
 * | -lh0- | ✅ | 無圧縮 |
 * | -lh1- | ✅ | LZSS (4KB) + 適応的ハフマン |
 * | -lh4- | ✅ | LZSS + 静的ハフマン (4KB 辞書) |
 * | -lh5- | ✅ | LZSS + 静的ハフマン (8KB 辞書) |
 * | -lh6- | ✅ | LZSS + 静的ハフマン (32KB 辞書) |
 * | -lh7- | ✅ | LZSS + 静的ハフマン (64KB 辞書) |
 * | -lz4- | ✅ | LArc、無圧縮 |
 * | -lhd- | ✅ | ディレクトリエントリ |
 *
 * ヘッダーレベル 0 / 1 / 2 に対応。Windows 95 以降の実装が使う
 * 拡張ヘッダー 0x01 (長いファイル名) / 0x02 (ディレクトリ) も読める。
 *
 * ファイル名の文字コードは推測しない。CP932 の書庫を読むには
 * {@link LhaReaderOptions.filenameDecoder} を渡すこと。
 *
 * 展開結果は、オリジナル LHA 2.55 (MS-DOS, 吉崎栄泰 氏, 1992) および
 * LHa for UNIX が実際に出力した書庫に対して、バイト単位で一致を検証している。
 *
 * ## 使い方
 *
 * ```ts
 * import { LhaReader, Uint8ArrayReader, Uint8ArrayWriter } from "@kirinsaninc/lhats";
 *
 * const reader = new LhaReader(new Uint8ArrayReader(archiveData), {
 *   // 日本語の書庫はほぼ CP932。これを渡さないと文字化けする
 *   filenameDecoder: (b) => new TextDecoder("shift_jis").decode(b),
 * });
 *
 * for (const entry of await reader.getEntries()) {
 *   if (entry.directory) continue;
 *   const content = await entry.getData(new Uint8ArrayWriter());
 * }
 * await reader.close();
 * ```
 *
 * なお {@link Writer} と {@link Uint8ArrayWriter} は**展開結果の受け皿**で
 * あって、書庫を作るためのものではない。
 *
 * @module
 */

// Core classes
export { LhaReader } from "./reader.js";

// 出力先の抽象 (zip.js 互換)。展開結果の受け皿であって、書庫の作成には使わない
export { Uint8ArrayReader, Uint8ArrayWriter } from "./io.js";

// Types
export type {
  Reader,
  Writer,
  LhaEntry,
  LhaGetDataOptions,
  LhaReaderOptions,
  AbortSignalLike,
} from "./types.js";

// エラー型。壊れている / 未対応 / CRC 不一致 / 上限超過を
// instanceof または .code でプログラム判別できる
export {
  LhaError,
  LhaFormatError,
  LhaUnsupportedError,
  LhaCrcError,
  LhaLimitError,
} from "./errors.js";

// Utilities
export { calcCrc16 } from "./crc.js";

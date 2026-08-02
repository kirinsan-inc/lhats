/**
 * LhaReader — zip.js の ZipReader に対応する LZH 読み取りクラス。
 *
 * アーカイブ全体を Reader から読み込み、ヘッダーをパースして
 * エントリ一覧を提供する。各エントリの `getData()` で個別に展開可能。
 *
 * @example
 * ```ts
 * import { LhaReader, Uint8ArrayReader, Uint8ArrayWriter } from "@kirinsaninc/lhats";
 *
 * const reader = new LhaReader(new Uint8ArrayReader(data));
 * const entries = await reader.getEntries();
 * for (const entry of entries) {
 *   if (!entry.directory) {
 *     const content = await entry.getData(new Uint8ArrayWriter());
 *     console.log(entry.filename, content.length);
 *   }
 * }
 * await reader.close();
 * ```
 *
 * @module
 */

import type { Reader, Writer, LhaEntry, LhaGetDataOptions, LhaReaderOptions } from "./types.js";
import { parseHeaders, type RawEntry } from "./header.js";
import { decodeLh5 } from "./decoder.js";
import { decodeLh1 } from "./lh1.js";
import { calcCrc16 } from "./crc.js";
import { MAX_ORIGINAL_SIZE } from "./sanitize.js";
import {
  LhaCrcError,
  LhaFormatError,
  LhaLimitError,
  LhaUnsupportedError,
} from "./errors.js";

/**
 * LZH アーカイブを読み取るクラス。
 *
 * zip.js の `ZipReader` と同じパターンで使用できる:
 * 1. コンストラクタに `Reader` を渡す
 * 2. `getEntries()` でエントリ一覧を取得
 * 3. 各エントリの `getData(writer)` で展開
 * 4. `close()` でリソース解放
 */
export class LhaReader {
  private reader: Reader;
  private options: LhaReaderOptions;
  private entriesPromise: Promise<LhaEntry[]> | null = null;
  private closed = false;

  /**
   * @param reader - アーカイブデータの Reader
   * @param options - リーダーオプション
   */
  constructor(reader: Reader, options?: LhaReaderOptions) {
    this.reader = reader;
    this.options = options ?? {};
  }

  /**
   * アーカイブ内の全エントリを取得する。
   *
   * 初回呼び出し時にデータを読み込んでヘッダーをパースする。
   * 2回目以降はキャッシュを返す。
   *
   * @returns エントリ情報の配列。各エントリの `getData()` で展開可能。
   */
  async getEntries(): Promise<LhaEntry[]> {
    if (this.closed) {
      throw new Error(
        "close() 済みの LhaReader です。読み直す場合は新しいインスタンスを作成してください。"
      );
    }
    // Promise 自体をキャッシュする。
    // - 2 回目以降の呼び出しは同一のエントリオブジェクトを返す
    //   (毎回作り直すと、呼び出し側の === 比較や Map キーが壊れる)
    // - 並行して 2 回呼ばれても読み込みは 1 回しか走らない
    this.entriesPromise ??= this.loadEntries();
    return this.entriesPromise;
  }

  /** アーカイブを読み込み、ヘッダーを解析してエントリ一覧を構築する。 */
  private async loadEntries(): Promise<LhaEntry[]> {
    if (this.reader.init) {
      await this.reader.init();
    }
    const data = await this.reader.readUint8Array(0, this.reader.size);
    const rawEntries = parseHeaders(data, this.options.filenameDecoder);
    return rawEntries.map((raw) => this.createEntry(raw, data));
  }

  /**
   * RawEntry から zip.js 互換の LhaEntry を生成する。
   */
  private createEntry(raw: RawEntry, data: Uint8Array): LhaEntry {
    const entry: LhaEntry = {
      filename: raw.filename,
      directory: raw.isDirectory,
      compressedSize: raw.compressedSize,
      uncompressedSize: raw.originalSize,
      lastModDate: raw.lastModDate,
      encrypted: false,
      method: raw.method,
      headerLevel: raw.headerLevel,
      osId: raw.osId,
      crc16: raw.fileCrc ?? 0,

      getData: async <T>(writer: Writer<T>, options?: LhaGetDataOptions): Promise<T> => {
        return this.extractEntry(raw, data, writer, options);
      },
    };
    return entry;
  }

  /**
   * エントリのデータを展開して Writer に書き込む。
   */
  private async extractEntry<T>(
    raw: RawEntry,
    data: Uint8Array,
    writer: Writer<T>,
    options?: LhaGetDataOptions
  ): Promise<T> {
    // 中断チェック
    options?.signal?.throwIfAborted();

    // 圧縮爆弾防御
    if (raw.originalSize > MAX_ORIGINAL_SIZE) {
      throw new LhaLimitError(
        `展開後サイズが上限 (${MAX_ORIGINAL_SIZE} bytes) を超えています: ${raw.originalSize} bytes`
      );
    }

    // データ範囲チェック
    const dataEnd = raw.dataOffset + raw.compressedSize;
    if (dataEnd > data.length) {
      throw new LhaFormatError(
        `圧縮データの範囲がファイルサイズを超えています (offset=${raw.dataOffset}, compressed=${raw.compressedSize}, fileSize=${data.length})`
      );
    }

    let result: Uint8Array;

    const method = raw.method;
    if (method === "-lhd-") {
      // ディレクトリエントリ。データを持たないので常に空を返す。
      // zip.js の流儀ではディレクトリの getData も呼べてよい
      result = new Uint8Array(0);
    } else if (method === "-lh0-" || method === "-lz4-") {
      // 無圧縮 (ストア)。ストアでは originalSize と compressedSize が一致する
      // はずで、originalSize がエントリのデータ範囲を超える場合は
      // ヘッダーが壊れている (slice は黙って短い結果に丸めてしまうため、
      // ここで明示的に検査する)
      if (raw.dataOffset + raw.originalSize > dataEnd) {
        throw new LhaFormatError(
          `無圧縮エントリのサイズ欄が矛盾しています ` +
            `(originalSize=${raw.originalSize}, compressedSize=${raw.compressedSize})。` +
            `書庫が壊れている可能性があります`
        );
      }
      result = data.slice(raw.dataOffset, raw.dataOffset + raw.originalSize);
    } else if (method === "-lh1-") {
      result = decodeLh1(data, raw.dataOffset, raw.originalSize, dataEnd);
    } else if (method === "-lh4-" || method === "-lh5-" || method === "-lh6-" || method === "-lh7-") {
      result = decodeLh5(data, raw.dataOffset, raw.originalSize, method, dataEnd);
    } else {
      throw new LhaUnsupportedError(
        `この LZH ファイルの圧縮形式 (${method}) には対応していません`,
        method
      );
    }

    // CRC-16 検証。
    // 既定は "throw"。不一致を黙って通すと壊れたデータが正常な結果として
    // 返ってしまい、利用側から検知しようがない。
    // 0x0000 も正当な CRC 値である (空ファイルはすべて 0)。
    // 「CRC 欄が存在しない」ことは fileCrc === undefined だけが表す
    const policy = this.options.checkCrc ?? "throw";
    if (policy !== "none" && raw.fileCrc !== undefined) {
      const computed = calcCrc16(result, 0, result.length);
      if (computed !== raw.fileCrc) {
        if (policy === "throw") {
          throw new LhaCrcError(raw.filename, raw.fileCrc, computed);
        }
        this.options.onCrcMismatch?.({
          filename: raw.filename,
          expected: raw.fileCrc,
          actual: computed,
        });
      }
    }

    // 進捗通知
    options?.onprogress?.(result.length, raw.originalSize);

    // Writer に書き込み
    if (writer.init) {
      await writer.init();
    }
    await writer.writeUint8Array(result);
    return writer.getData();
  }

  /**
   * リーダーを閉じる。以後の getEntries() は例外になる。
   *
   * 注意: close() はキャッシュへの参照を手放すだけである。呼び出し側が
   * 保持している LhaEntry はアーカイブ全体のバイト列を捕捉しているため、
   * エントリを保持し続ける限りメモリは解放されない。
   */
  async close(): Promise<void> {
    this.closed = true;
    this.entriesPromise = null;
  }
}

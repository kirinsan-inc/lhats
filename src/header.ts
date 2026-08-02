/**
 * LZH ヘッダパーサーモジュール。
 *
 * Level 0 / Level 1 / Level 2 ヘッダーの解析を提供する。
 * 解析専用であり、ヘッダーの生成機能は持たない (本ライブラリは展開専用)。
 *
 * @module
 */

import { sanitizeEntryPath, MAX_HEADER_SIZE } from "./sanitize.js";
import { LhaFormatError, LhaUnsupportedError } from "./errors.js";

// ---------------------------------------------------------------------------
// RawEntry インターフェース
// ---------------------------------------------------------------------------

/**
 * パース済みの LZH ヘッダーから取得できる生のエントリ情報。
 *
 * ヘッダーレベルや OS ID など、ヘッダーの生データに近い形で保持する。
 */
export interface RawEntry {
  /** 圧縮方式 (`"-lh0-"`, `"-lh5-"` など) */
  method: string;
  /** 圧縮後サイズ (バイト) */
  compressedSize: number;
  /** 展開後サイズ (バイト) */
  originalSize: number;
  /** ファイル名 (パス付き) */
  filename: string;
  /** 圧縮データの開始オフセット */
  dataOffset: number;
  /** ディレクトリかどうか */
  isDirectory: boolean;
  /** ファイル CRC-16 値 (ヘッダーから読み取り。未設定時は undefined) */
  fileCrc?: number;
  /** ヘッダレベル (0, 1, 2) */
  headerLevel: number;
  /** OS ID (ヘッダから取得。未設定時は undefined) */
  osId?: number;
  /** 最終更新日時 */
  lastModDate: Date;
}

// ---------------------------------------------------------------------------
// ファイル名デコーダーのデフォルト実装
// ---------------------------------------------------------------------------

/**
 * デフォルトのファイル名デコーダー。
 *
 * UTF-8 として有効であればそのまま使用し、
 * 無効の場合は Latin-1 としてそのままバイト→文字変換する。
 * iconv-lite に依存しない。
 *
 * @param bytes - デコード対象のバイト列
 * @returns デコードされた文字列
 */
function defaultFilenameDecoder(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // UTF-8 で無効 → Latin-1 (バイト値をそのまま文字コードとする)
    let result = "";
    for (let i = 0; i < bytes.length; i++) {
      result += String.fromCharCode(bytes[i]);
    }
    return result;
  }
}

/**
 * エントリがディレクトリかどうかを判定する。
 *
 * 一次判定は圧縮方式そのもの: `-lhd-` はディレクトリ専用の方式である。
 * 末尾区切り文字のヒューリスティックは、`-lhd-` を使わずディレクトリを
 * 表現する古い書庫のための補助にすぎない。
 *
 * 逆に `-lhd-` エントリの格納名は末尾区切りを持つとは限らない
 * (MS-DOS 期のツールは `SUBDIR` とだけ格納するものがある) ため、
 * ヒューリスティック**だけ**に頼ると -lhd- エントリがファイル扱いになり、
 * 利用側が getData を呼んで「未対応方式」で失敗する。
 *
 * @param method - 圧縮方式
 * @param originalSize - 展開後サイズ
 * @param filename - デコード済みファイル名
 * @returns ディレクトリなら true
 */
function isDirectoryEntry(
  method: string,
  originalSize: number,
  filename: string
): boolean {
  if (method === "-lhd-") return true;
  return (
    originalSize === 0 && (filename.endsWith("/") || filename.endsWith("\\"))
  );
}

/**
 * ディレクトリ名拡張ヘッダー (0x02) のバイト列をパス文字列に変換する。
 *
 * LHA のディレクトリ区切りは 0xFF である。「デコードしてから 0xFF を
 * '/' に置換する」順序にすると、0xFF を表現できない文字コード
 * （CP932 など）を注入されたときに区切りが U+FFFD に潰れて失われる。
 * そのため必ずバイト列のまま分割し、各要素を個別にデコードしてから
 * '/' で連結する。
 *
 * 末尾の 0xFF は空要素になり、結果として末尾に '/' が付く。
 * これはファイル名を連結する際に必要な形である。
 *
 * @param bytes - 拡張ヘッダー 0x02 のデータ部
 * @param decodeName - ファイル名デコーダー
 * @returns '/' 区切りのディレクトリパス
 */
function decodeDirectoryName(
  bytes: Uint8Array,
  decodeName: (bytes: Uint8Array) => string
): string {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i === bytes.length || bytes[i] === 0xff) {
      parts.push(decodeName(bytes.subarray(start, i)));
      start = i + 1;
    }
  }
  return parts.join("/");
}

// ---------------------------------------------------------------------------
// DOS 日時パーサー
// ---------------------------------------------------------------------------

/**
 * DOS タイムスタンプ (2byte time + 2byte date) を Date に変換する。
 *
 * Level 0 / Level 1 ヘッダーで使用される。
 *
 * @param time - DOS 時刻 (16bit): hhhhhmmmmmmsssss (秒は2秒単位)
 * @param date - DOS 日付 (16bit): yyyyyyymmmmddddd (年は1980基準)
 * @returns 変換された Date
 */
function parseDosDateTime(time: number, date: number): Date {
  const second = (time & 0x1F) * 2;
  const minute = (time >>> 5) & 0x3F;
  const hour = (time >>> 11) & 0x1F;
  const day = date & 0x1F;
  const month = ((date >>> 5) & 0x0F) - 1; // 0-indexed for Date constructor
  const year = ((date >>> 9) & 0x7F) + 1980;
  return new Date(year, month, day, hour, minute, second);
}

// ---------------------------------------------------------------------------
// Level 0 ヘッダーパーサー
// ---------------------------------------------------------------------------

/**
 * Level 0 ヘッダーをパースする。
 *
 * @param data - アーカイブ全体のバイト列
 * @param pos - ヘッダーの開始オフセット
 * @param view - DataView
 * @param method - 圧縮方式
 * @param decodeName - ファイル名デコーダー
 * @returns パースされた RawEntry (失敗時 null)
 */
function parseLevel0Header(
  data: Uint8Array,
  pos: number,
  view: DataView,
  method: string,
  decodeName: (bytes: Uint8Array) => string
): RawEntry | null {
  if (pos + 22 > data.length) return null;

  const headerSize = data[pos]; // ヘッダーサイズ (先頭バイト自体とチェックサムを除く)
  // data[pos+1] = チェックサム
  // data[pos+2..pos+6] = method (5 bytes)
  const compressedSize = view.getUint32(pos + 7, true);
  const originalSize = view.getUint32(pos + 11, true);
  // data[pos+15..pos+18] = timestamp (4 bytes, DOS 形式)
  const dosTime = view.getUint16(pos + 15, true);
  const dosDate = view.getUint16(pos + 17, true);
  const lastModDate = parseDosDateTime(dosTime, dosDate);
  // data[pos+19] = attribute
  // data[pos+20] = header level (0)
  const filenameLen = data[pos + 21];

  if (pos + 22 + filenameLen > data.length) return null;
  const filename = decodeName(data.slice(pos + 22, pos + 22 + filenameLen));

  // CRC-16 (ファイル名の直後)。
  // Level 0 の CRC 欄は省略可能で、有無は headerSize 自身が示す:
  //   CRC あり: headerSize >= 22 + filenameLen (method 起点で 20+n の後に 2 バイト)
  //   CRC なし: headerSize == 20 + filenameLen (LArc 期・初期 LHarc の書庫)
  // ここを「アーカイブ全体に 2 バイト残っているか」で判定すると、CRC 欄の
  // ない書庫で圧縮データの先頭 2 バイトを CRC と誤読し、正常な書庫を
  // 既定の checkCrc:"throw" が拒否してしまう。
  const crcPos = pos + 22 + filenameLen;
  const hasCrcField = headerSize >= filenameLen + 22;
  const fileCrc =
    hasCrcField && crcPos + 2 <= data.length
      ? view.getUint16(crcPos, true)
      : undefined;

  // データ開始位置: pos + 2 + headerSize (headerSizeはpos[0]、+2 はheaderSize自身+checksum)
  const dataOffset = pos + 2 + headerSize;
  const isDirectory = isDirectoryEntry(method, originalSize, filename);

  return {
    method,
    compressedSize,
    originalSize,
    filename,
    dataOffset,
    isDirectory,
    fileCrc,
    headerLevel: 0,
    osId: undefined,
    lastModDate,
  };
}

// ---------------------------------------------------------------------------
// Level 1 ヘッダーパーサー
// ---------------------------------------------------------------------------

/**
 * Level 1 ヘッダーをパースする。
 *
 * @param data - アーカイブ全体のバイト列
 * @param pos - ヘッダーの開始オフセット
 * @param view - DataView
 * @param method - 圧縮方式
 * @param decodeName - ファイル名デコーダー
 * @returns パースされた RawEntry (失敗時 null)
 */
function parseLevel1Header(
  data: Uint8Array,
  pos: number,
  view: DataView,
  method: string,
  decodeName: (bytes: Uint8Array) => string
): RawEntry | null {
  if (pos + 27 > data.length) return null;

  const headerSize = data[pos]; // 基本ヘッダーサイズ
  // data[pos+1] = チェックサム
  const compressedSize = view.getUint32(pos + 7, true);
  const originalSize = view.getUint32(pos + 11, true);
  // data[pos+15..pos+18] = timestamp (DOS 形式)
  const dosTime = view.getUint16(pos + 15, true);
  const dosDate = view.getUint16(pos + 17, true);
  const lastModDate = parseDosDateTime(dosTime, dosDate);
  // data[pos+19] = reserved (0x20)
  // data[pos+20] = header level (1)
  const filenameLen = data[pos + 21];

  if (pos + 22 + filenameLen + 2 > data.length) return null;
  let filename = decodeName(data.slice(pos + 22, pos + 22 + filenameLen));

  // CRC-16 (ファイル名の直後)
  const fileCrc = view.getUint16(pos + 22 + filenameLen, true);

  // OS ID (CRC の直後の1バイト)
  const osIdPos = pos + 22 + filenameLen + 2;
  const osId = osIdPos < data.length ? data[osIdPos] : undefined;

  // 基本ヘッダーの終わり:
  // Level 1 の headerSize（pos+0 の値）は「ヘッダー先頭 pos からの相対的なバイト数」を示す。
  // CRC(2) + OS_ID(1) まで含めた位置 = pos + headerSize。
  // 拡張ヘッダーはここから始まる。
  const baseHeaderEnd = pos + headerSize;

  // 拡張ヘッダーを読む
  let extPos = baseHeaderEnd;
  let totalExtSize = 0;
  let directoryName = "";

  while (extPos + 2 <= data.length) {
    const extSize = view.getUint16(extPos, true);
    if (extSize === 0) {
      // 終端 (0x0000) はディスク上 2 バイトを占めるので extPos は進めるが、
      // size は 0 なので totalExtSize には加算しない。
      // Level 1 の compressedSize (skip size) は
      //   実データ長 + 非ゼロの拡張ヘッダー size 合計
      // であり、終端の 2 バイトを含まない (LHa for UNIX の実出力で確認済み)。
      // ここで 2 を足すと実データ長を 2 バイト過小に見積もり、
      // 次エントリの開始位置がずれて複数エントリの解析が壊れる。
      extPos += 2;
      break;
    }
    if (extPos + extSize > data.length) break;

    const extType = data[extPos + 2];
    if (extType === 0x01) {
      // ファイル名拡張ヘッダー
      filename = decodeName(data.slice(extPos + 3, extPos + extSize));
    } else if (extType === 0x02) {
      // ディレクトリ名拡張ヘッダー
      directoryName = decodeDirectoryName(
        data.subarray(extPos + 3, extPos + extSize),
        decodeName
      );
    }

    extPos += extSize;
    totalExtSize += extSize;
  }

  if (directoryName) {
    filename = directoryName + filename;
  }

  // Level 1: 圧縮データの実際のサイズ = compressedSize - totalExtSize (拡張ヘッダー分)
  const dataOffset = extPos;
  const actualCompressedSize = compressedSize - totalExtSize;

  const isDirectory = isDirectoryEntry(method, originalSize, filename);

  return {
    method,
    // 0 は「空ファイル」「ディレクトリ」の正当な値なので、そのまま採用する。
    // ここを `> 0` にすると空エントリで compressedSize (拡張ヘッダー込み) に
    // 退避してしまい、次エントリの開始位置が拡張ヘッダー分だけずれて
    // 以降のエントリがすべて失われる。負値だけが異常。
    compressedSize:
      actualCompressedSize >= 0 ? actualCompressedSize : compressedSize,
    originalSize,
    filename,
    dataOffset,
    isDirectory,
    fileCrc,
    headerLevel: 1,
    osId,
    lastModDate,
  };
}

// ---------------------------------------------------------------------------
// Level 2 ヘッダーパーサー
// ---------------------------------------------------------------------------

/**
 * Level 2 ヘッダーをパースする。
 *
 * @param data - アーカイブ全体のバイト列
 * @param pos - ヘッダーの開始オフセット
 * @param view - DataView
 * @param method - 圧縮方式
 * @param decodeName - ファイル名デコーダー
 * @returns パースされた RawEntry (失敗時 null)
 */
function parseLevel2Header(
  data: Uint8Array,
  pos: number,
  view: DataView,
  method: string,
  decodeName: (bytes: Uint8Array) => string
): RawEntry | null {
  if (pos + 26 > data.length) return null;

  const totalHeaderSize = view.getUint16(pos, true);

  // セキュリティ: Micco 氏指摘の 4KB 超ヘッダー = exploit 扱い
  if (totalHeaderSize > MAX_HEADER_SIZE) return null;
  // 仕様: level-2 の totalHeaderSize が 256 の倍数は先頭バイト 0 = 終端扱いで不正
  if (totalHeaderSize > 0 && (totalHeaderSize & 0xff) === 0) return null;

  // data[pos+2..pos+6] = method (5 bytes)
  const compressedSize = view.getUint32(pos + 7, true);
  const originalSize = view.getUint32(pos + 11, true);
  // data[pos+15..pos+18] = timestamp (Unix time, 4 bytes)
  const unixTime = view.getUint32(pos + 15, true);
  const lastModDate = new Date(unixTime * 1000);
  // data[pos+19] = reserved
  // data[pos+20] = header level (2)
  const fileCrc = view.getUint16(pos + 21, true);
  // data[pos+23] = OS ID
  const osId = data[pos + 23];

  let filename = "";
  let directoryName = "";

  // 拡張ヘッダーは pos+24 から始まる
  let extPos = pos + 24;
  const headerEnd = pos + totalHeaderSize;

  while (extPos + 2 <= headerEnd && extPos + 2 <= data.length) {
    const extSize = view.getUint16(extPos, true);
    if (extSize === 0) break;
    if (extPos + extSize > data.length) break;

    const extType = data[extPos + 2];
    if (extType === 0x01) {
      // ファイル名
      filename = decodeName(data.slice(extPos + 3, extPos + extSize));
    } else if (extType === 0x02) {
      // ディレクトリ名
      directoryName = decodeDirectoryName(
        data.subarray(extPos + 3, extPos + extSize),
        decodeName
      );
    }

    extPos += extSize;
  }

  if (directoryName) {
    filename = directoryName + filename;
  }

  const dataOffset = pos + totalHeaderSize;
  const isDirectory = isDirectoryEntry(method, originalSize, filename);

  return {
    method,
    compressedSize,
    originalSize,
    filename,
    dataOffset,
    isDirectory,
    fileCrc,
    headerLevel: 2,
    osId,
    lastModDate,
  };
}

// ---------------------------------------------------------------------------
// ヘッダーパーサー (エントリポイント)
// ---------------------------------------------------------------------------

/**
 * LZH アーカイブのヘッダーを全エントリ分パースする。
 *
 * Level 0, Level 1, Level 2 ヘッダーに対応する。
 * ファイル名デコーダーは外部から注入可能。デフォルトでは
 * UTF-8 → Latin-1 フォールバックを使用する。
 *
 * ## 失敗の扱い
 *
 * 正常終了は「終端バイト 0x00 に達した」または「アーカイブ末尾に達した」
 * の 2 つだけである。それ以外 — ヘッダーがあるべき位置に署名の無いバイト列が
 * ある、ヘッダーが途中で切れている、未対応のヘッダーレベルに出会った — は
 * すべて例外にする。
 *
 * 以前はこれらを黙って `break` していたため、50 エントリの書庫の 3 番目が
 * 壊れていると 2 件だけ返して**成功したように見えた**。エントリ一覧の無言の
 * 打ち切りはデータの無言の切り捨てであり、この方針で最も避けたい失敗である。
 *
 * @param data - アーカイブ全体のバイト列
 * @param filenameDecoder - ファイル名デコード関数 (省略時はデフォルト)
 * @returns パースされたエントリの配列
 * @throws {LhaFormatError} ヘッダーが壊れている場合
 * @throws {LhaUnsupportedError} ヘッダーレベル 3 など未対応の構造の場合
 */
export function parseHeaders(
  data: Uint8Array,
  filenameDecoder?: (bytes: Uint8Array) => string
): RawEntry[] {
  const decodeName = filenameDecoder ?? defaultFilenameDecoder;
  const entries: RawEntry[] = [];
  let pos = 0;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  while (pos < data.length) {
    // アーカイブ終端 (0x00)。Level 2 はサイズ欄 2 バイトの下位が 0x00 に
    // ならないことが仕様で保証されている (256 の倍数を拒否する) ため、
    // 先頭バイト 0 は常に終端と判定できる
    if (data[pos] === 0) break;

    // 終端バイトなしで末尾に達した場合も正常終了として扱う。
    // ただしヘッダーの途中で切れている場合は下の各判定で例外になる
    if (pos + 7 > data.length) {
      throw new LhaFormatError(
        `オフセット ${pos} でヘッダーが途中で切れています (残り ${data.length - pos} バイト)`
      );
    }

    // 圧縮方式を先読み (pos+2 から 5 バイト)
    const methodBytes = data.slice(pos + 2, pos + 7);
    const method = String.fromCharCode(...methodBytes);

    // 方式チェック (LHA 署名パターン)
    if (!method.startsWith("-lh") || !method.endsWith("-")) {
      if (!method.startsWith("-lz") || !method.endsWith("-")) {
        throw new LhaFormatError(
          entries.length === 0
            ? "LZH アーカイブではありません (先頭にヘッダー署名がありません)"
            : `オフセット ${pos} (${entries.length + 1} 番目のエントリ) の` +
              `ヘッダー署名が不正です。書庫が壊れている可能性があります`
        );
      }
    }

    // Level を取得
    if (pos + 21 > data.length) {
      throw new LhaFormatError(
        `オフセット ${pos} でヘッダーが途中で切れています`
      );
    }
    const headerLevel = data[pos + 20];

    let entry: RawEntry | null = null;

    if (headerLevel === 0) {
      entry = parseLevel0Header(data, pos, view, method, decodeName);
    } else if (headerLevel === 1) {
      entry = parseLevel1Header(data, pos, view, method, decodeName);
    } else if (headerLevel === 2) {
      entry = parseLevel2Header(data, pos, view, method, decodeName);
    } else {
      throw new LhaUnsupportedError(
        `ヘッダーレベル ${headerLevel} には対応していません (対応: 0, 1, 2)`
      );
    }

    if (!entry) {
      throw new LhaFormatError(
        `オフセット ${pos} (${entries.length + 1} 番目のエントリ) の` +
          `ヘッダーを解析できません。書庫が壊れている可能性があります`
      );
    }

    // セキュリティ: パストラバーサル防御 + ファイル名長制限
    entry.filename = sanitizeEntryPath(entry.filename);

    entries.push(entry);
    pos = entry.dataOffset + entry.compressedSize;
  }

  return entries;
}

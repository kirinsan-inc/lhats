/**
 * セキュリティ定数とパスサニタイズモジュール。
 *
 * Micco 氏 MHVI#20100425 の指摘に基づく安全上限と、
 * パストラバーサル攻撃を防止するサニタイズ関数を提供する。
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Security limits
// ---------------------------------------------------------------------------

/**
 * 展開後サイズの上限 (1 GB)。
 * 悪意あるヘッダが巨大な originalSize を主張する圧縮爆弾攻撃を防ぐ。
 */
export const MAX_ORIGINAL_SIZE = 1_073_741_824;

/**
 * ファイル名の最大長。UNLHA32.DLL の慣習に準拠し、
 * 512 文字超の 0x01/0x02 拡張ヘッダーを exploit 扱いとする。
 */
export const MAX_FILENAME_LENGTH = 512;

/**
 * Level 2 ヘッダーの最大サイズ (4 KB)。
 * UNLHA32.DLL は 4KB 超ヘッダーを exploit 扱いとする。
 */
export const MAX_HEADER_SIZE = 4096;

// ---------------------------------------------------------------------------
// Path sanitization
// ---------------------------------------------------------------------------

/**
 * エントリのファイル名をサニタイズし、パストラバーサル攻撃を防止する。
 *
 * - `../` や `..\\` を含むパス要素を除去
 * - 絶対パス（先頭 `/` や `C:\\`）を相対パスに変換
 * - ファイル名長が {@link MAX_FILENAME_LENGTH} を超える場合は切り詰め
 * - バックスラッシュ `\\` を `/` に正規化
 *
 * @param filename - 生のファイル名
 * @returns サニタイズ済みファイル名
 */
export function sanitizeEntryPath(filename: string): string {
  // バックスラッシュを正規化
  let sanitized = filename.replace(/\\/g, "/");
  // 先頭のドライブレター (C: 等) やスラッシュを除去
  sanitized = sanitized.replace(/^[A-Za-z]:/, "").replace(/^\/+/, "");
  // パス区切りで分割し、".." を含むセグメントを除去
  const parts = sanitized.split("/").filter(
    (p) => p !== ".." && p !== "."
  );
  sanitized = parts.join("/");
  // 長さ制限
  if (sanitized.length > MAX_FILENAME_LENGTH) {
    sanitized = sanitized.substring(0, MAX_FILENAME_LENGTH);
  }
  return sanitized;
}

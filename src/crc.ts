/**
 * CRC-16 計算モジュール。
 *
 * LZH 標準の CRC-16 (多項式 0x8005, ビット反転) を提供する。
 *
 * @module
 */

/** CRC-16 ルックアップテーブル (多項式 0x8005, ビット反転) */
const CRC16_TABLE = new Uint16Array(256);

// テーブル初期化 (モジュールロード時に一度だけ実行)
for (let i = 0; i < 256; i++) {
  let r = i;
  for (let j = 0; j < 8; j++) {
    if (r & 1) {
      r = (r >>> 1) ^ 0xA001;
    } else {
      r >>>= 1;
    }
  }
  CRC16_TABLE[i] = r;
}

/**
 * CRC-16 を計算する。
 *
 * @param data - 計算対象のバイト列
 * @param offset - 開始オフセット (default: 0)
 * @param length - 計算するバイト数 (default: data.length - offset)
 * @returns CRC-16 値
 */
export function calcCrc16(
  data: Uint8Array,
  offset = 0,
  length = data.length - offset
): number {
  let crc = 0;
  const end = Math.min(offset + length, data.length);
  for (let i = offset; i < end; i++) {
    crc = (crc >>> 8) ^ CRC16_TABLE[(crc ^ data[i]) & 0xFF];
  }
  return crc;
}

/**
 * ビット単位読み取りモジュール。
 *
 * LZH のハフマンデコーダが 1〜16 ビット単位の読み出しを要求するため、
 * 内部で 32 ビットのバッファリングを行う。
 *
 * @module
 */

/**
 * バイトバッファからビット単位で読み出すリーダー。
 *
 * @example
 * ```ts
 * const reader = new BitReader(data, 0);
 * const val = reader.read(5); // 上位 5 ビットを消費
 * ```
 */
export class BitReader {
  private buf: Uint8Array;
  private pos: number;
  private end: number;
  private bitBuf: number;
  private bitCount: number;

  /**
   * @param data - 読み出し対象のバイト列
   * @param offset - 読み出し開始オフセット
   * @param end - 読み出し終端 (このオフセットの手前まで読む)。
   *   省略時は `data.length`。
   *
   *   **複数エントリの書庫では必ずエントリの圧縮データ終端を渡すこと。**
   *   これが無いと、壊れたエントリの復号が隣のエントリのバイトを
   *   ハフマン入力として読み進めてしまい、「入力が尽きた」ことを
   *   検出できるのがアーカイブ全体の末尾だけになる。
   */
  constructor(data: Uint8Array, offset: number, end: number = data.length) {
    this.buf = data;
    this.pos = offset;
    this.end = Math.min(end, data.length);
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  /**
   * 内部バッファにビットを充填する。
   */
  private fill(): void {
    while (this.bitCount <= 24 && this.pos < this.end) {
      // JS の |= は符号付き 32bit なので >>> 0 で符号なしに変換
      this.bitBuf = (this.bitBuf | (this.buf[this.pos++] << (24 - this.bitCount))) >>> 0;
      this.bitCount += 8;
    }
  }

  /**
   * 上位 n ビットを覗き見する (消費しない)。
   *
   * @param n - ビット数 (1–16)
   * @returns n ビット分の値
   */
  peek(n: number): number {
    this.fill();
    return (this.bitBuf >>> (32 - n)) & ((1 << n) - 1);
  }

  /**
   * 上位 n ビットを消費して返す。
   *
   * @param n - ビット数 (1–16)
   * @returns n ビット分の値
   */
  read(n: number): number {
    this.fill();
    const val = (this.bitBuf >>> (32 - n)) & ((1 << n) - 1);
    this.bitBuf = (this.bitBuf << n) >>> 0;
    this.bitCount -= n;
    return val;
  }

  /**
   * 実データを使い切り、以降は 0 を返すだけの状態になっているか。
   *
   * このリーダーは入力末尾を過ぎても例外を投げず 0 を返し続ける。
   * ハフマン復号の途中で末尾を跨ぐのは正常な動作（最後のシンボルが
   * バイト境界をまたぐため）なので、読み出しのたびに弾くわけにはいかない。
   *
   * 代わりに、復号側が「まだ出力が足りないのに入力が尽きた」ことを
   * 検出できるようにこれを公開する。これが無いと、壊れた書庫から
   * ゼロ埋めのデータを黙って返してしまう。
   */
  get exhausted(): boolean {
    return this.pos >= this.end && this.bitCount <= 0;
  }
}

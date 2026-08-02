/**
 * 型付きエラーモジュール。
 *
 * 利用側が「書庫が壊れている」「形式が未対応」「安全上限に達した」
 * 「CRC が合わない」を**プログラムで判別**できるようにする。
 * メッセージ文字列は人間向けであり、判別はクラス (instanceof) と
 * `code` プロパティで行うこと。メッセージの文面は互換性の対象にしない。
 *
 * @module
 */

/**
 * lhats が投げるすべてのエラーの基底クラス。
 */
export class LhaError extends Error {
  /** プログラム判別用のエラーコード。 */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * 書庫の構造が壊れている・仕様に反している場合のエラー。
 *
 * ヘッダーの破損、途中で切れた圧縮データ、不正なハフマン符号表など。
 */
export class LhaFormatError extends LhaError {
  constructor(message: string) {
    super("LHA_FORMAT", message);
  }
}

/**
 * 形式としては認識できるが、このライブラリが対応していない場合のエラー。
 *
 * 未対応の圧縮方式 (`-lh2-` など) やヘッダーレベル 3 など。
 * 壊れているわけではないので、利用側は別の実装へのフォールバックを
 * 検討できる。
 */
export class LhaUnsupportedError extends LhaError {
  /** 未対応だった圧縮方式 (方式起因の場合のみ)。 */
  readonly method?: string;

  constructor(message: string, method?: string) {
    super("LHA_UNSUPPORTED", message);
    this.method = method;
  }
}

/**
 * 展開結果の CRC-16 がヘッダーの記録と一致しない場合のエラー。
 *
 * `checkCrc: "throw"` (既定) のときに投げられる。
 */
export class LhaCrcError extends LhaError {
  /** 対象のファイル名。 */
  readonly filename: string;
  /** ヘッダーに記録されていた CRC-16。 */
  readonly expected: number;
  /** 展開結果から計算した CRC-16。 */
  readonly actual: number;

  constructor(filename: string, expected: number, actual: number) {
    const hex = (n: number) => `0x${n.toString(16).padStart(4, "0")}`;
    super(
      "LHA_CRC",
      `CRC-16 が一致しません: "${filename}" ` +
        `(expected=${hex(expected)}, actual=${hex(actual)})。` +
        `書庫が壊れている可能性があります。` +
        `読めるだけ読みたい場合は checkCrc: "warn" を指定してください。`
    );
    this.filename = filename;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * 安全上限 (展開後サイズなど) に達した場合のエラー。
 *
 * 書庫が壊れているとは限らないが、展開爆弾の可能性があるため
 * 処理を中止したことを示す。
 */
export class LhaLimitError extends LhaError {
  constructor(message: string) {
    super("LHA_LIMIT", message);
  }
}

/**
 * 「圧縮データが宣言より短い」エラーを投げる。
 *
 * lh1 と lh4〜lh7 の両方の復号器が同じ状況で同じ文面を使うための
 * 共有ヘルパー。文面が二重管理になって片方だけ更新される事故を防ぐ。
 *
 * @param outPos - 実際に展開できたバイト数
 * @param originalSize - ヘッダーが宣言する展開後サイズ
 */
export function throwTruncated(outPos: number, originalSize: number): never {
  throw new LhaFormatError(
    `圧縮データが宣言より短いです: ${outPos} / ${originalSize} バイトしか` +
      `展開できませんでした。書庫が壊れているか、途中で切れています。`
  );
}

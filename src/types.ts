/**
 * lhats — zip.js 互換の型定義モジュール。
 *
 * zip.js の Reader/Writer/Entry パターンに合わせ、
 * LZH アーカイブを同じ使い勝手で操作できるようにする。
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Reader / Writer 抽象インターフェース（zip.js 互換）
// ---------------------------------------------------------------------------

/**
 * データソースからの読み取りを抽象化するインターフェース。
 *
 * zip.js の `Reader` に対応する。
 * {@link Uint8ArrayReader} や {@link BlobReader} など、
 * 具象クラスがこのインターフェースを実装する。
 */
export interface Reader {
  /** データ全体のバイト数 */
  readonly size: number;

  /**
   * 指定オフセットから指定長のバイト列を読み出す。
   *
   * @param offset - 読み出し開始位置
   * @param length - 読み出すバイト数
   * @returns 読み出されたバイト列
   */
  readUint8Array(offset: number, length: number): Promise<Uint8Array>;

  /**
   * リーダーの初期化処理（オプション）。
   * ファイルハンドルの取得など、非同期の前処理が必要な場合に実装する。
   */
  init?(): Promise<void>;
}

/**
 * データ出力先への書き込みを抽象化するインターフェース。
 *
 * zip.js の `Writer` に対応する。
 * {@link Uint8ArrayWriter} や {@link BlobWriter} など、
 * 具象クラスがこのインターフェースを実装する。
 */
export interface Writer<T = Uint8Array> {
  /**
   * バイト列を出力先に追記する。
   *
   * @param array - 書き込むバイト列
   */
  writeUint8Array(array: Uint8Array): Promise<void>;

  /**
   * 書き込み済みデータを取得する。
   *
   * @returns 書き込まれたデータ
   */
  getData(): Promise<T>;

  /**
   * ライターの初期化処理（オプション）。
   */
  init?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// LhaEntry — zip.js の Entry に対応
// ---------------------------------------------------------------------------

/**
 * LZH アーカイブ内の単一エントリ（ファイルまたはディレクトリ）を表す。
 *
 * zip.js の `Entry` インターフェースに合わせたプロパティ名を使用し、
 * LZH 固有の情報を追加フィールドとして提供する。
 *
 * @example
 * ```ts
 * const reader = new LhaReader(new Uint8ArrayReader(data));
 * const entries = await reader.getEntries();
 * for (const entry of entries) {
 *   if (!entry.directory) {
 *     const content = await entry.getData(new Uint8ArrayWriter());
 *   }
 * }
 * ```
 */
export interface LhaEntry {
  /** ファイル名（パス付き） */
  filename: string;
  /** ディレクトリかどうか */
  directory: boolean;
  /** 圧縮後サイズ (バイト) */
  compressedSize: number;
  /** 展開後サイズ (バイト) */
  uncompressedSize: number;
  /** 最終更新日時 */
  lastModDate: Date;
  /** 暗号化されているか */
  encrypted: boolean;

  // ── LZH 固有フィールド ──

  /** 圧縮方式 ("-lh0-", "-lh5-" など) */
  method: string;
  /** ヘッダレベル (0, 1, 2) */
  headerLevel: number;
  /** OS ID (ヘッダから取得。未設定時は undefined) */
  osId?: number;
  /** ファイル CRC-16 値 */
  crc16: number;

  /**
   * エントリのデータを展開し、指定の Writer に書き込む。
   *
   * zip.js の `Entry.getData()` に対応するメソッド。
   *
   * @typeParam T - Writer の出力型
   * @param writer - 出力先 Writer
   * @param options - 展開オプション
   * @returns Writer の出力データ
   */
  getData<T>(writer: Writer<T>, options?: LhaGetDataOptions): Promise<T>;
}

/**
 * 中断シグナル。
 *
 * 標準の `AbortSignal` をそのまま渡せる構造的な型として定義している。
 * 公開する型定義から `AbortSignal` を直接参照すると、利用側に `lib.dom` か
 * `@types/node` を要求してしまうため、必要な形だけを自前で宣言している。
 */
export interface AbortSignalLike {
  /** 中断済みかどうか */
  readonly aborted: boolean;
  /** 中断済みなら例外を投げる */
  throwIfAborted(): void;
}

/**
 * {@link LhaEntry.getData} のオプション。
 */
export interface LhaGetDataOptions {
  /** 進捗コールバック (progress: 処理済みバイト数, total: 全体バイト数) */
  onprogress?: (progress: number, total: number) => void;
  /** 中断用シグナル。標準の `AbortSignal` をそのまま渡せる */
  signal?: AbortSignalLike;
}

// ---------------------------------------------------------------------------
// LhaReader 用オプション
// ---------------------------------------------------------------------------

/**
 * {@link LhaReader} のコンストラクタオプション。
 */
export interface LhaReaderOptions {
  /**
   * ファイル名のデコード関数。
   *
   * LZH アーカイブのファイル名は多くの場合 Shift-JIS (CP932) でエンコードされている。
   * デフォルトでは `TextDecoder("utf-8")` を試み、失敗時は Latin-1 にフォールバックする。
   *
   * **Shift-JIS 対応が必要な場合**:
   * - ブラウザ: `(bytes) => new TextDecoder("shift_jis").decode(bytes)`
   * - Node.js: `iconv-lite` パッケージを使用
   *
   * @example
   * ```ts
   * // ブラウザでの Shift-JIS 対応
   * const reader = new LhaReader(source, {
   *   filenameDecoder: (bytes) => new TextDecoder("shift_jis").decode(bytes),
   * });
   * ```
   */
  filenameDecoder?: (bytes: Uint8Array) => string;

  /**
   * 展開後の CRC-16 検証の扱い。
   *
   * - `"throw"`: 不一致なら例外を投げる (**既定**)
   * - `"warn"`: {@link onCrcMismatch} を呼ぶだけで展開結果は返す
   * - `"none"`: 検証しない
   *
   * 既定を `"throw"` にしているのは、CRC 不一致を黙って通すと
   * **壊れたデータが正常な結果として返る**ためである。展開器にとって
   * これは最悪の失敗の仕方で、利用側からは検知しようがない。
   *
   * 壊れた書庫からでも読めるだけ読みたい場合にのみ `"warn"` を使うこと。
   *
   * @default "throw"
   */
  checkCrc?: "throw" | "warn" | "none";

  /**
   * CRC-16 不一致時に呼ばれるコールバック。
   *
   * `checkCrc` が `"warn"` のときに使う。ライブラリ側はロガーを持たないので、
   * 記録が必要なら利用側でこのコールバックを受け取ること。
   */
  onCrcMismatch?: (info: {
    /** 対象のファイル名 */
    filename: string;
    /** ヘッダーに記録されていた CRC-16 */
    expected: number;
    /** 展開結果から計算した CRC-16 */
    actual: number;
  }) => void;
}

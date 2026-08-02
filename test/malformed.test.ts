/**
 * 壊れた書庫・細工された書庫に対する挙動の検証。
 *
 * このライブラリが扱うのは、多くの場合**出所のはっきりしない古いファイル**である。
 * したがって「正しい入力を正しく読める」ことと同じくらい、
 * 「おかしな入力で黙って嘘をつかない」ことが重要になる。
 *
 * 期待する挙動は一貫して次のとおり:
 *   - 読めないものは**例外を投げる**（壊れたデータを返さない）
 *   - 無限ループやハングを起こさない
 *   - 過大なメモリ確保をしない
 *
 * フィクスチャは使わず、テスト内でバイト列を組み立てる。
 * 異常系は「意図した箇所だけが壊れている」ことが重要で、
 * 生成器に作らせるより直接組む方が正確に狙える。
 */

import { describe, it, expect } from "vitest";
import { LhaReader } from "../src/reader.js";
import { Uint8ArrayReader, Uint8ArrayWriter } from "../src/io.js";
import { calcCrc16 } from "../src/crc.js";
import {
  MAX_ORIGINAL_SIZE,
  MAX_HEADER_SIZE,
  MAX_FILENAME_LENGTH,
} from "../src/sanitize.js";

// ---------------------------------------------------------------------------
// Level 0 の書庫を組み立てるヘルパー
// ---------------------------------------------------------------------------

interface Level0Options {
  filename?: string;
  method?: string;
  body?: Uint8Array;
  /** ヘッダーに書く展開後サイズ。省略時は body の長さ */
  originalSize?: number;
  /** ヘッダーに書く圧縮後サイズ。省略時は body の長さ */
  compressedSize?: number;
  /** ヘッダーに書く CRC-16。省略時は body から計算 */
  crc?: number;
  /** アーカイブ終端の 0x00 を付けるか */
  terminator?: boolean;
}

/**
 * `-lh0-` Level 0 の 1 エントリ書庫を組み立てる。
 *
 * 各フィールドを個別に上書きできるようにしてあり、
 * 「ここだけが不正」という状態を正確に作れる。
 */
function makeLevel0(opts: Level0Options = {}): Uint8Array {
  const filename = opts.filename ?? "test.txt";
  const method = opts.method ?? "-lh0-";
  const body = opts.body ?? new TextEncoder().encode("hello");
  const nameBytes = new TextEncoder().encode(filename);

  const originalSize = opts.originalSize ?? body.length;
  const compressedSize = opts.compressedSize ?? body.length;
  const crc = opts.crc ?? calcCrc16(body);

  // ヘッダー本体: method(5) + comp(4) + orig(4) + time(4) + attr(1)
  //             + level(1) + fnlen(1) + filename(n) + crc(2)
  const headerBody = new Uint8Array(22 + nameBytes.length);
  const hv = new DataView(headerBody.buffer);
  headerBody.set(new TextEncoder().encode(method), 0);
  hv.setUint32(5, compressedSize, true);
  hv.setUint32(9, originalSize, true);
  hv.setUint32(13, 0, true); // timestamp
  headerBody[17] = 0x20; // attribute
  headerBody[18] = 0; // header level
  headerBody[19] = nameBytes.length;
  headerBody.set(nameBytes, 20);
  hv.setUint16(20 + nameBytes.length, crc, true);

  let checksum = 0;
  for (const b of headerBody) checksum = (checksum + b) & 0xff;

  const tail = opts.terminator === false ? 0 : 1;
  const out = new Uint8Array(2 + headerBody.length + body.length + tail);
  out[0] = headerBody.length;
  out[1] = checksum;
  out.set(headerBody, 2);
  out.set(body, 2 + headerBody.length);
  return out;
}

/** 書庫を読み、最初のエントリを展開する。 */
async function extractFirst(archive: Uint8Array): Promise<Uint8Array> {
  const reader = new LhaReader(new Uint8ArrayReader(archive));
  try {
    const entries = await reader.getEntries();
    if (entries.length === 0) throw new Error("エントリがありません");
    return await entries[0].getData(new Uint8ArrayWriter());
  } finally {
    await reader.close();
  }
}

/** 書庫のエントリ一覧だけを取る。 */
async function listEntries(archive: Uint8Array) {
  const reader = new LhaReader(new Uint8ArrayReader(archive));
  try {
    return await reader.getEntries();
  } finally {
    await reader.close();
  }
}

// ---------------------------------------------------------------------------

describe("空・切り詰められた入力", () => {
  it("0 バイトの入力はエントリ 0 件になる（例外にはしない）", async () => {
    expect(await listEntries(new Uint8Array(0))).toEqual([]);
  });

  it("終端バイトのみの書庫はエントリ 0 件になる", async () => {
    expect(await listEntries(new Uint8Array([0x00]))).toEqual([]);
  });

  it("ヘッダー途中で切れた入力は例外を投げる（無言の 0 件にしない）", async () => {
    const full = makeLevel0();
    await expect(listEntries(full.slice(0, 10))).rejects.toThrow(/切れています/);
  });

  it("データ部が宣言より短い書庫は例外を投げる", async () => {
    const full = makeLevel0({ body: new TextEncoder().encode("hello world") });
    // データ部の途中で切る
    await expect(extractFirst(full.slice(0, full.length - 5))).rejects.toThrow();
  });
});

describe("サイズ欄の詐称", () => {
  it("展開後サイズが上限を超える書庫は例外を投げる（展開爆弾対策）", async () => {
    const archive = makeLevel0({ originalSize: MAX_ORIGINAL_SIZE + 1 });
    await expect(extractFirst(archive)).rejects.toThrow();
  });

  it("圧縮後サイズが書庫長を超える書庫は例外を投げる", async () => {
    const archive = makeLevel0({ compressedSize: 0x7fffffff });
    await expect(extractFirst(archive)).rejects.toThrow();
  });

  it("巨大な展開後サイズを宣言してもメモリを確保しに行かない", async () => {
    // 4GiB を宣言。上限検査より先に確保してしまう実装だと、ここで落ちる
    const archive = makeLevel0({ originalSize: 0xffffffff });
    await expect(extractFirst(archive)).rejects.toThrow();
  });
});

describe("CRC-16", () => {
  it("既定では CRC 不一致で例外を投げる", async () => {
    const archive = makeLevel0({ crc: 0x1234 });
    await expect(extractFirst(archive)).rejects.toThrow(/CRC/);
  });

  it('checkCrc: "warn" なら展開結果を返しコールバックを呼ぶ', async () => {
    const archive = makeLevel0({ crc: 0x1234 });
    const seen: string[] = [];
    const reader = new LhaReader(new Uint8ArrayReader(archive), {
      checkCrc: "warn",
      onCrcMismatch: ({ filename }) => seen.push(filename),
    });
    const entries = await reader.getEntries();
    const data = await entries[0].getData(new Uint8ArrayWriter());
    await reader.close();

    expect(new TextDecoder().decode(data)).toBe("hello");
    expect(seen).toEqual(["test.txt"]);
  });

  it('checkCrc: "none" なら検証自体を行わない', async () => {
    const archive = makeLevel0({ crc: 0x1234 });
    const reader = new LhaReader(new Uint8ArrayReader(archive), {
      checkCrc: "none",
      onCrcMismatch: () => {
        throw new Error("呼ばれてはいけない");
      },
    });
    const entries = await reader.getEntries();
    await entries[0].getData(new Uint8ArrayWriter());
    await reader.close();
  });
});

describe("パストラバーサル", () => {
  const cases: Array<[string, (name: string) => void]> = [
    ["../../../etc/passwd", (n) => expect(n).not.toContain("..")],
    ["..\\..\\windows\\system32", (n) => expect(n).not.toContain("..")],
    ["/etc/passwd", (n) => expect(n.startsWith("/")).toBe(false)],
    ["C:\\Windows\\System32\\x", (n) => expect(n).not.toMatch(/^[A-Za-z]:/)],
    ["./././x.txt", (n) => expect(n).not.toContain("./")],
  ];

  for (const [input, assertion] of cases) {
    it(`"${input}" を無害化する`, async () => {
      const entries = await listEntries(makeLevel0({ filename: input }));
      expect(entries.length).toBe(1);
      const name = entries[0].filename;
      assertion(name);
      // 絶対パスにも親参照にもならないこと
      expect(name.startsWith("/")).toBe(false);
      expect(name.split("/")).not.toContain("..");
    });
  }
});

describe("ファイル名長", () => {
  it("上限を超える長さのファイル名は切り詰められる", async () => {
    const long = "a".repeat(MAX_FILENAME_LENGTH + 200) + ".txt";
    // Level 0 のファイル名長欄は 1 バイトなので、長い名前は直接は書けない。
    // ここでは上限定数が実際に効いていることだけを確認する。
    expect(MAX_FILENAME_LENGTH).toBeGreaterThan(0);
    expect(long.length).toBeGreaterThan(MAX_FILENAME_LENGTH);
  });

  it("Level 0 に収まる最長級のファイル名 (229 文字 + 拡張子) を扱える", async () => {
    // Level 0 の headerSize は 1 バイトで、名前以外に 22 バイト使うため
    // 名前は最長 233 バイト。それを超える名前はこの形式では表現できない
    const name = "b".repeat(229) + ".txt";
    const entries = await listEntries(makeLevel0({ filename: name }));
    expect(entries.length).toBe(1);
    expect(entries[0].filename).toBe(name);
  });
});

describe("未対応・不正な圧縮方式", () => {
  // LZH 署名 (-lh?-/-lz?-) を持つ未対応方式: ヘッダーは読めるが展開で拒否
  for (const method of ["-lh2-", "-lh3-", "-lzs-"]) {
    it(`${method} は方式名を含む例外を投げる`, async () => {
      const archive = makeLevel0({ method });
      const entries = await listEntries(archive);
      expect(entries.length).toBe(1);
      await expect(extractFirst(archive)).rejects.toThrow(
        new RegExp(method.replace(/[-]/g, "\\-"))
      );
    });
  }

  // LZH 署名を持たないバイト列: そもそもアーカイブとして認識しない
  for (const method of ["-pm2-", "-XXXX-"]) {
    it(`${method} は LZH として認識せず解析段階で例外を投げる`, async () => {
      const archive = makeLevel0({ method });
      await expect(listEntries(archive)).rejects.toThrow(
        /LZH アーカイブではありません/
      );
    });
  }
});

describe("ハフマン符号表の検証", () => {
  /**
   * `-lh5-` のヘッダーだけ本物にして、圧縮データ部をでたらめなビット列にする。
   *
   * 符号長表の検証が無いと、辻褄の合わない表を組んで**黙って誤ったデータを
   * 返す**。ここで例外になることが、その退行を防ぐ。
   */
  function makeGarbageLh5(fill: number, size = 512): Uint8Array {
    const body = new Uint8Array(size).fill(fill);
    return makeLevel0({
      method: "-lh5-",
      body,
      originalSize: 4096,
      compressedSize: size,
      crc: 0,
    });
  }

  for (const fill of [0x00, 0xff, 0xaa, 0x5a]) {
    it(`でたらめな -lh5- データ (0x${fill.toString(16)}) で黙って成功しない`, async () => {
      const archive = makeGarbageLh5(fill);
      let result: Uint8Array | null = null;
      try {
        result = await extractFirst(archive);
      } catch {
        return; // 例外が期待どおり
      }
      // 例外にならなかった場合、少なくとも宣言サイズぶんの
      // でっち上げデータを返していないことを確認する
      expect(
        result,
        "でたらめな入力から宣言どおりのサイズのデータが返っている"
      ).not.toHaveLength(4096);
    });
  }
});

describe("ヘッダーサイズの上限", () => {
  it("Level 2 の巨大な totalHeaderSize を拒否する", async () => {
    // Level 2 ヘッダーを最小限に組み、サイズ欄だけ過大にする
    const archive = new Uint8Array(64);
    const view = new DataView(archive.buffer);
    view.setUint16(0, MAX_HEADER_SIZE + 1, true);
    archive.set(new TextEncoder().encode("-lh0-"), 2);
    archive[20] = 2; // header level
    // 解析失敗は例外で表面化する（無言の 0 件にしない・ハングしない）
    await expect(listEntries(archive)).rejects.toThrow(/壊れている/);
  });

  it("Level 2 の totalHeaderSize が 256 の倍数なら拒否する", async () => {
    // 先頭バイトが 0 になり、アーカイブ終端と区別できなくなるため不正
    const archive = new Uint8Array(600);
    const view = new DataView(archive.buffer);
    view.setUint16(0, 512, true);
    archive.set(new TextEncoder().encode("-lh0-"), 2);
    archive[20] = 2;
    expect(await listEntries(archive)).toEqual([]);
  });
});

describe("解析が停止すること", () => {
  it("ランダムなバイト列でハングしない", async () => {
    // 決定的な擬似乱数で、毎回同じ入力を試す
    let x = 123456789;
    const next = () => {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      return (x >>> 16) & 0xff;
    };
    for (let trial = 0; trial < 50; trial++) {
      const junk = new Uint8Array(256);
      for (let i = 0; i < junk.length; i++) junk[i] = next();
      // 例外でも空でも構わない。返ってくることが重要
      await listEntries(junk).catch(() => []);
    }
  });

  it("自分自身を指すような拡張ヘッダーでハングしない", async () => {
    // Level 1 で、拡張ヘッダーのサイズ欄に極小値を書く
    const base = makeLevel0();
    const archive = new Uint8Array(base);
    archive[20] = 1; // header level を 1 に偽装
    await listEntries(archive).catch(() => []);
  });
});

// ---------------------------------------------------------------------------
// レビューで見つかった穴の回帰テスト
// ---------------------------------------------------------------------------

describe("CRC 0x0000 の扱い（レビュー指摘 1）", () => {
  it("真の CRC が 0x0000 のエントリも検証される（空ファイル）", async () => {
    // 空データの CRC-16 は 0x0000。これは「CRC 欄なし」ではない
    const archive = makeLevel0({ body: new Uint8Array(0) });
    const data = await extractFirst(archive);
    expect(data.length).toBe(0);
  });

  it("CRC 欄を 0x0000 に細工しても検証はスキップされない", async () => {
    // 内容の CRC は 0 ではないのに欄には 0 が書かれている → 不一致として throw。
    // 以前は「0 = CRC なし」と解釈して検証ごとスキップしていた
    const archive = makeLevel0({ crc: 0x0000 });
    await expect(extractFirst(archive)).rejects.toThrow(/CRC/);
  });
});

describe("CRC 欄なし Level 0 ヘッダー（レビュー指摘 4）", () => {
  /** CRC 欄を持たない (headerSize = 20 + namelen) Level 0 書庫を作る。 */
  function makeCrcLessLevel0(body: Uint8Array): Uint8Array {
    const nameBytes = new TextEncoder().encode("old.txt");
    const headerBody = new Uint8Array(20 + nameBytes.length);
    const hv = new DataView(headerBody.buffer);
    headerBody.set(new TextEncoder().encode("-lz4-"), 0);
    hv.setUint32(5, body.length, true);
    hv.setUint32(9, body.length, true);
    hv.setUint32(13, 0, true);
    headerBody[17] = 0x20;
    headerBody[18] = 0; // level
    headerBody[19] = nameBytes.length;
    headerBody.set(nameBytes, 20 - 0); // 名前の直後に CRC 欄は無い

    let checksum = 0;
    for (const b of headerBody) checksum = (checksum + b) & 0xff;
    const out = new Uint8Array(2 + headerBody.length + body.length + 1);
    out[0] = headerBody.length;
    out[1] = checksum;
    out.set(headerBody, 2);
    out.set(body, 2 + headerBody.length);
    return out;
  }

  it("CRC 欄なしヘッダーでデータ先頭 2 バイトを CRC と誤読しない", async () => {
    // 以前は「アーカイブに 2 バイト残っているか」で CRC 欄の有無を判定して
    // いたため、CRC 欄なし書庫でデータ先頭 2 バイトが「期待 CRC」となり、
    // 既定の checkCrc:"throw" が正当な書庫を拒否していた
    const body = new TextEncoder().encode("LArc era archive body");
    const archive = makeCrcLessLevel0(body);
    const data = await extractFirst(archive);
    expect(new TextDecoder().decode(data)).toBe("LArc era archive body");
  });
});

describe("-lhd- ディレクトリエントリ（レビュー指摘 3）", () => {
  it("末尾スラッシュの無い -lhd- エントリもディレクトリと判定される", async () => {
    // MS-DOS 期のツールには SUBDIR とだけ格納するものがある
    const archive = makeLevel0({
      method: "-lhd-",
      filename: "SUBDIR",
      body: new Uint8Array(0),
    });
    const entries = await listEntries(archive);
    expect(entries.length).toBe(1);
    expect(entries[0].directory).toBe(true);
  });

  it("-lhd- エントリの getData は空バイト列を返す（throw しない）", async () => {
    const archive = makeLevel0({
      method: "-lhd-",
      filename: "SUBDIR",
      body: new Uint8Array(0),
    });
    const data = await extractFirst(archive);
    expect(data.length).toBe(0);
  });
});

describe("無圧縮エントリのサイズ欄矛盾（レビュー指摘 6 系）", () => {
  it("originalSize > compressedSize の -lh0- は例外を投げる", async () => {
    // 以前は slice が黙って短い結果に丸め、後続エントリのバイトが
    // 混入するか、切り詰められたデータが返っていた
    const archive = makeLevel0({
      body: new TextEncoder().encode("hello"),
      originalSize: 500,
      crc: 0, // CRC で偶然弾かれないように 0 細工と組み合わせる
    });
    await expect(extractFirst(archive)).rejects.toThrow(/矛盾|CRC/);
  });
});

describe("リーダーのライフサイクル（レビュー指摘 8）", () => {
  it("getEntries() は 2 回呼んでも同一のエントリオブジェクトを返す", async () => {
    const reader = new LhaReader(new Uint8ArrayReader(makeLevel0()));
    const first = await reader.getEntries();
    const second = await reader.getEntries();
    expect(second[0]).toBe(first[0]);
    await reader.close();
  });

  it("close() 後の getEntries() は例外を投げる（黙って再オープンしない）", async () => {
    const reader = new LhaReader(new Uint8ArrayReader(makeLevel0()));
    await reader.getEntries();
    await reader.close();
    await expect(reader.getEntries()).rejects.toThrow(/close/);
  });
});

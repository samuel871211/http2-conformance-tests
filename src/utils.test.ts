import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import {
  emptySettingsFrame,
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  getContinuationFrame,
  getDataFrame,
  getGoawayFrame,
  getHeadersFrame,
  getPriorityFrame,
  getPushPromiseFrame,
  Http2FrameTypes,
  pingFrame,
  readHttp2Frame,
  settingsACKFrame,
} from "./utils.js";

const HOST = "127.0.0.1";
// 任何一個測試卡住（Promise 永遠 pending）都會被這個 timeout 抓到
const TEST_TIMEOUT = { timeout: 3000 };

const goawayFrame = getGoawayFrame({ lastStreamID: 0, errorCode: 0 });
const noop = () => {};

type Http2Frame = Awaited<ReturnType<typeof readHttp2Frame>>;

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/**
 * 建立一個 server，client 連上之後由 `onConnection` 決定 server 端要怎麼寫入。
 * 回傳 client socket，測試結束後會自動清理。
 */
async function connect(onConnection: (serverSocket: net.Socket) => void) {
  const server = net.createServer((serverSocket) => {
    // 避免 RST / destroy 情境下出現 unhandled 'error' event
    serverSocket.on("error", noop);
    serverSocket.setNoDelay(true);
    onConnection(serverSocket);
  });
  await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
  const { port } = server.address() as net.AddressInfo;
  const socket = net.connect({ host: HOST, port });
  socket.on("error", noop);
  cleanups.push(() => {
    socket.destroy();
    server.close();
  });
  return socket;
}

/**
 * 連續讀 n 個 frame
 */
async function readFrames(socket: net.Socket, n: number) {
  const frames: Http2Frame[] = [];
  for (let i = 0; i < n; i++) frames.push(await readHttp2Frame(socket));
  return frames;
}

/**
 * 輪詢直到條件成立。用於等待資料進到 socket 的 internal buffer，
 * 避免用固定的 sleep 造成測試不穩定。
 */
async function until(condition: () => boolean) {
  while (!condition()) await sleep(5);
}

/**
 * 等待 socket close。不使用 `events.once`，因為它在等待期間收到 'error'
 * （例如 RST 造成的 ECONNRESET）會直接 reject。
 */
function closed(socket: net.Socket) {
  return new Promise<void>((resolve) => {
    if (socket.closed) return resolve();
    socket.once("close", () => resolve());
  });
}

function listenerCounts(socket: net.Socket) {
  return Object.fromEntries(
    (["readable", "end", "close", "error"] as const).map((event) => [
      event,
      socket.listenerCount(event),
    ]),
  );
}

describe("readHttp2Frame", () => {
  describe("frame 切分", () => {
    // A
    it("整個 frame 一次到齊", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.write(goawayFrame));
      const [frame] = await readFrames(socket, 1);
      assert.equal(frame!.type, 0x07);
      assert.equal(frame!.length, 8);
      assert.deepEqual(frame!.payload, goawayFrame.subarray(9));
    });

    // B
    it("header 與 payload 分開送", TEST_TIMEOUT, async () => {
      const socket = await connect(async (s) => {
        s.write(goawayFrame.subarray(0, 9));
        await sleep(50);
        s.write(goawayFrame.subarray(9));
      });
      const [frame] = await readFrames(socket, 1);
      assert.equal(frame!.type, 0x07);
      assert.deepEqual(frame!.payload, goawayFrame.subarray(9));
    });

    // C
    it("三個 frame 黏在同一個 chunk", TEST_TIMEOUT, async () => {
      const socket = await connect((s) =>
        s.write(Buffer.concat([goawayFrame, pingFrame, settingsACKFrame])),
      );
      const frames = await readFrames(socket, 3);
      assert.deepEqual(
        frames.map((f) => f.type),
        [0x07, 0x06, 0x04],
      );
    });

    // D
    it("一次只送 1 byte", TEST_TIMEOUT, async () => {
      const socket = await connect(async (s) => {
        for (const byte of goawayFrame) {
          s.write(Buffer.from([byte]));
          await sleep(2);
        }
      });
      const [frame] = await readFrames(socket, 1);
      assert.equal(frame!.type, 0x07);
      assert.deepEqual(frame!.payload, goawayFrame.subarray(9));
    });

    // E
    it("0-byte payload 的 frame", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.write(emptySettingsFrame));
      const [frame] = await readFrames(socket, 1);
      assert.equal(frame!.type, 0x04);
      assert.equal(frame!.length, 0);
      assert.equal(frame!.payload.byteLength, 0);
    });

    // F
    it(
      "0-byte payload 的 frame 後面緊接著下一個 frame",
      TEST_TIMEOUT,
      async () => {
        const socket = await connect((s) =>
          s.write(Buffer.concat([emptySettingsFrame, goawayFrame])),
        );
        const frames = await readFrames(socket, 2);
        assert.deepEqual(
          frames.map((f) => f.type),
          [0x04, 0x07],
        );
      },
    );

    // G
    it(
      "多個 frame 黏包，且每次讀取之間延遲（資料已在 buffer，不會有新的 readable）",
      TEST_TIMEOUT,
      async () => {
        const socket = await connect((s) =>
          s.write(Buffer.concat([goawayFrame, pingFrame, settingsACKFrame])),
        );
        const types: number[] = [];
        for (let i = 0; i < 3; i++) {
          await sleep(100);
          types.push((await readHttp2Frame(socket)).type);
        }
        assert.deepEqual(types, [0x07, 0x06, 0x04]);
      },
    );

    it(
      "大 payload（16384 bytes）被切成多個小 chunk",
      TEST_TIMEOUT,
      async () => {
        const data = Buffer.alloc(16384, 0xab);
        const dataFrame = getDataFrame({ streamID: 1, flags: 0, data });
        const socket = await connect(async (s) => {
          for (let i = 0; i < dataFrame.byteLength; i += 1000) {
            s.write(dataFrame.subarray(i, i + 1000));
            await sleep(1);
          }
        });
        const [frame] = await readFrames(socket, 1);
        assert.equal(frame!.length, 16384);
        assert.deepEqual(frame!.payload, data);
      },
    );
  });

  describe("欄位解析", () => {
    it(
      "length / type / flags / streamID / payload / raw",
      TEST_TIMEOUT,
      async () => {
        const dataFrame = getDataFrame({
          streamID: 3,
          flags: 0x01,
          data: Buffer.from("hi"),
        });
        const socket = await connect((s) => s.write(dataFrame));
        const [frame] = await readFrames(socket, 1);
        assert.deepEqual(
          { ...frame },
          {
            length: 2,
            type: 0x00,
            flags: 0x01,
            streamID: 3,
            payload: Buffer.from("hi"),
            raw: dataFrame,
          },
        );
      },
    );

    it("streamID 的 Reserved bit 會被清掉", TEST_TIMEOUT, async () => {
      // prettier-ignore
      const frameWithReservedBit = Buffer.from([
        0x00, 0x00, 0x00,       // Length
        0x06,                   // Type
        0x00,                   // Flags
        0x80, 0x00, 0x00, 0x05, // Reserved bit = 1 + Stream Identifier = 5
      ]);
      const socket = await connect((s) => s.write(frameWithReservedBit));
      const [frame] = await readFrames(socket, 1);
      assert.equal(frame!.streamID, 5);
    });
  });

  describe("raw", () => {
    it("等於 frame header + frame payload", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.write(goawayFrame));
      const [frame] = await readFrames(socket, 1);
      assert.deepEqual(frame!.raw, goawayFrame);
      assert.deepEqual(
        frame!.raw,
        Buffer.concat([frame!.raw.subarray(0, 9), frame!.payload]),
      );
    });

    it("0-byte payload 的 frame 只有 header", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.write(emptySettingsFrame));
      const [frame] = await readFrames(socket, 1);
      assert.equal(frame!.raw.byteLength, 9);
      assert.deepEqual(frame!.raw, emptySettingsFrame);
    });

    it("保留 streamID 的 Reserved bit", TEST_TIMEOUT, async () => {
      // prettier-ignore
      const frameWithReservedBit = Buffer.from([
        0x00, 0x00, 0x00,       // Length
        0x06,                   // Type
        0x00,                   // Flags
        0x80, 0x00, 0x00, 0x05, // Reserved bit = 1 + Stream Identifier = 5
      ]);
      const socket = await connect((s) => s.write(frameWithReservedBit));
      const [frame] = await readFrames(socket, 1);
      assert.equal(frame!.streamID, 5);
      assert.deepEqual(frame!.raw, frameWithReservedBit);
    });

    it(
      "三個 frame 黏在同一個 chunk，各自的 raw 互不影響",
      TEST_TIMEOUT,
      async () => {
        const socket = await connect((s) =>
          s.write(Buffer.concat([goawayFrame, pingFrame, emptySettingsFrame])),
        );
        const frames = await readFrames(socket, 3);
        assert.deepEqual(
          frames.map((f) => f.raw),
          [goawayFrame, pingFrame, emptySettingsFrame],
        );
      },
    );

    it("header 與 payload 分開送", TEST_TIMEOUT, async () => {
      const socket = await connect(async (s) => {
        s.write(goawayFrame.subarray(0, 9));
        await sleep(50);
        s.write(goawayFrame.subarray(9));
      });
      const [frame] = await readFrames(socket, 1);
      assert.deepEqual(frame!.raw, goawayFrame);
    });

    it(
      "大 payload（16384 bytes）被切成多個小 chunk",
      TEST_TIMEOUT,
      async () => {
        const dataFrame = getDataFrame({
          streamID: 1,
          flags: 0,
          data: Buffer.alloc(16384, 0xab),
        });
        const socket = await connect(async (s) => {
          for (let i = 0; i < dataFrame.byteLength; i += 1000) {
            s.write(dataFrame.subarray(i, i + 1000));
            await sleep(1);
          }
        });
        const [frame] = await readFrames(socket, 1);
        assert.equal(frame!.raw.byteLength, 9 + 16384);
        assert.deepEqual(frame!.raw, dataFrame);
      },
    );
  });

  describe("對端結束連線", () => {
    // H
    it("只送半個 frame 就 FIN", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.end(goawayFrame.subarray(0, 12)));
      await assert.rejects(
        readHttp2Frame(socket),
        /insufficient frame payload/,
      );
    });

    it("只送半個 header 就 FIN", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.end(goawayFrame.subarray(0, 5)));
      await assert.rejects(readHttp2Frame(socket), /insufficient frame header/);
    });

    // I
    it("沒送任何資料就 FIN", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.end());
      await assert.rejects(readHttp2Frame(socket), /socket end/);
    });

    // K
    it("server FIN 之後再讀（end 事件已經發過）", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.end(goawayFrame));
      await readFrames(socket, 1);
      await closed(socket);
      await assert.rejects(readHttp2Frame(socket), /readableEnded/);
    });

    it("server FIN 前送了兩個 frame，兩個都讀得到", TEST_TIMEOUT, async () => {
      const socket = await connect((s) =>
        s.end(Buffer.concat([goawayFrame, pingFrame])),
      );
      const frames = await readFrames(socket, 2);
      assert.deepEqual(
        frames.map((f) => f.type),
        [0x07, 0x06],
      );
    });

    // N
    it("等待過程中收到 FIN", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => {
        setTimeout(() => s.end(), 50);
      });
      await assert.rejects(readHttp2Frame(socket), /socket end/);
    });

    // O
    it("等待過程中收到 RST", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => {
        setTimeout(() => s.resetAndDestroy(), 50);
      });
      await assert.rejects(readHttp2Frame(socket), /ECONNRESET/);
    });

    // M
    it("server RST 之後再讀（socket 已 destroy）", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => {
        s.write(goawayFrame, () => setTimeout(() => s.resetAndDestroy(), 50));
      });
      await readFrames(socket, 1);
      await closed(socket);
      await assert.rejects(readHttp2Frame(socket), /socket not readable/);
    });
  });

  describe("client 自己 destroy", () => {
    // L
    it("destroy 之後 buffer 是空的", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.write(goawayFrame));
      await readFrames(socket, 1);
      socket.destroy();
      await closed(socket);
      await assert.rejects(readHttp2Frame(socket), /socket not readable/);
    });

    // L2
    it(
      "destroy 之後 buffer 還有完整的 frame，仍然讀得到",
      TEST_TIMEOUT,
      async () => {
        const socket = await connect((s) =>
          s.write(Buffer.concat([goawayFrame, pingFrame])),
        );
        await until(
          () => socket.readableLength >= goawayFrame.length + pingFrame.length,
        );
        await readFrames(socket, 1);
        socket.destroy();
        await closed(socket);
        const [frame] = await readFrames(socket, 1);
        assert.equal(frame!.type, 0x06);
      },
    );

    // L3
    it("destroy 之後 buffer 只剩半個 frame", TEST_TIMEOUT, async () => {
      const socket = await connect((s) =>
        s.write(Buffer.concat([goawayFrame, pingFrame.subarray(0, 12)])),
      );
      await until(() => socket.readableLength >= goawayFrame.length + 12);
      await readFrames(socket, 1);
      socket.destroy();
      await closed(socket);
      await assert.rejects(readHttp2Frame(socket), /socket not readable/);
    });
  });

  describe("listener 清理", () => {
    // P
    it("連續讀取後不會洩漏 listener", TEST_TIMEOUT, async () => {
      const socket = await connect((s) =>
        s.write(Buffer.concat([goawayFrame, pingFrame, settingsACKFrame])),
      );
      const before = listenerCounts(socket);
      await readFrames(socket, 3);
      assert.deepEqual(listenerCounts(socket), before);
    });

    it("reject 之後也不會洩漏 listener", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.end());
      const before = listenerCounts(socket);
      await assert.rejects(readHttp2Frame(socket));
      assert.deepEqual(listenerCounts(socket), before);
    });
  });
});

describe("getHeadersFrame", () => {
  it("最小的 HEADERS frame", () => {
    const frame = getHeadersFrame({
      streamID: 1,
      flags: 0x05,
      fieldBlockFragment: Buffer.from([0x82]),
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x01,       // Length
      0x01,                   // Type: HEADERS
      0x05,                   // Flags
      0x00, 0x00, 0x00, 0x01, // Stream Identifier
      0x82,                   // Field Block Fragment
    ]);
    assert.deepEqual(frame, expected);
  });

  it("field block 為空", () => {
    const frame = getHeadersFrame({
      streamID: 1,
      flags: 0x04,
      fieldBlockFragment: Buffer.alloc(0),
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x00,       // Length
      0x01,                   // Type: HEADERS
      0x04,                   // Flags
      0x00, 0x00, 0x00, 0x01, // Stream Identifier
    ]);
    assert.deepEqual(frame, expected);
  });

  it("flags 與 streamID 原樣寫入", () => {
    const frame = getHeadersFrame({
      streamID: 0x7fffffff,
      flags: 0xff,
      fieldBlockFragment: Buffer.from([0x82]),
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x01,       // Length
      0x01,                   // Type: HEADERS
      0xff,                   // Flags
      0x7f, 0xff, 0xff, 0xff, // Stream Identifier
      0x82,                   // Field Block Fragment
    ]);
    assert.deepEqual(frame, expected);
  });

  it("streamID 的 Reserved bit 會保留", () => {
    const frame = getHeadersFrame({
      streamID: 0x80000001,
      flags: 0x05,
      fieldBlockFragment: Buffer.from([0x82]),
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x01,       // Length
      0x01,                   // Type: HEADERS
      0x05,                   // Flags
      0x80, 0x00, 0x00, 0x01, // Stream Identifier
      0x82,                   // Field Block Fragment
    ]);
    assert.deepEqual(frame, expected);
  });

  it("padLength 3：Pad Length + padding 都算進 Length", () => {
    const frame = getHeadersFrame({
      streamID: 1,
      flags: 0x0c,
      fieldBlockFragment: Buffer.from([0x82]),
      padLength: 3,
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x05,       // Length
      0x01,                   // Type: HEADERS
      0x0c,                   // Flags
      0x00, 0x00, 0x00, 0x01, // Stream Identifier
      0x03,                   // Pad Length
      0x82,                   // Field Block Fragment
      0x00, 0x00, 0x00,       // Padding
    ]);
    assert.deepEqual(frame, expected);
  });

  it("paddingFill 決定 padding 的內容", () => {
    const frame = getHeadersFrame({
      streamID: 1,
      flags: 0x0c,
      fieldBlockFragment: Buffer.from([0x82]),
      padLength: 2,
      paddingFill: 0xab,
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x04,       // Length
      0x01,                   // Type: HEADERS
      0x0c,                   // Flags
      0x00, 0x00, 0x00, 0x01, // Stream Identifier
      0x02,                   // Pad Length
      0x82,                   // Field Block Fragment
      0xab, 0xab,             // Padding
    ]);
    assert.deepEqual(frame, expected);
  });

  it("padLength 0：只多 1 byte 的 Pad Length", () => {
    const frame = getHeadersFrame({
      streamID: 1,
      flags: 0x0c,
      fieldBlockFragment: Buffer.from([0x82]),
      padLength: 0,
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x02,       // Length
      0x01,                   // Type: HEADERS
      0x0c,                   // Flags
      0x00, 0x00, 0x00, 0x01, // Stream Identifier
      0x00,                   // Pad Length
      0x82,                   // Field Block Fragment
    ]);
    assert.deepEqual(frame, expected);
  });

  it("padLength 255：Length 為 1 + field block + 255", () => {
    const frame = getHeadersFrame({
      streamID: 1,
      flags: 0x0c,
      fieldBlockFragment: Buffer.from([0x82]),
      padLength: 255,
    });
    assert.equal(frame.readUIntBE(0, 3), 1 + 1 + 255);
    assert.equal(frame[9], 255);
    assert.equal(frame.byteLength, 9 + 1 + 1 + 255);
  });

  it("padLength 不會自動設定 PADDED flag（黑箱測試需要造出不一致的 frame）", () => {
    const frame = getHeadersFrame({
      streamID: 1,
      flags: 0x04,
      fieldBlockFragment: Buffer.from([0x82]),
      padLength: 1,
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x03,       // Length
      0x01,                   // Type: HEADERS
      0x04,                   // Flags
      0x00, 0x00, 0x00, 0x01, // Stream Identifier
      0x01,                   // Pad Length
      0x82,                   // Field Block Fragment
      0x00,                   // Padding
    ]);
    assert.deepEqual(frame, expected);
  });

  it("padLength 超過 255 會 throw", () => {
    assert.throws(
      () =>
        getHeadersFrame({
          streamID: 1,
          flags: 0x0c,
          fieldBlockFragment: Buffer.from([0x82]),
          padLength: 256,
        }),
      RangeError,
    );
  });

  it("大 field block（16385 bytes）：Length 為 0x004001", () => {
    const frame = getHeadersFrame({
      streamID: 1,
      flags: 0x04,
      fieldBlockFragment: Buffer.alloc(16385, 0x82),
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x40, 0x01,       // Length
      0x01,                   // Type: HEADERS
      0x04,                   // Flags
      0x00, 0x00, 0x00, 0x01, // Stream Identifier
    ]);
    assert.deepEqual(frame.subarray(0, 9), expected);
    assert.equal(frame.byteLength, 9 + 16385);
  });

  it("能被 readHttp2Frame 讀回", TEST_TIMEOUT, async () => {
    const frame = getHeadersFrame({
      streamID: 5,
      flags: 0x0c,
      fieldBlockFragment: Buffer.from([0x82, 0x84]),
      padLength: 2,
    });
    const socket = await connect((s) => s.write(frame));
    const [parsed] = await readFrames(socket, 1);
    assert.equal(parsed!.type, Http2FrameTypes.HEADERS);
    assert.equal(parsed!.flags, 0x0c);
    assert.equal(parsed!.streamID, 5);
    // prettier-ignore
    const expected = Buffer.from([
      0x02,       // Pad Length
      0x82, 0x84, // Field Block Fragment
      0x00, 0x00, // Padding
    ]);
    assert.deepEqual(parsed!.payload, expected);
    assert.deepEqual(parsed!.raw, frame);
  });
});

describe("getPriorityFrame", () => {
  it("Length 固定為 5，Type 為 0x02，Flags 為 0", () => {
    const frame = getPriorityFrame({
      streamID: 3,
      exclusive: 0,
      streamDependency: 1,
      weight: 15,
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x05,       // Length
      0x02,                   // Type: PRIORITY
      0x00,                   // Flags
      0x00, 0x00, 0x00, 0x03, // Stream Identifier
      0x00, 0x00, 0x00, 0x01, // Exclusive + Stream Dependency
      0x0f,                   // Weight
    ]);
    assert.deepEqual(frame, expected);
  });

  it("exclusive 1：Stream Dependency 的最高位元為 1", () => {
    const frame = getPriorityFrame({
      streamID: 3,
      exclusive: 1,
      streamDependency: 1,
      weight: 15,
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x05,       // Length
      0x02,                   // Type: PRIORITY
      0x00,                   // Flags
      0x00, 0x00, 0x00, 0x03, // Stream Identifier
      0x80, 0x00, 0x00, 0x01, // Exclusive + Stream Dependency
      0x0f,                   // Weight
    ]);
    assert.deepEqual(frame, expected);
  });

  it("exclusive 1 + Stream Dependency 最大值", () => {
    const frame = getPriorityFrame({
      streamID: 3,
      exclusive: 1,
      streamDependency: 0x7fffffff,
      weight: 0,
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x05,       // Length
      0x02,                   // Type: PRIORITY
      0x00,                   // Flags
      0x00, 0x00, 0x00, 0x03, // Stream Identifier
      0xff, 0xff, 0xff, 0xff, // Exclusive + Stream Dependency
      0x00,                   // Weight
    ]);
    assert.deepEqual(frame, expected);
  });

  it("exclusive 0 + Stream Dependency 最大值：最高位元維持 0", () => {
    const frame = getPriorityFrame({
      streamID: 3,
      exclusive: 0,
      streamDependency: 0x7fffffff,
      weight: 0,
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x05,       // Length
      0x02,                   // Type: PRIORITY
      0x00,                   // Flags
      0x00, 0x00, 0x00, 0x03, // Stream Identifier
      0x7f, 0xff, 0xff, 0xff, // Exclusive + Stream Dependency
      0x00,                   // Weight
    ]);
    assert.deepEqual(frame, expected);
  });

  it("weight 邊界值 0 與 255", () => {
    const min = getPriorityFrame({
      streamID: 1,
      exclusive: 0,
      streamDependency: 0,
      weight: 0,
    });
    const max = getPriorityFrame({
      streamID: 1,
      exclusive: 0,
      streamDependency: 0,
      weight: 255,
    });
    assert.equal(min[13], 0x00);
    assert.equal(max[13], 0xff);
  });

  it("weight 超過 255 會 throw", () => {
    assert.throws(
      () =>
        getPriorityFrame({
          streamID: 1,
          exclusive: 0,
          streamDependency: 0,
          weight: 256,
        }),
      RangeError,
    );
  });

  it("streamID 0 也能產生（用來測 server 的錯誤處理）", () => {
    const frame = getPriorityFrame({
      streamID: 0,
      exclusive: 0,
      streamDependency: 0,
      weight: 15,
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x05,       // Length
      0x02,                   // Type: PRIORITY
      0x00,                   // Flags
      0x00, 0x00, 0x00, 0x00, // Stream Identifier
      0x00, 0x00, 0x00, 0x00, // Exclusive + Stream Dependency
      0x0f,                   // Weight
    ]);
    assert.deepEqual(frame, expected);
  });

  it("能被 readHttp2Frame 讀回", TEST_TIMEOUT, async () => {
    const frame = getPriorityFrame({
      streamID: 7,
      exclusive: 1,
      streamDependency: 3,
      weight: 200,
    });
    const socket = await connect((s) => s.write(frame));
    const [parsed] = await readFrames(socket, 1);
    assert.equal(parsed!.type, Http2FrameTypes.PRIORITY);
    assert.equal(parsed!.length, 5);
    assert.equal(parsed!.streamID, 7);
    // prettier-ignore
    const expected = Buffer.from([
      0x80, 0x00, 0x00, 0x03, // Exclusive + Stream Dependency
      0xc8,                   // Weight
    ]);
    assert.deepEqual(parsed!.payload, expected);
  });
});

describe("getContinuationFrame", () => {
  it("最小的 CONTINUATION frame", () => {
    const frame = getContinuationFrame({
      streamID: 1,
      flags: 0x04,
      fieldBlockFragment: Buffer.from([0x82, 0x84]),
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x02,       // Length
      0x09,                   // Type: CONTINUATION
      0x04,                   // Flags
      0x00, 0x00, 0x00, 0x01, // Stream Identifier
      0x82, 0x84,             // Field Block Fragment
    ]);
    assert.deepEqual(frame, expected);
  });

  it("field block 為空", () => {
    const frame = getContinuationFrame({
      streamID: 1,
      flags: 0x04,
      fieldBlockFragment: Buffer.alloc(0),
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x00,       // Length
      0x09,                   // Type: CONTINUATION
      0x04,                   // Flags
      0x00, 0x00, 0x00, 0x01, // Stream Identifier
    ]);
    assert.deepEqual(frame, expected);
  });

  it("沒有 END_HEADERS（flags 0）", () => {
    const frame = getContinuationFrame({
      streamID: 1,
      flags: 0x00,
      fieldBlockFragment: Buffer.from([0x82]),
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x01,       // Length
      0x09,                   // Type: CONTINUATION
      0x00,                   // Flags
      0x00, 0x00, 0x00, 0x01, // Stream Identifier
      0x82,                   // Field Block Fragment
    ]);
    assert.deepEqual(frame, expected);
  });

  it("flags 與 streamID 原樣寫入", () => {
    const frame = getContinuationFrame({
      streamID: 0x80000003,
      flags: 0xff,
      fieldBlockFragment: Buffer.from([0x82]),
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x01,       // Length
      0x09,                   // Type: CONTINUATION
      0xff,                   // Flags
      0x80, 0x00, 0x00, 0x03, // Stream Identifier
      0x82,                   // Field Block Fragment
    ]);
    assert.deepEqual(frame, expected);
  });

  it("沒有 Pad Length 與 padding（CONTINUATION 不支援 PADDED）", () => {
    const frame = getContinuationFrame({
      streamID: 1,
      flags: 0x08,
      fieldBlockFragment: Buffer.from([0x82]),
    });
    assert.equal(frame.readUIntBE(0, 3), 1);
    assert.equal(frame.byteLength, 9 + 1);
  });

  it("大 field block（16385 bytes）：Length 為 0x004001", () => {
    const frame = getContinuationFrame({
      streamID: 1,
      flags: 0x04,
      fieldBlockFragment: Buffer.alloc(16385, 0x82),
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x40, 0x01,       // Length
      0x09,                   // Type: CONTINUATION
      0x04,                   // Flags
      0x00, 0x00, 0x00, 0x01, // Stream Identifier
    ]);
    assert.deepEqual(frame.subarray(0, 9), expected);
    assert.equal(frame.byteLength, 9 + 16385);
  });

  it("能被 readHttp2Frame 讀回", TEST_TIMEOUT, async () => {
    const frame = getContinuationFrame({
      streamID: 5,
      flags: 0x04,
      fieldBlockFragment: Buffer.from([0x82, 0x84]),
    });
    const socket = await connect((s) => s.write(frame));
    const [parsed] = await readFrames(socket, 1);
    assert.equal(parsed!.type, Http2FrameTypes.CONTINUATION);
    assert.equal(parsed!.flags, 0x04);
    assert.equal(parsed!.streamID, 5);
    // prettier-ignore
    const expected = Buffer.from([
      0x82, 0x84, // Field Block Fragment
    ]);
    assert.deepEqual(parsed!.payload, expected);
  });
});

describe("getPushPromiseFrame", () => {
  it("最小的 PUSH_PROMISE frame", () => {
    const frame = getPushPromiseFrame({
      streamID: 1,
      flags: 0x04,
      promisedStreamID: 2,
      fieldBlockFragment: Buffer.from([0x82]),
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x05,       // Length
      0x05,                   // Type: PUSH_PROMISE
      0x04,                   // Flags
      0x00, 0x00, 0x00, 0x01, // Stream Identifier
      0x00, 0x00, 0x00, 0x02, // Promised Stream ID
      0x82,                   // Field Block Fragment
    ]);
    assert.deepEqual(frame, expected);
  });

  it("field block 為空：Length 只有 Promised Stream ID 的 4 bytes", () => {
    const frame = getPushPromiseFrame({
      streamID: 1,
      flags: 0x04,
      promisedStreamID: 2,
      fieldBlockFragment: Buffer.alloc(0),
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x04,       // Length
      0x05,                   // Type: PUSH_PROMISE
      0x04,                   // Flags
      0x00, 0x00, 0x00, 0x01, // Stream Identifier
      0x00, 0x00, 0x00, 0x02, // Promised Stream ID
    ]);
    assert.deepEqual(frame, expected);
  });

  it("padLength 2：Pad Length 在 Promised Stream ID 前面，padding 在最後", () => {
    const frame = getPushPromiseFrame({
      streamID: 1,
      flags: 0x0c,
      promisedStreamID: 2,
      fieldBlockFragment: Buffer.from([0x82]),
      padLength: 2,
      paddingFill: 0xab,
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x08,       // Length
      0x05,                   // Type: PUSH_PROMISE
      0x0c,                   // Flags
      0x00, 0x00, 0x00, 0x01, // Stream Identifier
      0x02,                   // Pad Length
      0x00, 0x00, 0x00, 0x02, // Promised Stream ID
      0x82,                   // Field Block Fragment
      0xab, 0xab,             // Padding
    ]);
    assert.deepEqual(frame, expected);
  });

  it("padLength 0：只多 1 byte 的 Pad Length", () => {
    const frame = getPushPromiseFrame({
      streamID: 1,
      flags: 0x0c,
      promisedStreamID: 2,
      fieldBlockFragment: Buffer.from([0x82]),
      padLength: 0,
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x06,       // Length
      0x05,                   // Type: PUSH_PROMISE
      0x0c,                   // Flags
      0x00, 0x00, 0x00, 0x01, // Stream Identifier
      0x00,                   // Pad Length
      0x00, 0x00, 0x00, 0x02, // Promised Stream ID
      0x82,                   // Field Block Fragment
    ]);
    assert.deepEqual(frame, expected);
  });

  it("streamID 與 promisedStreamID 的 Reserved bit 都會保留", () => {
    const frame = getPushPromiseFrame({
      streamID: 0x80000001,
      flags: 0x04,
      promisedStreamID: 0x80000002,
      fieldBlockFragment: Buffer.from([0x82]),
    });
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x05,       // Length
      0x05,                   // Type: PUSH_PROMISE
      0x04,                   // Flags
      0x80, 0x00, 0x00, 0x01, // Stream Identifier
      0x80, 0x00, 0x00, 0x02, // Promised Stream ID
      0x82,                   // Field Block Fragment
    ]);
    assert.deepEqual(frame, expected);
  });

  it("能被 readHttp2Frame 讀回", TEST_TIMEOUT, async () => {
    const frame = getPushPromiseFrame({
      streamID: 1,
      flags: 0x04,
      promisedStreamID: 2,
      fieldBlockFragment: Buffer.from([0x82, 0x84]),
    });
    const socket = await connect((s) => s.write(frame));
    const [parsed] = await readFrames(socket, 1);
    assert.equal(parsed!.type, Http2FrameTypes.PUSH_PROMISE);
    assert.equal(parsed!.streamID, 1);
    // prettier-ignore
    const expected = Buffer.from([
      0x00, 0x00, 0x00, 0x02, // Promised Stream ID
      0x82, 0x84,             // Field Block Fragment
    ]);
    assert.deepEqual(parsed!.payload, expected);
  });
});

describe("encodeIntegerRFC7541", () => {
  // RFC 7541 Appendix C.1
  describe("RFC 7541 Appendix C.1 的範例", () => {
    it("C.1.1：10，5-bit prefix", () => {
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "001", integer: 10 }),
        Buffer.from([0x2a]),
      );
    });

    it("C.1.2：1337，5-bit prefix", () => {
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "001", integer: 1337 }),
        Buffer.from([0x3f, 0x9a, 0x0a]),
      );
    });
  });

  describe("prefix 對應的第一個 byte", () => {
    it('"1"（7-bit）：Indexed Header Field，或 Huffman encoded = true', () => {
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
        Buffer.from([0x82]),
      );
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "1", integer: 126 }),
        Buffer.from([0xfe]),
      );
    });

    it('"0"（7-bit）：Huffman encoded = false', () => {
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "0", integer: 0 }),
        Buffer.from([0x00]),
      );
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "0", integer: 3 }),
        Buffer.from([0x03]),
      );
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "0", integer: 126 }),
        Buffer.from([0x7e]),
      );
    });

    it('"01"（6-bit）：Literal with Incremental Indexing', () => {
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "01", integer: 2 }),
        Buffer.from([0x42]),
      );
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "01", integer: 62 }),
        Buffer.from([0x7e]),
      );
    });

    it('"001"（5-bit）：Dynamic Table Size Update', () => {
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "001", integer: 0 }),
        Buffer.from([0x20]),
      );
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "001", integer: 30 }),
        Buffer.from([0x3e]),
      );
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "001", integer: 4097 }),
        Buffer.from([0x3f, 0xe2, 0x1f]),
      );
    });

    it('"0000"（4-bit）：Literal without Indexing', () => {
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "0000", integer: 0 }),
        Buffer.from([0x00]),
      );
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "0000", integer: 14 }),
        Buffer.from([0x0e]),
      );
    });

    it('"0001"（4-bit）：Literal Never Indexed', () => {
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "0001", integer: 0 }),
        Buffer.from([0x10]),
      );
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
        Buffer.from([0x11]),
      );
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "0001", integer: 14 }),
        Buffer.from([0x1e]),
      );
    });
  });

  describe("prefix 全為 1 的邊界：integer = 2^N - 1 就要多一個 byte", () => {
    it('"0"（7-bit）：126 一個 byte，127 兩個 bytes', () => {
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "0", integer: 126 }),
        Buffer.from([0x7e]),
      );
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "0", integer: 127 }),
        Buffer.from([0x7f, 0x00]),
      );
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "0", integer: 128 }),
        Buffer.from([0x7f, 0x01]),
      );
    });

    it('"1"（7-bit）：126 一個 byte，127 兩個 bytes', () => {
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "1", integer: 127 }),
        Buffer.from([0xff, 0x00]),
      );
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "1", integer: 128 }),
        Buffer.from([0xff, 0x01]),
      );
    });

    it('"01"（6-bit）：62 一個 byte，63 兩個 bytes', () => {
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "01", integer: 63 }),
        Buffer.from([0x7f, 0x00]),
      );
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "01", integer: 64 }),
        Buffer.from([0x7f, 0x01]),
      );
    });

    it('"001"（5-bit）：30 一個 byte，31 兩個 bytes', () => {
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "001", integer: 31 }),
        Buffer.from([0x3f, 0x00]),
      );
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "001", integer: 32 }),
        Buffer.from([0x3f, 0x01]),
      );
    });

    it('"0000" / "0001"（4-bit）：14 一個 byte，15 兩個 bytes', () => {
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "0000", integer: 15 }),
        Buffer.from([0x0f, 0x00]),
      );
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "0001", integer: 15 }),
        Buffer.from([0x1f, 0x00]),
      );
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "0001", integer: 16 }),
        Buffer.from([0x1f, 0x01]),
      );
    });
  });

  describe("多個 continuation byte", () => {
    it('"0"：300 = 127 + 173，173 的低 7 位在前', () => {
      // prettier-ignore
      const expected = Buffer.from([
        0x7f, // 0 + 1111111：prefix 全為 1，代表 integer ≥ 127，後面還有 byte
        0xad, // 1 + 0101101：continuation + 173 的低 7 位（173 = 1,0101101）
        0x01, // 0 + 0000001：結束 + 173 右移 7 位剩下的 1
      ]);
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "0", integer: 300 }),
        expected,
      );
    });

    it('"1"：255 = 127 + 128', () => {
      // prettier-ignore
      const expected = Buffer.from([
        0xff, // 1 + 1111111：H = 1 + prefix 全為 1
        0x80, // 1 + 0000000：continuation + 128 的低 7 位（128 = 1,0000000）
        0x01, // 0 + 0000001：結束 + 128 右移 7 位剩下的 1
      ]);
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "1", integer: 255 }),
        expected,
      );
    });

    it('"1"：1337 = 127 + 1210', () => {
      // prettier-ignore
      const expected = Buffer.from([
        0xff, // 1 + 1111111：H = 1 + prefix 全為 1
        0xba, // 1 + 0111010：continuation + 1210 的低 7 位（1210 = 1001,0111010）
        0x09, // 0 + 0001001：結束 + 1210 右移 7 位剩下的 9
      ]);
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "1", integer: 1337 }),
        expected,
      );
    });

    it('"1"：16511 = 127 + 16384，三個 continuation byte', () => {
      // prettier-ignore
      const expected = Buffer.from([
        0xff, // 1 + 1111111：H = 1 + prefix 全為 1
        0x80, // 1 + 0000000：continuation + 16384 的第 1 組 7 位（全 0）
        0x80, // 1 + 0000000：continuation + 16384 的第 2 組 7 位（全 0）
        0x01, // 0 + 0000001：結束 + 16384 = 2^14，第 3 組剩下的 1
      ]);
      assert.deepEqual(
        encodeIntegerRFC7541({ prefix: "1", integer: 127 + 16384 }),
        expected,
      );
    });
  });

  describe("round trip", () => {
    /**
     * RFC 7541 §5.1 的 decoder，獨立於 util 的實作
     */
    function decodeInteger(buffer: Buffer, prefixBits: number) {
      const maxN = 2 ** (8 - prefixBits) - 1;
      let value = buffer[0]! & maxN;
      if (value < maxN) return { value, length: 1 };
      let shift = 0;
      let i = 1;
      while (true) {
        const byte = buffer[i++]!;
        value += (byte & 0x7f) * 2 ** shift;
        shift += 7;
        if ((byte & 0x80) === 0) break;
      }
      return { value, length: i };
    }

    const prefixes = ["0", "1", "01", "001", "0000", "0001"] as const;
    const integers = [
      0,
      1,
      14,
      15,
      16,
      30,
      31,
      32,
      62,
      63,
      64,
      126,
      127,
      128,
      129,
      255,
      256,
      1337,
      4097,
      16383,
      16384,
      16385,
      2 ** 21,
      2 ** 21 + 1,
      2 ** 28 - 1,
    ];

    for (const prefix of prefixes) {
      it(`prefix "${prefix}"：decode 後還原成原本的整數`, () => {
        for (const integer of integers) {
          const encoded = encodeIntegerRFC7541({ prefix, integer });
          const decoded = decodeInteger(encoded, prefix.length);
          assert.equal(decoded.value, integer, `integer = ${integer}`);
          assert.equal(decoded.length, encoded.length, `integer = ${integer}`);
          // 第一個 byte 的高位元必須是 prefix
          assert.equal(
            encoded[0]! >> (8 - prefix.length),
            parseInt(prefix, 2),
            `integer = ${integer}`,
          );
        }
      });
    }
  });
});

describe("encodeStringLiteralsRFC7541", () => {
  describe("非 Huffman", () => {
    it("空字串：只有長度 0", () => {
      assert.deepEqual(
        encodeStringLiteralsRFC7541({ string: "" }),
        Buffer.from([0x00]),
      );
    });

    it("短字串", () => {
      assert.deepEqual(
        encodeStringLiteralsRFC7541({ string: "abc" }),
        Buffer.from([0x03, 0x61, 0x62, 0x63]),
      );
    });

    it("126 bytes：長度是一個 byte", () => {
      const encoded = encodeStringLiteralsRFC7541({ string: "a".repeat(126) });
      assert.deepEqual(
        encoded,
        Buffer.concat([Buffer.from([0x7e]), Buffer.alloc(126, 0x61)]),
      );
    });

    it("127 bytes：長度是 7f 00（原本會被誤判成還有後續 byte）", () => {
      const encoded = encodeStringLiteralsRFC7541({ string: "a".repeat(127) });
      assert.deepEqual(
        encoded,
        Buffer.concat([Buffer.from([0x7f, 0x00]), Buffer.alloc(127, 0x61)]),
      );
    });

    it("128 bytes：長度是 7f 01（原本最高位元會被誤判成 Huffman flag）", () => {
      const encoded = encodeStringLiteralsRFC7541({ string: "a".repeat(128) });
      assert.deepEqual(
        encoded,
        Buffer.concat([Buffer.from([0x7f, 0x01]), Buffer.alloc(128, 0x61)]),
      );
    });

    it("300 bytes：長度是 7f ad 01", () => {
      const encoded = encodeStringLiteralsRFC7541({ string: "a".repeat(300) });
      assert.deepEqual(
        encoded,
        Buffer.concat([
          Buffer.from([0x7f, 0xad, 0x01]),
          Buffer.alloc(300, 0x61),
        ]),
      );
    });

    it("U+0080 ~ U+00FF 以 latin1 編碼成 1 byte，長度也是 1", () => {
      assert.deepEqual(
        encodeStringLiteralsRFC7541({ string: "é" }),
        Buffer.from([0x01, 0xe9]),
      );
    });
  });

  describe("Huffman：RFC 7541 Appendix C 的範例", () => {
    it('C.4.1："www.example.com"', () => {
      assert.deepEqual(
        encodeStringLiteralsRFC7541({
          huffman: true,
          string: "www.example.com",
        }),
        Buffer.from([
          0x8c, 0xf1, 0xe3, 0xc2, 0xe5, 0xf2, 0x3a, 0x6b, 0xa0, 0xab, 0x90,
          0xf4, 0xff,
        ]),
      );
    });

    it('C.4.2："no-cache"', () => {
      assert.deepEqual(
        encodeStringLiteralsRFC7541({ huffman: true, string: "no-cache" }),
        Buffer.from([0x86, 0xa8, 0xeb, 0x10, 0x64, 0x9c, 0xbf]),
      );
    });

    it('C.4.3："custom-key"', () => {
      assert.deepEqual(
        encodeStringLiteralsRFC7541({ huffman: true, string: "custom-key" }),
        Buffer.from([0x88, 0x25, 0xa8, 0x49, 0xe9, 0x5b, 0xa9, 0x7d, 0x7f]),
      );
    });

    it('C.4.3："custom-value"', () => {
      assert.deepEqual(
        encodeStringLiteralsRFC7541({ huffman: true, string: "custom-value" }),
        Buffer.from([
          0x89, 0x25, 0xa8, 0x49, 0xe9, 0x5b, 0xb8, 0xe8, 0xb4, 0xbf,
        ]),
      );
    });
  });

  describe("Huffman：編碼後長度 ≥ 127 bytes", () => {
    // "a" 的 Huffman code 是 00011（5 bits），8 個 "a" 剛好 5 bytes
    const eightAs = Buffer.from([0x18, 0xc6, 0x31, 0x8c, 0x63]);

    it("編碼後 127 bytes：H = 1，長度是 ff 00", () => {
      // 200 個 "a" = 125 bytes，再 3 個 "a" = 15 bits + 1 bit padding = 18 c7
      const encoded = encodeStringLiteralsRFC7541({
        huffman: true,
        string: "a".repeat(203),
      });
      assert.deepEqual(
        encoded,
        Buffer.concat([
          Buffer.from([0xff, 0x00]),
          ...Array(25).fill(eightAs),
          Buffer.from([0x18, 0xc7]),
        ]),
      );
    });

    it("編碼後 130 bytes：長度是 ff 03", () => {
      const encoded = encodeStringLiteralsRFC7541({
        huffman: true,
        string: "a".repeat(208),
      });
      assert.deepEqual(
        encoded,
        Buffer.concat([Buffer.from([0xff, 0x03]), ...Array(26).fill(eightAs)]),
      );
    });
  });

  describe("Huffman：刻意構造不合法的 string literal", () => {
    it("customPaddingBits 取代原本的 EOS 前綴 padding", () => {
      // "a" = 00011，加上 padding 110 = 00011110
      assert.deepEqual(
        encodeStringLiteralsRFC7541({
          huffman: true,
          string: "a",
          customPaddingBits: "110",
        }),
        Buffer.from([0x81, 0x1e]),
      );
    });

    it("additionalBytes 會算進長度", () => {
      assert.deepEqual(
        encodeStringLiteralsRFC7541({
          huffman: true,
          string: "a",
          additionalBytes: Buffer.from([0x7f]),
        }),
        Buffer.from([0x82, 0x1f, 0x7f]),
      );
    });

    it("customPaddingBits + additionalBytes", () => {
      assert.deepEqual(
        encodeStringLiteralsRFC7541({
          huffman: true,
          string: "a",
          customPaddingBits: "110",
          additionalBytes: Buffer.from([0x7f]),
        }),
        Buffer.from([0x82, 0x1e, 0x7f]),
      );
    });

    it("customPaddingBits 讓總 bits 數不是 8 的倍數會 throw", () => {
      assert.throws(() =>
        encodeStringLiteralsRFC7541({
          huffman: true,
          string: "a",
          customPaddingBits: "1",
        }),
      );
    });

    it("字元大於 255 會 throw", () => {
      assert.throws(
        () => encodeStringLiteralsRFC7541({ huffman: true, string: "€" }),
        /invalid string/,
      );
    });
  });
});

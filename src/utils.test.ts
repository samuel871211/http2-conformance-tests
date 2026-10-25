import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import {
  emptySettingsFrame,
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

/**
 * 預期值一律手寫 hex（空白會被忽略），不依賴 util 本身的實作
 */
function hex(bytes: string) {
  return Buffer.from(bytes.replace(/\s/g, ""), "hex");
}

describe("getHeadersFrame", () => {
  it("最小的 HEADERS frame", () => {
    const frame = getHeadersFrame({
      streamID: 1,
      flags: 0x05,
      fieldBlockFragment: hex("82"),
    });
    assert.deepEqual(frame, hex("000001 01 05 00000001 82"));
  });

  it("field block 為空", () => {
    const frame = getHeadersFrame({
      streamID: 1,
      flags: 0x04,
      fieldBlockFragment: Buffer.alloc(0),
    });
    assert.deepEqual(frame, hex("000000 01 04 00000001"));
  });

  it("flags 與 streamID 原樣寫入", () => {
    const frame = getHeadersFrame({
      streamID: 0x7fffffff,
      flags: 0xff,
      fieldBlockFragment: hex("82"),
    });
    assert.deepEqual(frame, hex("000001 01 ff 7fffffff 82"));
  });

  it("streamID 的 Reserved bit 會保留", () => {
    const frame = getHeadersFrame({
      streamID: 0x80000001,
      flags: 0x05,
      fieldBlockFragment: hex("82"),
    });
    assert.deepEqual(frame, hex("000001 01 05 80000001 82"));
  });

  it("padLength 3：Pad Length + padding 都算進 Length", () => {
    const frame = getHeadersFrame({
      streamID: 1,
      flags: 0x0c,
      fieldBlockFragment: hex("82"),
      padLength: 3,
    });
    assert.deepEqual(frame, hex("000005 01 0c 00000001 03 82 000000"));
  });

  it("paddingFill 決定 padding 的內容", () => {
    const frame = getHeadersFrame({
      streamID: 1,
      flags: 0x0c,
      fieldBlockFragment: hex("82"),
      padLength: 2,
      paddingFill: 0xab,
    });
    assert.deepEqual(frame, hex("000004 01 0c 00000001 02 82 abab"));
  });

  it("padLength 0：只多 1 byte 的 Pad Length", () => {
    const frame = getHeadersFrame({
      streamID: 1,
      flags: 0x0c,
      fieldBlockFragment: hex("82"),
      padLength: 0,
    });
    assert.deepEqual(frame, hex("000002 01 0c 00000001 00 82"));
  });

  it("padLength 255：Length 為 1 + field block + 255", () => {
    const frame = getHeadersFrame({
      streamID: 1,
      flags: 0x0c,
      fieldBlockFragment: hex("82"),
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
      fieldBlockFragment: hex("82"),
      padLength: 1,
    });
    assert.deepEqual(frame, hex("000003 01 04 00000001 01 82 00"));
  });

  it("padLength 超過 255 會 throw", () => {
    assert.throws(
      () =>
        getHeadersFrame({
          streamID: 1,
          flags: 0x0c,
          fieldBlockFragment: hex("82"),
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
    assert.deepEqual(frame.subarray(0, 9), hex("004001 01 04 00000001"));
    assert.equal(frame.byteLength, 9 + 16385);
  });

  it("能被 readHttp2Frame 讀回", TEST_TIMEOUT, async () => {
    const frame = getHeadersFrame({
      streamID: 5,
      flags: 0x0c,
      fieldBlockFragment: hex("8284"),
      padLength: 2,
    });
    const socket = await connect((s) => s.write(frame));
    const [parsed] = await readFrames(socket, 1);
    assert.equal(parsed!.type, Http2FrameTypes.HEADERS);
    assert.equal(parsed!.flags, 0x0c);
    assert.equal(parsed!.streamID, 5);
    assert.deepEqual(parsed!.payload, hex("02 8284 0000"));
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
    assert.deepEqual(frame, hex("000005 02 00 00000003 00000001 0f"));
  });

  it("exclusive 1：Stream Dependency 的最高位元為 1", () => {
    const frame = getPriorityFrame({
      streamID: 3,
      exclusive: 1,
      streamDependency: 1,
      weight: 15,
    });
    assert.deepEqual(frame, hex("000005 02 00 00000003 80000001 0f"));
  });

  it("exclusive 1 + Stream Dependency 最大值", () => {
    const frame = getPriorityFrame({
      streamID: 3,
      exclusive: 1,
      streamDependency: 0x7fffffff,
      weight: 0,
    });
    assert.deepEqual(frame, hex("000005 02 00 00000003 ffffffff 00"));
  });

  it("exclusive 0 + Stream Dependency 最大值：最高位元維持 0", () => {
    const frame = getPriorityFrame({
      streamID: 3,
      exclusive: 0,
      streamDependency: 0x7fffffff,
      weight: 0,
    });
    assert.deepEqual(frame, hex("000005 02 00 00000003 7fffffff 00"));
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
    assert.deepEqual(frame, hex("000005 02 00 00000000 00000000 0f"));
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
    assert.deepEqual(parsed!.payload, hex("80000003 c8"));
  });
});

describe("getContinuationFrame", () => {
  it("最小的 CONTINUATION frame", () => {
    const frame = getContinuationFrame({
      streamID: 1,
      flags: 0x04,
      fieldBlockFragment: hex("8284"),
    });
    assert.deepEqual(frame, hex("000002 09 04 00000001 8284"));
  });

  it("field block 為空", () => {
    const frame = getContinuationFrame({
      streamID: 1,
      flags: 0x04,
      fieldBlockFragment: Buffer.alloc(0),
    });
    assert.deepEqual(frame, hex("000000 09 04 00000001"));
  });

  it("沒有 END_HEADERS（flags 0）", () => {
    const frame = getContinuationFrame({
      streamID: 1,
      flags: 0x00,
      fieldBlockFragment: hex("82"),
    });
    assert.deepEqual(frame, hex("000001 09 00 00000001 82"));
  });

  it("flags 與 streamID 原樣寫入", () => {
    const frame = getContinuationFrame({
      streamID: 0x80000003,
      flags: 0xff,
      fieldBlockFragment: hex("82"),
    });
    assert.deepEqual(frame, hex("000001 09 ff 80000003 82"));
  });

  it("沒有 Pad Length 與 padding（CONTINUATION 不支援 PADDED）", () => {
    const frame = getContinuationFrame({
      streamID: 1,
      flags: 0x08,
      fieldBlockFragment: hex("82"),
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
    assert.deepEqual(frame.subarray(0, 9), hex("004001 09 04 00000001"));
    assert.equal(frame.byteLength, 9 + 16385);
  });

  it("能被 readHttp2Frame 讀回", TEST_TIMEOUT, async () => {
    const frame = getContinuationFrame({
      streamID: 5,
      flags: 0x04,
      fieldBlockFragment: hex("8284"),
    });
    const socket = await connect((s) => s.write(frame));
    const [parsed] = await readFrames(socket, 1);
    assert.equal(parsed!.type, Http2FrameTypes.CONTINUATION);
    assert.equal(parsed!.flags, 0x04);
    assert.equal(parsed!.streamID, 5);
    assert.deepEqual(parsed!.payload, hex("8284"));
  });
});

describe("getPushPromiseFrame", () => {
  it("最小的 PUSH_PROMISE frame", () => {
    const frame = getPushPromiseFrame({
      streamID: 1,
      flags: 0x04,
      promisedStreamID: 2,
      fieldBlockFragment: hex("82"),
    });
    assert.deepEqual(frame, hex("000005 05 04 00000001 00000002 82"));
  });

  it("field block 為空：Length 只有 Promised Stream ID 的 4 bytes", () => {
    const frame = getPushPromiseFrame({
      streamID: 1,
      flags: 0x04,
      promisedStreamID: 2,
      fieldBlockFragment: Buffer.alloc(0),
    });
    assert.deepEqual(frame, hex("000004 05 04 00000001 00000002"));
  });

  it("padLength 2：Pad Length 在 Promised Stream ID 前面，padding 在最後", () => {
    const frame = getPushPromiseFrame({
      streamID: 1,
      flags: 0x0c,
      promisedStreamID: 2,
      fieldBlockFragment: hex("82"),
      padLength: 2,
      paddingFill: 0xab,
    });
    assert.deepEqual(frame, hex("000008 05 0c 00000001 02 00000002 82 abab"));
  });

  it("padLength 0：只多 1 byte 的 Pad Length", () => {
    const frame = getPushPromiseFrame({
      streamID: 1,
      flags: 0x0c,
      promisedStreamID: 2,
      fieldBlockFragment: hex("82"),
      padLength: 0,
    });
    assert.deepEqual(frame, hex("000006 05 0c 00000001 00 00000002 82"));
  });

  it("streamID 與 promisedStreamID 的 Reserved bit 都會保留", () => {
    const frame = getPushPromiseFrame({
      streamID: 0x80000001,
      flags: 0x04,
      promisedStreamID: 0x80000002,
      fieldBlockFragment: hex("82"),
    });
    assert.deepEqual(frame, hex("000005 05 04 80000001 80000002 82"));
  });

  it("能被 readHttp2Frame 讀回", TEST_TIMEOUT, async () => {
    const frame = getPushPromiseFrame({
      streamID: 1,
      flags: 0x04,
      promisedStreamID: 2,
      fieldBlockFragment: hex("8284"),
    });
    const socket = await connect((s) => s.write(frame));
    const [parsed] = await readFrames(socket, 1);
    assert.equal(parsed!.type, Http2FrameTypes.PUSH_PROMISE);
    assert.equal(parsed!.streamID, 1);
    assert.deepEqual(parsed!.payload, hex("00000002 8284"));
  });
});

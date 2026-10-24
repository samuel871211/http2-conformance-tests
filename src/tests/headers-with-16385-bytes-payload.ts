import http2 from "http2";
import net from "net";
import assert from "assert";
import { serverOption } from "../server-option.js";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  getHeadersFrame,
  http2ConnectionPreface,
  readHttp2Frame,
  writeAsync,
  ERROR_CODES,
  getGoawayFrame,
  getFileName,
} from "../utils.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-4.2",
      description: `
        A frame size error in a frame that could alter the state of the entire
        connection MUST be treated as a connection error (Section 5.4.1); this
        includes any frame carrying a field block (Section 4.3) (that is,
        HEADERS, PUSH_PROMISE, and CONTINUATION), a SETTINGS frame, and any
        frame with a stream identifier of 0.
      `,
    },
  ],
};

if (enableNodejsHttp2Server) {
  const http2Server = http2.createServer();
  http2Server.listen(port);
  http2Server.on("stream", () =>
    assert(false, `Should not trigger http2Server.on("stream")`),
  );
}

const socket = net.connect({
  host,
  port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
const validFieldBlockFragment = Buffer.concat([
  encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
  encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
  encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

  encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
  encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),
]);
// 預設 SETTINGS_MAX_FRAME_SIZE = 16384，payload 刻意多 1 byte
// 後面補 0x00 填滿，server 應該在讀完 frame header 就判定 frame size 錯誤
const invalidHeadersFrame = getHeadersFrame({
  streamID: 1,
  flags: 5,
  fieldBlockFragment: Buffer.concat([
    validFieldBlockFragment,
    Buffer.alloc(16385 - validFieldBlockFragment.byteLength),
  ]),
});
await writeAsync(socket, invalidHeadersFrame);
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not close the TCP connection`);
  process.exit(1);
});
const maybeGoawayFrame = await readHttp2Frame(socket);
const goawayFrame = getGoawayFrame({
  lastStreamID: 0,
  errorCode: ERROR_CODES.FRAME_SIZE_ERROR,
});
const goawayFrameNghttp2 = getGoawayFrame({
  lastStreamID: 0,
  errorCode: ERROR_CODES.FRAME_SIZE_ERROR,
  additionalDebugData: Buffer.from("too large frame size", "latin1"),
});
assert(
  maybeGoawayFrame.raw.equals(goawayFrame) ||
    maybeGoawayFrame.raw.equals(goawayFrameNghttp2),
);
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});

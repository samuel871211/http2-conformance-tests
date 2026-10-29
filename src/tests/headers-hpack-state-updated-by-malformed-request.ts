import http2 from "http2";
import net from "net";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  ERROR_CODES,
  getHeadersFrame,
  getRSTFrame,
  http2ConnectionPreface,
  Http2FrameTypes,
  readHttp2FramesUntil,
  readUntilEndStream,
} from "../utils.js";
import { getFileName } from "../utils.js";
import assert from "assert";
import { serverOption } from "../server-option.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-4.3",
      description: `
        A receiving endpoint reassembles the field block by concatenating
        its fragments and then decompresses the block to reconstruct the
        field section.
      `,
    },
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-5.4.2",
      description: `
        An endpoint receiving HEADERS, PUSH_PROMISE, or CONTINUATION frames
        needs to reassemble field blocks and perform decompression even if
        the frames are to be discarded. These frames can be ignored, except
        where they modify connection state (such as the state maintained for
        field section compression (Section 4.3) or flow control).
      `,
    },
  ],
};

if (enableNodejsHttp2Server) {
  const http2Server = http2.createServer();
  http2Server.listen(port);
  http2Server.on("stream", (stream) => {
    stream.respond();
    stream.end();
  });
}

const socket = net.connect({
  host,
  port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
// stream 1：x-test: 1 進入 dynamic table（index 62），但大寫的 field name 讓 request 變成 malformed
const headersFrame = getHeadersFrame({
  streamID: 1,
  flags: 5,
  fieldBlockFragment: Buffer.concat([
    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),

    encodeIntegerRFC7541({ prefix: "01", integer: 0 }),
    encodeStringLiteralsRFC7541({ string: "x-test" }),
    encodeStringLiteralsRFC7541({ string: "1" }),

    encodeIntegerRFC7541({ prefix: "0000", integer: 0 }),
    encodeStringLiteralsRFC7541({ string: "TEST" }),
    encodeStringLiteralsRFC7541({ string: "123" }),
  ]),
});
socket.write(headersFrame);
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not respond to stream 3`);
  process.exit(1);
});
// stream 3：用 index 62 引用 stream 1 建立的 x-test: 1
const headersFrame2 = getHeadersFrame({
  streamID: 3,
  flags: 5,
  fieldBlockFragment: Buffer.concat([
    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),

    encodeIntegerRFC7541({ prefix: "1", integer: 62 }),
  ]),
});
socket.write(headersFrame2);
const http2Frames = await readHttp2FramesUntil({
  socket,
  predicate: (http2Frame) =>
    readUntilEndStream({ http2Frame, streamID: 3 }) ||
    http2Frame.type === Http2FrameTypes.GOAWAY,
});
// server 沒有因為 HPACK 狀態不同步而送 GOAWAY
assert(
  http2Frames.every((http2Frame) => http2Frame.type !== Http2FrameTypes.GOAWAY),
  "Should not receive GOAWAY frame",
);
const rstFrame = getRSTFrame({
  streamID: 1,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
});
assert(http2Frames.some((http2Frame) => http2Frame.raw.equals(rstFrame)));
console.log(`${fileName}: ok`);
process.exit(0);

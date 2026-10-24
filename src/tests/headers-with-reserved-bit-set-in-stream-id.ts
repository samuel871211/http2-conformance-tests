import http2 from "http2";
import net from "net";
import assert from "assert";
import { serverOption } from "../server-option.js";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  http2ConnectionPreface,
  numberTo3BytesBuffer,
  readHttp2FramesUntil,
  writeAsync,
  getFileName,
  Http2FrameTypes,
} from "../utils.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-4.1",
      description: `
        Reserved: A reserved 1-bit field.  The semantics of this bit are
        undefined, and the bit MUST remain unset (0x00) when sending and MUST
        be ignored when receiving.
      `,
    },
  ],
};

if (enableNodejsHttp2Server) {
  const http2Server = http2.createServer();
  http2Server.listen(port);
  http2Server.on("stream", (stream) =>
    stream.respond({ ":status": 200 }, { endStream: true }),
  );
}

const socket = net.connect({
  host,
  port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
const fieldBlockFragment = Buffer.concat([
  encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
  encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
  encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

  encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
  encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),
]);
// prettier-ignore
const invalidHeadersFrame = Buffer.from([
  ...numberTo3BytesBuffer(fieldBlockFragment.byteLength), // Length
  0x01,                   // Type
  0x05,                   // Flags (END_STREAM + END_HEADERS)
  0x80, 0x00, 0x00, 0x01, // Reserved (set to 1) + Stream Identifier (1)
  ...fieldBlockFragment,  // Payload
]);
await writeAsync(socket, invalidHeadersFrame);
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not respond`);
  process.exit(1);
});
const http2Frames = await readHttp2FramesUntil({
  socket,
  predicate: (http2Frame) =>
    http2Frame.type === Http2FrameTypes.HEADERS ||
    http2Frame.type === Http2FrameTypes.RST_STREAM ||
    http2Frame.type === Http2FrameTypes.GOAWAY,
});
// reserved bit 應被忽略，request 視為 stream 1，response 也應該在 stream 1
const lastHttp2Frame = http2Frames[http2Frames.length - 1]!;
assert(lastHttp2Frame.type === Http2FrameTypes.HEADERS);
assert(lastHttp2Frame.streamID === 1);
console.log(`${fileName}: ok`);
process.exit(0);

import http2 from "http2";
import net from "net";
import assert from "assert";
import { serverOption } from "../server-option.js";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  getHeadersFrame,
  getSettingsFrame,
  http2ConnectionPreface,
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
      url: "https://datatracker.ietf.org/doc/html/rfc7541#section-4.2",
      description: `
        This dynamic table size update MUST occur at the beginning of the
        first header block following the change to the dynamic table size.
        In HTTP/2, this follows a settings acknowledgment (see Section 6.5.3
        of [HTTP2]).
      `,
    },
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-4.3.1",
      description: `
        A change in the maximum size of the dynamic table is signaled via a
        dynamic table size update (see Section 6.3 of [COMPRESSION]).  This
        dynamic table size update MUST occur at the beginning of the first
        field block following the change to the dynamic table size.
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
// 告訴 server 我們的 decoder dynamic table 最大只有 0 bytes
await http2ConnectionPreface(
  socket,
  getSettingsFrame({ SETTINGS_HEADER_TABLE_SIZE: 0 }),
);
const headersFrame = getHeadersFrame({
  streamID: 1,
  flags: 5,
  fieldBlockFragment: Buffer.concat([
    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),
  ]),
});
await writeAsync(socket, headersFrame);
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not respond`);
  process.exit(1);
});
const http2Frames = await readHttp2FramesUntil({
  socket,
  predicate: (http2Frame) =>
    http2Frame.type === Http2FrameTypes.HEADERS ||
    http2Frame.type === Http2FrameTypes.GOAWAY,
});
const responseHeadersFrame = http2Frames[http2Frames.length - 1]!;
assert(responseHeadersFrame.type === Http2FrameTypes.HEADERS);
// 跳過 Pad Length（PADDED）和 Exclusive + Stream Dependency + Weight（PRIORITY）
let fieldBlockOffset = 0;
if (responseHeadersFrame.flags & 0x08) fieldBlockOffset += 1;
if (responseHeadersFrame.flags & 0x20) fieldBlockOffset += 5;
// 0x20 = 001 + 00000，Dynamic Table Size Update，新的 maximum size 為 0
assert(responseHeadersFrame.payload[fieldBlockOffset] === 0x20);
console.log(`${fileName}: ok`);
process.exit(0);

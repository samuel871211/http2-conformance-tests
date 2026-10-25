import net from "net";
import http2 from "http2";
import {
  http2ConnectionPreface,
  getHeadersFrame,
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  readHttp2FramesUntil,
  Http2FrameTypes,
  getFileName,
} from "../utils.js";
import assert from "assert";
import { serverOption } from "../server-option.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-8.2.2",
      description: `
        The only exception to this is the TE header field, which MAY be
        present in an HTTP/2 request; when it is, it MUST NOT contain any
        value other than "trailers".
      `,
    },
  ],
};

let streamTriggered = false;
if (enableNodejsHttp2Server) {
  const http2Server = http2.createServer();
  http2Server.listen(port);
  http2Server.on("stream", (stream, headers) => {
    streamTriggered = true;
    assert(headers.te === "trailers");
    stream.respond({ ":status": 200 }, { endStream: true });
  });
}
const socket = net.connect({
  host,
  port,
});
await http2ConnectionPreface(socket);
const headersFrame = getHeadersFrame({
  streamID: 1,
  // END_STREAM + END_HEADERS
  flags: 5,
  fieldBlockFragment: Buffer.concat([
    // :method: GET
    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
    // :scheme: http
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),
    // :path: /
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    // :authority: ${host}:${port}
    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),
    // te: trailers（唯一允許出現在 HTTP/2 request 的 connection-specific header field）
    encodeIntegerRFC7541({ prefix: "0001", integer: 0 }),
    encodeStringLiteralsRFC7541({ string: "te" }),
    encodeStringLiteralsRFC7541({ string: "trailers" }),
  ]),
});
socket.write(headersFrame);
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not respond to the request`);
  process.exit(1);
});
// 合法的 request 不應該收到 RST_STREAM 或 GOAWAY，而是 stream 1 的 response
const http2Frames = await readHttp2FramesUntil({
  socket,
  predicate: (http2Frame) =>
    http2Frame.type === Http2FrameTypes.RST_STREAM ||
    http2Frame.type === Http2FrameTypes.GOAWAY ||
    (http2Frame.type === Http2FrameTypes.HEADERS && http2Frame.streamID === 1),
});
const lastHttp2Frame = http2Frames[http2Frames.length - 1]!;
assert(lastHttp2Frame.type === Http2FrameTypes.HEADERS);
if (enableNodejsHttp2Server) assert(streamTriggered);
console.log(`${fileName}: ok`);
process.exit(0);

import net from "net";
import http2 from "http2";
import {
  getRSTFrame,
  http2ConnectionPreface,
  ERROR_CODES,
  getHeadersFrame,
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  readHttp2Frame,
  getFileName,
} from "../utils.js";
import assert from "assert";
import { serverOption } from "../server-option.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-8.2.1",
      description: `
        A field value MUST NOT contain the zero value (ASCII NUL, 0x00),
        line feed (ASCII LF, 0x0a), or carriage return (ASCII CR, 0x0d) at
        any position.
      `,
    },
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9110#section-5.5",
      description: `
        a recipient of CR, LF, or NUL within a field value MUST either reject
        the message or replace each of those characters with SP before
        further processing or forwarding of that message.
      `,
    },
  ],
  sourceCode: [
    {
      // v1.70.0（Node.js v24.22.1 內建的版本），lib/nghttp2_http.c
      // 一般 header 的 value 不合法（LF 不在 VALID_HD_VALUE_CHARS 內）時，
      // 回傳 IGN（忽略該 header），不是 HTTP_HEADER（RST_STREAM）
      repo: "https://github.com/nghttp2/nghttp2",
      code: `
        default:
          if (nv->name->base[0] == ':') {
            return NGHTTP2_ERR_HTTP_HEADER;
          }

          if (!check_header_value(stream, nv->value)) {
            return NGHTTP2_ERR_IGN_HTTP_HEADER;
          }
      `,
    },
    {
      // src/node_http2.cc（v24.22.1）Http2Session::OnInvalidHeader
      // 有註冊這個 callback，nghttp2 就不會 RST_STREAM，而是直接略過該 header
      repo: "https://github.com/nodejs/node",
      code: `
        // Called by nghttp2 when an invalid header has been received. For now, we
        // ignore these. If this callback was not provided, nghttp2 would handle
        // invalid headers strictly and would shut down the stream. We are intentionally
        // being more lenient here although we may want to revisit this choice later.
        ...
        // Ignore invalid header fields by default.
        return 0;
      `,
    },
  ],
};

if (enableNodejsHttp2Server) {
  const http2Server = http2.createServer();
  http2Server.listen(port);
  // Node.js 會忽略不合法的 header，而不是 RST_STREAM，request 仍然被正常處理
  http2Server.on("stream", (stream, headers) => {
    assert(headers.test === undefined);
    assert(headers[":path"] === "/");
    console.log(`${fileName}: ok`);
    process.exit(0);
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
    // test: a\nb（field value 中間出現 LF）
    encodeIntegerRFC7541({ prefix: "0001", integer: 0 }),
    encodeStringLiteralsRFC7541({ string: "test" }),
    encodeStringLiteralsRFC7541({ string: "a\nb" }),
  ]),
});
socket.write(headersFrame);
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not respond with RST_STREAM`);
  process.exit(1);
});
const maybeRSTFrame = await readHttp2Frame(socket);
const rstFrame = getRSTFrame({
  streamID: 1,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
});
assert(maybeRSTFrame.raw.equals(rstFrame));
console.log(`${fileName}: ok`);
process.exit(0);

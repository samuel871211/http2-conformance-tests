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
  Http2FrameTypes,
} from "../utils.js";
import assert from "assert";
import { serverOption } from "../server-option.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-8.3.1",
      description: `
        A server SHOULD treat a request as malformed if it contains a Host
        header field that identifies an entity that differs from the entity
        in the ":authority" pseudo-header field.
      `,
    },
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-8.2.1",
      description: `
        When a request message violates one of these requirements, an
        implementation SHOULD generate a 400 (Bad Request) status code (see
        Section 15.5.1 of [HTTP]), unless a more suitable status code is
        defined or the status code cannot be sent (e.g., because the error
        occurs in a trailer field).
      `,
    },
  ],
  sourceCode: [
    {
      // v1.70.0（Node.js v24.22.1 內建的版本），lib/nghttp2_http.c
      // 只用 flag 記錄 host 有沒有出現，沒有拿它跟 :authority 比對
      repo: "https://github.com/nghttp2/nghttp2",
      code: `
        case NGHTTP2_TOKEN_HOST:
          if (!check_authority(nv->value->base, nv->value->len)) {
            return NGHTTP2_ERR_IGN_HTTP_HEADER;
          }
          if (!check_pseudo_header(stream, nv, NGHTTP2_HTTP_FLAG_HOST)) {
            return NGHTTP2_ERR_HTTP_HEADER;
          }
          break;
      `,
    },
    {
      // v1.70.0，lib/nghttp2_http.c nghttp2_http_on_request_headers
      // :authority 與 host 只要有其中一個就通過
      repo: "https://github.com/nghttp2/nghttp2",
      code: `
        if ((stream->http_flags &
             (NGHTTP2_HTTP_FLAG__AUTHORITY | NGHTTP2_HTTP_FLAG_HOST)) == 0) {
          return -1;
        }
      `,
    },
  ],
};

if (enableNodejsHttp2Server) {
  const http2Server = http2.createServer();
  http2Server.listen(port);
  // RFC 9113 只要求 SHOULD，Node.js 不檢查 host 與 :authority 是否一致，request 仍然被正常處理
  http2Server.on("stream", (stream, headers) => {
    assert(headers[":authority"] === `${host}:${port}`);
    assert(headers.host === "example.com");
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
    // host: example.com（與 :authority 不同）
    encodeIntegerRFC7541({ prefix: "0001", integer: 38 }),
    encodeStringLiteralsRFC7541({ string: "example.com" }),
  ]),
});
socket.write(headersFrame);
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not reject the request`);
  process.exit(1);
});
const maybeFrame = await readHttp2Frame(socket);
const rstFrame = getRSTFrame({
  streamID: 1,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
});
// :status: 400 的各種 HPACK 編碼：static table index 12，或以 index 8 當 name 的 literal
const status400FieldBlockFragments = [
  encodeIntegerRFC7541({ prefix: "1", integer: 12 }),
  ...(["01", "0000", "0001"] as const).flatMap((prefix) =>
    [false, true].map((huffman) =>
      Buffer.concat([
        encodeIntegerRFC7541({ prefix, integer: 8 }),
        encodeStringLiteralsRFC7541({ string: "400", huffman }),
      ]),
    ),
  ),
];
const isRSTFrame = maybeFrame.raw.equals(rstFrame);
const is400Response =
  maybeFrame.type === Http2FrameTypes.HEADERS &&
  maybeFrame.streamID === 1 &&
  status400FieldBlockFragments.some((fieldBlockFragment) =>
    maybeFrame.payload
      .subarray(0, fieldBlockFragment.length)
      .equals(fieldBlockFragment),
  );
assert(isRSTFrame || is400Response);
console.log(`${fileName}: ok`);
process.exit(0);

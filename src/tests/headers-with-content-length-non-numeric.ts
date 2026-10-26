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
      url: "https://datatracker.ietf.org/doc/html/rfc9110#section-8.6",
      description: `
        Content-Length = 1*DIGIT
        ...
        Likewise, a sender MUST NOT forward a message with a Content-Length
        header field value that does not match the ABNF above
      `,
    },
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-8.1.1",
      description: `
        Malformed requests or responses that are detected MUST be treated as
        a stream error (Section 5.4.2) of type PROTOCOL_ERROR.
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
    // content-length: abc
    encodeIntegerRFC7541({ prefix: "0001", integer: 28 }),
    encodeStringLiteralsRFC7541({ string: "abc" }),
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

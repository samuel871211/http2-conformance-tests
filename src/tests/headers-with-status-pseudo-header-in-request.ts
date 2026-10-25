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
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-8.3",
      description: `
        Pseudo-header fields defined for requests MUST NOT appear in
        responses; pseudo-header fields defined for responses MUST NOT appear
        in requests.
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
    // :status: 200（response 專用的 pseudo-header field）
    encodeIntegerRFC7541({ prefix: "1", integer: 8 }),
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

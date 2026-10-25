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
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-8.2.2",
      description: `
        This includes the Connection header field and those listed as having
        connection-specific semantics in Section 7.6.1 of [HTTP] (that is,
        Proxy-Connection, Keep-Alive, Transfer-Encoding, and Upgrade).  Any
        message containing connection-specific header fields MUST be treated
        as malformed (Section 8.1.1).
      `,
    },
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9110#section-7.6.1",
      description: `
        Furthermore, intermediaries SHOULD remove or replace fields that are
        known to require removal before forwarding, whether or not they
        appear as a connection-option, after applying those fields'
        semantics.
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
    // keep-alive: timeout=5
    encodeIntegerRFC7541({ prefix: "0001", integer: 0 }),
    encodeStringLiteralsRFC7541({ string: "keep-alive" }),
    encodeStringLiteralsRFC7541({ string: "timeout=5" }),
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

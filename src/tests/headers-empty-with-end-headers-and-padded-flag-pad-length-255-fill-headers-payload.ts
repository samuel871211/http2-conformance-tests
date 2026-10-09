import http2 from "http2";
import net from "net";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  ERROR_CODES,
  getHeadersFrame,
  getRSTFrame,
  http2ConnectionPreface,
} from "../utils.js";
import { getFileName, onceData } from "../utils.js";
import { serverOption } from "../server-option.js";
import assert from "assert";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.2",
      description: `
        Padding:  Padding octets that contain no application semantic value.
          Padding octets MUST be set to zero when sending.  A receiver is
          not obligated to verify padding but MAY treat non-zero padding as
          a connection error (Section 5.4.1) of type PROTOCOL_ERROR.
      `,
    },
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-8.1.1",
      description: `
        Malformed requests or responses that are
        detected MUST be treated as a stream error (Section 5.4.2) of type
        PROTOCOL_ERROR.
      `,
    },
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-8.3.1",
      description: `
        All HTTP/2 requests MUST include exactly one valid value for the
        ":method", ":scheme", and ":path" pseudo-header fields, unless they
        are CONNECT requests (Section 8.5).  An HTTP request that omits
        mandatory pseudo-header fields is malformed (Section 8.1.1).
      `,
    },
  ],
};

if (enableNodejsHttp2Server) {
  const http2Server = http2.createServer();
  http2Server.listen(port);
}

const socket = net.connect({
  host,
  port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
const headersFrame = getHeadersFrame({
  streamID: 1,
  flags: 12,
  padLength: 255,
  paddingFill: Buffer.concat([
    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),
  ]),
  fieldBlockFragment: Buffer.alloc(0),
});
socket.write(headersFrame);
const maybeRSTFrame = await onceData(socket);
const rstFrame = getRSTFrame({
  streamID: 1,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
});
assert(maybeRSTFrame.equals(rstFrame));
console.log(`${fileName}: ok`);
process.exit(0);

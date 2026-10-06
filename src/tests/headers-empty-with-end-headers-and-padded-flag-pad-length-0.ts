import http2 from "http2";
import net from "net";
import {
  ERROR_CODES,
  getHeadersFrame,
  getRSTFrame,
  http2ConnectionPreface,
} from "../utils.js";
import { getFileName, onceData } from "../utils.js";
import { serverOption } from "../server-option.js";
import assert from "assert";

const fileName = getFileName(import.meta.filename);

const config = {
  rfc: [
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

const http2Server = http2.createServer();
http2Server.listen(serverOption.port);

const socket = net.connect({
  host: serverOption.host,
  port: serverOption.port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
const headersFrame = getHeadersFrame({
  streamID: 1,
  flags: 12,
  padLength: 0,
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

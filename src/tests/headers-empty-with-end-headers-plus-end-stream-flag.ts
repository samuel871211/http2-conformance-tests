import http2 from "http2";
import net from "net";
import {
  getHeadersFrame,
  getRSTFrame,
  http2ConnectionPreface,
  ERROR_CODES,
} from "../utils.js";
import assert from "assert";
import { getFileName } from "../utils.js";
import { serverOption } from "../server-option.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
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
const rstFrame = getRSTFrame({
  streamID: 1,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
});
const headersFrame = getHeadersFrame({
  streamID: 1,
  flags: 5,
  fieldBlockFragment: Buffer.alloc(0),
});
socket.write(headersFrame);
socket.once("data", (chunk) => {
  assert(chunk.equals(rstFrame));
  console.log(`${fileName}: ok`);
  process.exit(0);
});

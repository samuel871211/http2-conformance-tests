import net from "net";
import http2 from "http2";
import {
  getRSTFrame,
  http2ConnectionPreface,
  ERROR_CODES,
  getHeadersFrame,
  getDataFrame,
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  readHttp2Frame,
  getGoawayFrame,
} from "../utils.js";
import assert from "assert";
import { serverOption } from "../server-option.js";
import { getFileName } from "../utils.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-8.1.1",
      description: `
        A request or response is also malformed if the value of a
        content-length header field does not equal the sum of the DATA frame
        payload lengths that form the content, unless the message is defined
        as having no content.
      `,
    },
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9110#section-8.6",
      description: `
        As a result, a sender MUST NOT forward a message with a Content-
        Length header field value that is known to be incorrect.
      `,
    },
  ],
};

if (enableNodejsHttp2Server) {
  const http2Server = http2.createServer();
  http2Server.listen(port);
  // HEADERS 本身合法，"stream" event 會觸發；content-length 不符時 stream 會 emit "error"
  http2Server.on("stream", (stream) => stream.on("error", () => {}));
}
const socket = net.connect({
  host,
  port,
});
await http2ConnectionPreface(socket);
const headersFrame = getHeadersFrame({
  streamID: 1,
  // END_HEADERS
  flags: 4,
  fieldBlockFragment: Buffer.concat([
    // :method: POST
    encodeIntegerRFC7541({ prefix: "1", integer: 3 }),
    // :scheme: http
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),
    // :path: /
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    // :authority: ${host}:${port}
    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),
    // content-length: 1
    encodeIntegerRFC7541({ prefix: "0001", integer: 28 }),
    encodeStringLiteralsRFC7541({ string: "1" }),
  ]),
});
// content-length 宣告 1 byte，但實際送 2 bytes
const dataFrame = getDataFrame({
  streamID: 1,
  // END_STREAM
  flags: 1,
  data: Buffer.from("ab"),
});
socket.write(Buffer.concat([headersFrame, dataFrame]));
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not respond with RST_STREAM`);
  process.exit(1);
});
if (enableNodejsHttp2Server) {
  const maybeGoawayFrame = await readHttp2Frame(socket);
  const goawayFrame = getGoawayFrame({
    lastStreamID: 1,
    errorCode: ERROR_CODES.INTERNAL_ERROR,
  });
  assert(maybeGoawayFrame.raw.equals(goawayFrame));
  console.log(`${fileName}: ok`);
  process.exit(0);
}
const maybeRSTFrame = await readHttp2Frame(socket);
const rstFrame = getRSTFrame({
  streamID: 1,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
});
assert(maybeRSTFrame.raw.equals(rstFrame));
console.log(`${fileName}: ok`);
process.exit(0);

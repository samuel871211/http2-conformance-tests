import http2 from "http2";
import net from "net";
import assert from "assert";
import { serverOption } from "../server-option.js";
import {
  getHeadersFrame,
  http2ConnectionPreface,
  readHttp2Frame,
  writeAsync,
  ERROR_CODES,
  getGoawayFrame,
  getFileName,
} from "../utils.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-5.5",
      description: `
        However, extension frames that appear in the middle of a field block
        (Section 4.3) are not permitted; these MUST be treated as a
        connection error (Section 5.4.1) of type PROTOCOL_ERROR.
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
  flags: 0,
  fieldBlockFragment: Buffer.alloc(0),
});
// prettier-ignore
const invalidUnknownFrame = Buffer.from([
  0x00, 0x00, 0x01,       // Length
  0xff,                   // Type (unknown)
  0x00,                   // Flags
  0x00, 0x00, 0x00, 0x01, // Reserved + Stream Identifier
  0x00,                   // Payload
]);
await writeAsync(socket, Buffer.concat([headersFrame, invalidUnknownFrame]));
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not close the TCP connection`);
  process.exit(1);
});
const maybeGoawayFrame = await readHttp2Frame(socket);
const goawayFrameNghttp2 = getGoawayFrame({
  lastStreamID: 1,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
  additionalDebugData: Buffer.from(
    "unexpected non-CONTINUATION frame or stream_id is invalid",
  ),
});
const goawayFrame = getGoawayFrame({
  lastStreamID: 1,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
});
assert(
  maybeGoawayFrame.raw.equals(goawayFrameNghttp2) ||
    maybeGoawayFrame.raw.equals(goawayFrame),
);
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});

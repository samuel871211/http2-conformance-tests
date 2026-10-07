import {
  ERROR_CODES,
  getGoawayFrame,
  http2ConnectionPreface,
  onceData,
} from "../utils.js";
import http2 from "http2";
import net from "net";
import { serverOption } from "../server-option.js";
import { getFileName } from "../utils.js";
import assert from "assert";

const fileName = getFileName(import.meta.filename);

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.8",
      description: `
        The GOAWAY frame applies to the connection, not a specific stream.
        An endpoint MUST treat a GOAWAY frame with a stream identifier other
        than 0x00 as a connection error (Section 5.4.1) of type
        PROTOCOL_ERROR.
      `,
    },
  ],
};

const http2Server = http2.createServer();
http2Server.listen(serverOption.port);
// prettier-ignore
const invalidGoawayFrame = Buffer.from([
  0x00, 0x00, 0x08,       // Length
  0x07,                   // Type
  0x00,                   // Flags
  0x00, 0x00, 0x00, 0x01, // Reserved + Stream Identifier
  0x00, 0x00, 0x00, 0x00, // Reserved + Last-Stream-ID
  0x00, 0x00, 0x00, 0x00, // Error Code
]);
const socket = net.connect({
  host: serverOption.host,
  port: serverOption.port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
socket.write(invalidGoawayFrame);
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not close the TCP connection`);
  process.exit(1);
});
const maybeGoawayFrame = await onceData(socket);
const goawayFrameNghttp2 = getGoawayFrame({
  lastStreamID: 0,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
  additionalDebugData: Buffer.from("GOAWAY: stream_id != 0", "utf8"),
});
const goawayFrame = getGoawayFrame({
  lastStreamID: 0,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
});
assert(
  maybeGoawayFrame.equals(goawayFrameNghttp2) ||
    maybeGoawayFrame.equals(goawayFrame),
);
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});

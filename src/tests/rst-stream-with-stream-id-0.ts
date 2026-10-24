import http2 from "http2";
import net from "net";
import assert from "assert";
import { serverOption } from "../server-option.js";
import {
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
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.4",
      description: `
        If a RST_STREAM frame is received with a stream identifier of 0x00,
        the recipient MUST treat this as a connection error (Section 5.4.1) of
        type PROTOCOL_ERROR.
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
// prettier-ignore
const invalidRSTFrame = Buffer.from([
  0x00, 0x00, 0x04,       // Length
  0x03,                   // Type
  0x00,                   // Flags
  0x00, 0x00, 0x00, 0x00, // Reserved + Stream Identifier (0)
  0x00, 0x00, 0x00, 0x08, // Error Code (CANCEL)
]);
await writeAsync(socket, invalidRSTFrame);
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not close the TCP connection`);
  process.exit(1);
});
const maybeGoawayFrame = await readHttp2Frame(socket);
const goawayFrame = getGoawayFrame({
  lastStreamID: 0,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
});
const goawayFrameNghttp2 = getGoawayFrame({
  lastStreamID: 0,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
  additionalDebugData: Buffer.from("RST_STREAM: stream_id == 0", "utf8"),
});
assert(
  maybeGoawayFrame.raw.equals(goawayFrame) ||
    maybeGoawayFrame.raw.equals(goawayFrameNghttp2),
);
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});

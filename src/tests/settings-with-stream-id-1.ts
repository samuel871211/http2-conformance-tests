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
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.5",
      description: `
        If an endpoint receives a SETTINGS frame whose Stream Identifier field
        is anything other than 0x00, the endpoint MUST respond with a
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
// prettier-ignore
const invalidSettingsFrame = Buffer.from([
  0x00, 0x00, 0x00,       // Length
  0x04,                   // Type
  0x00,                   // Flags
  0x00, 0x00, 0x00, 0x01, // Reserved + Stream Identifier (1)
]);
await writeAsync(socket, invalidSettingsFrame);
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
  additionalDebugData: Buffer.from("SETTINGS: stream_id != 0", "utf8"),
});
assert(
  maybeGoawayFrame.raw.equals(goawayFrame) ||
    maybeGoawayFrame.raw.equals(goawayFrameNghttp2),
);
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});

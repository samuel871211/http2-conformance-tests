import {
  http2ConnectionPreface,
  getGoawayFrame,
  ERROR_CODES,
} from "../utils.js";
import http2 from "http2";
import net from "net";
import { serverOption } from "../server-option.js";
import { onceData } from "../utils.js";
import assert from "assert";
import { getFileName } from "../utils.js";

const fileName = getFileName(import.meta.filename);

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-4.2",
      description: `
        An endpoint MUST send an error code of FRAME_SIZE_ERROR if a frame
        exceeds the size defined in SETTINGS_MAX_FRAME_SIZE, exceeds any
        limit defined for the frame type, or is too small to contain
        mandatory frame data.
      `,
    },
  ],
};

const http2Server = http2.createServer();
http2Server.listen(serverOption.port);
// prettier-ignore
const invalidGoawayFrame = Buffer.from([
  0x00, 0x00, 0x03,       // Length
  0x07,                   // Type
  0x00,                   // Flags
  0x00, 0x00, 0x00, 0x00, // Reserved + Stream Identifier
  0x00, 0x00, 0x00,       // Payload
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
const goawayFrame = getGoawayFrame({
  lastStreamID: 0,
  errorCode: ERROR_CODES.FRAME_SIZE_ERROR,
});
assert(maybeGoawayFrame.equals(goawayFrame));
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});

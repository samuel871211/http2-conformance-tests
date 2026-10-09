import http2 from "http2";
import net from "net";
import { serverOption } from "../server-option.js";
import {
  ERROR_CODES,
  getGoawayFrame,
  http2ConnectionPreface,
} from "../utils.js";
import { onceData } from "../utils.js";
import assert from "assert";
import { getFileName } from "../utils.js";

const fileName = getFileName(import.meta.filename);
const { host, port } = serverOption;

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
http2Server.listen(port);

const socket = net.connect({
  host,
  port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
// prettier-ignore
const settingsFrame = Buffer.from([
  0x00, 0x00, 0x07,                         // Length
  0x04,                                     // Type
  0x00,                                     // Flags
  0x00, 0x00, 0x00, 0x00,                   // Reserved + Stream Identifier
  0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, // Payload
]);
socket.write(settingsFrame);
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

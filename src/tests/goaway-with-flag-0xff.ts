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
const { host, port } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-4.1",
      description: `
        Unused flags MUST be ignored on receipt and MUST be left unset
        (0x00) when sending.
      `,
    },
  ],
};

const http2Server = http2.createServer();
http2Server.listen(port);
// prettier-ignore
const invalidGoawayFrame = Buffer.from([
  0x00, 0x00, 0x08,       // Length
  0x07,                   // Type
  0xFF,                   // Flags
  0x00, 0x00, 0x00, 0x00, // Reserved + Stream Identifier
  0x00, 0x00, 0x00, 0x00, // Reserved + Last-Stream-ID
  0x00, 0x00, 0x00, 0x00, // Error Code
]);
const socket = net.connect({
  host,
  port,
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
  errorCode: ERROR_CODES.NO_ERROR,
});
// 不知道為何 Node.js 會送兩個 goaway frame
const goawayFrameNodejs = Buffer.concat([goawayFrame, goawayFrame]);
assert(
  maybeGoawayFrame.equals(goawayFrameNodejs) ||
    maybeGoawayFrame.equals(goawayFrame),
);
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});

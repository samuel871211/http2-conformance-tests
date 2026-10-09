import http2 from "http2";
import net from "net";
import {
  ERROR_CODES,
  getGoawayFrame,
  http2ConnectionPreface,
} from "../utils.js";
import { onceData } from "../utils.js";
import { serverOption } from "../server-option.js";
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
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.2",
      description: `
        The total number of padding octets is determined by the value of the
        Pad Length field. If the length of the padding is the length of the
        frame payload or greater, the recipient MUST treat this as a
        connection error (Section 5.4.1) of type PROTOCOL_ERROR.
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
const headersFrame = Buffer.from([
  0x00, 0x00, 0x00,       // Length
  0x01,                   // Type
  0x08,                   // Flags
  0x00, 0x00, 0x00, 0x01, // Reserved + Stream Identifier
]);
socket.write(headersFrame);
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not close the TCP connection`);
  process.exit(1);
});
const maybeGoawayFrame = await onceData(socket);
const goawayFrameNgHttp2 = getGoawayFrame({
  lastStreamID: 0,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
  additionalDebugData: Buffer.from(
    "HEADERS: insufficient padding space",
    "utf8",
  ),
});
const goawayFrame2 = getGoawayFrame({
  lastStreamID: 0,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
});
assert(
  maybeGoawayFrame.equals(goawayFrameNgHttp2) ||
    maybeGoawayFrame.equals(goawayFrame2),
);
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});

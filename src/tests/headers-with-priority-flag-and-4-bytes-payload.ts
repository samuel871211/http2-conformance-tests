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
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-4.2",
      description: `
        An endpoint MUST send an error code of FRAME_SIZE_ERROR if a frame
        exceeds the size defined in SETTINGS_MAX_FRAME_SIZE, exceeds any limit
        defined for the frame type, or is too small to contain mandatory frame
        data.
      `,
    },
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.2",
      description: `
        Exclusive (E), Stream Dependency (31 bits), Weight (8 bits): Priority
        fields. Only present if the PRIORITY flag is set.
      `,
    },
  ],
};

if (enableNodejsHttp2Server) {
  const http2Server = http2.createServer();
  http2Server.listen(port);
  http2Server.on("stream", () =>
    assert(false, `Should not trigger http2Server.on("stream")`),
  );
}

const socket = net.connect({
  host,
  port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
// PRIORITY flag 需要 5 bytes（Exclusive + Stream Dependency + Weight），這裡只給 4 bytes
// prettier-ignore
const invalidHeadersFrame = Buffer.from([
  0x00, 0x00, 0x04,       // Length
  0x01,                   // Type
  0x24,                   // Flags (PRIORITY + END_HEADERS)
  0x00, 0x00, 0x00, 0x01, // Reserved + Stream Identifier
  0x00, 0x00, 0x00, 0x00, // Exclusive + Stream Dependency (Weight is missing)
]);
await writeAsync(socket, invalidHeadersFrame);
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not close the TCP connection`);
  process.exit(1);
});
const maybeGoawayFrame = await readHttp2Frame(socket);
const goawayFrame = getGoawayFrame({
  lastStreamID: 0,
  errorCode: ERROR_CODES.FRAME_SIZE_ERROR,
});
assert(maybeGoawayFrame.raw.equals(goawayFrame));
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});

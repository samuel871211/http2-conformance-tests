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
        Receipt of a SETTINGS frame with the ACK flag set and a length field
        value other than 0 MUST be treated as a connection error (Section
        5.4.1) of type FRAME_SIZE_ERROR.
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
// 6 bytes 剛好是一組合法的 SETTINGS parameter，排除「payload 不是 6 的倍數」造成的錯誤
// prettier-ignore
const invalidSettingsFrame = Buffer.from([
  0x00, 0x00, 0x06,       // Length
  0x04,                   // Type
  0x01,                   // Flags (ACK)
  0x00, 0x00, 0x00, 0x00, // Reserved + Stream Identifier
  0x00, 0x02,             // Identifier (SETTINGS_ENABLE_PUSH)
  0x00, 0x00, 0x00, 0x00, // Value
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
  errorCode: ERROR_CODES.FRAME_SIZE_ERROR,
});
assert(maybeGoawayFrame.raw.equals(goawayFrame));
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});

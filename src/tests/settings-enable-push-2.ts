import http2 from "http2";
import net from "net";
import assert from "assert";
import { serverOption } from "../server-option.js";
import {
  getGoawayFrame,
  getSettingsFrame,
  http2ConnectionPreface,
  ERROR_CODES,
  readHttp2Frame,
  getFileName,
} from "../utils.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.5.2",
      description: `
        SETTINGS_ENABLE_PUSH (0x02):  This setting can be used to enable or
        disable server push.  [...] The initial value is 1, which indicates
        that server push is permitted.  Any value other than 0 or 1 MUST be
        treated as a connection error (Section 5.4.1) of type PROTOCOL_ERROR.
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
const settingsFrame = getSettingsFrame({ SETTINGS_ENABLE_PUSH: 2 });
socket.write(settingsFrame);
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
  additionalDebugData: Buffer.from(
    "SETTINGS: invalid SETTINGS_ENBLE_PUSH",
    "utf8",
  ),
});
assert(
  maybeGoawayFrame.raw.equals(goawayFrame) ||
    maybeGoawayFrame.raw.equals(goawayFrameNghttp2),
);
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});

import http2 from "http2";
import net from "net";
import assert from "assert";
import { serverOption } from "../server-option.js";
import {
  getWindowUpdateFrame,
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
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.9.1",
      description: `
        A sender MUST NOT allow a flow-control window to exceed 2^31-1
        octets.  If a sender receives a WINDOW_UPDATE that causes a
        flow-control window to exceed this maximum, it MUST terminate either
        the stream or the connection, as appropriate.  For streams, the
        sender sends a RST_STREAM with an error code of FLOW_CONTROL_ERROR;
        for the connection, a GOAWAY frame with an error code of
        FLOW_CONTROL_ERROR is sent.
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
// connection window 初始值 65535，加上 2^31 - 1 會超過上限
const windowUpdateFrame = getWindowUpdateFrame({
  streamID: 0,
  windowSizeIncrement: 2 ** 31 - 1,
});
await writeAsync(socket, windowUpdateFrame);
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not close the TCP connection`);
  process.exit(1);
});
const maybeGoawayFrame = await readHttp2Frame(socket);
const goawayFrame = getGoawayFrame({
  lastStreamID: 0,
  errorCode: ERROR_CODES.FLOW_CONTROL_ERROR,
});
assert(maybeGoawayFrame.raw.equals(goawayFrame));
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});

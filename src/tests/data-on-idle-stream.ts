import http2 from "http2";
import net from "net";
import assert from "assert";
import { serverOption } from "../server-option.js";
import {
  getDataFrame,
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
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-5.1",
      description: `
        Receiving any frame other than HEADERS or PRIORITY on a stream in
        this state MUST be treated as a connection error (Section 5.4.1)
        of type PROTOCOL_ERROR.
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
// stream 1 從未開啟過，處於 idle 狀態
const dataFrame = getDataFrame({
  streamID: 1,
  flags: 0,
  data: Buffer.alloc(1),
});
await writeAsync(socket, dataFrame);
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not close the TCP connection`);
  process.exit(1);
});
const maybeGoawayFrame = await readHttp2Frame(socket);
const goawayFrameNghttp2 = getGoawayFrame({
  lastStreamID: 0,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
  additionalDebugData: Buffer.from("DATA: stream in idle"),
});
assert(maybeGoawayFrame.raw.equals(goawayFrameNghttp2));
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});

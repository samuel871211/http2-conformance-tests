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

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.8",
      description: `
        The last stream identifier in the GOAWAY frame contains the
        highest-numbered stream identifier for which the sender of the GOAWAY
        frame might have taken some action on or might yet take action on.
      `,
    },
  ],
};

const http2Server = http2.createServer();
http2Server.listen(serverOption.port);
const goawayFrame1 = getGoawayFrame({
  lastStreamID: 1,
  errorCode: ERROR_CODES.NO_ERROR,
});
const socket = net.connect({
  host: serverOption.host,
  port: serverOption.port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
socket.write(goawayFrame1);
const maybeGoawayFrame = await onceData(socket);
const goawayFrame2 = getGoawayFrame({
  lastStreamID: 0,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
  additionalDebugData: Buffer.from("GOAWAY: invalid last_stream_id", "utf8"),
});
const goawayFrameNghttp2 = getGoawayFrame({
  lastStreamID: 0,
  errorCode: ERROR_CODES.PROTOCOL_ERROR,
  additionalDebugData: Buffer.from("GOAWAY: invalid last_stream_id", "utf8"),
});
assert(
  maybeGoawayFrame.equals(goawayFrameNghttp2) ||
    maybeGoawayFrame.equals(goawayFrame2),
);
socket.on("close", () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});

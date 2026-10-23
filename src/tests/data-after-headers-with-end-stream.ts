import http2 from "http2";
import net from "net";
import assert from "assert";
import { serverOption } from "../server-option.js";
import {
  encodeIntegerRFC7541,
  encodeStringLiteralsRFC7541,
  getHeadersFrame,
  http2ConnectionPreface,
  getDataFrame,
  getRSTFrame,
  writeAsync,
  ERROR_CODES,
  getFileName,
  readHttp2Frame,
  getGoawayFrame,
} from "../utils.js";

const fileName = getFileName(import.meta.filename);
const { host, port, enableNodejsHttp2Server } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-5.1",
      description: `
        If an endpoint receives additional frames, other than WINDOW_UPDATE,
        PRIORITY, or RST_STREAM, for a stream that is in this state, it MUST
        respond with a stream error (Section 5.4.2) of type STREAM_CLOSED.
      `,
    },
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-5.4.2",
      description: `
        An endpoint MAY choose to treat a stream error as a connection error.
      `,
    },
  ],
};

if (enableNodejsHttp2Server) {
  const http2Server = http2.createServer();
  http2Server.listen(port);
  http2Server.on("stream", (stream) => stream.on("error", () => {}));
}

const socket = net.connect({
  host,
  port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
// END_HEADERS + END_STREAM，stream 1 進入 half-closed (remote)
const headersFrame = getHeadersFrame({
  streamID: 1,
  flags: 5,
  fieldBlockFragment: Buffer.concat([
    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: `${host}:${port}` }),
  ]),
});
const dataFrame = getDataFrame({
  streamID: 1,
  flags: 0,
  data: Buffer.alloc(1),
});
await writeAsync(socket, Buffer.concat([headersFrame, dataFrame]));
// 確保不符合規範的 server 可以正確被偵測
socket.setTimeout(5000, () => {
  console.log(`${fileName}: server does not send RST_STREAM`);
  process.exit(1);
});
if (enableNodejsHttp2Server) {
  const maybeGoawayFrame = await readHttp2Frame(socket);
  const goawayFrame = getGoawayFrame({
    lastStreamID: 1,
    errorCode: ERROR_CODES.STREAM_CLOSED,
    additionalDebugData: Buffer.from(
      "DATA: stream in half-closed(remote)",
      "latin1",
    ),
  });
  assert(maybeGoawayFrame.raw.equals(goawayFrame));
  socket.on("close", () => {
    console.log(`${fileName}: ok`);
    process.exit(0);
  });
} else {
  const maybeRstFrame = await readHttp2Frame(socket);
  const rstFrame = getRSTFrame({
    streamID: 1,
    errorCode: ERROR_CODES.STREAM_CLOSED,
  });
  assert(maybeRstFrame.raw.equals(rstFrame));
  console.log(`${fileName}: ok`);
  process.exit(0);
}

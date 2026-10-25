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
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.7",
      description: `
        ACK (0x01):  When set, the ACK flag indicates that this PING frame is
        a PING response.  An endpoint MUST set this flag in PING responses.
        An endpoint MUST NOT respond to PING frames containing this flag.
      `,
    },
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-5.4.1",
      description: `
        An endpoint can end a connection at any time. [...] Endpoints SHOULD
        send a GOAWAY frame when ending a connection, providing that
        circumstances permit it.
      `,
    },
  ],
  sourceCode: [
    {
      repo: "https://github.com/nodejs/node",
      code: `
        // PING Ack is unsolicited. Treat as a connection error. The HTTP/2
        // spec does not require this, but there is no legitimate reason to
        // receive an unsolicited PING ack on a connection.
        arg = Integer::New(isolate, NGHTTP2_ERR_PROTO);
        MakeCallback(env()->http2session_on_error_function(), 1, &arg);
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
// prettier-ignore
const invalidPingFrame = Buffer.from([
  0x00, 0x00, 0x08,       // Length
  0x06,                   // Type
  0x01,                   // Flags (ACK)
  0x00, 0x00, 0x00, 0x00, // Reserved + Stream Identifier
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, // Opaque Data
]);
await writeAsync(socket, invalidPingFrame);
if (enableNodejsHttp2Server) {
  // Node.js 會把沒有對應 PING 的 ACK 視為 connection error，這不違反 RFC
  // 因為 GOAWAY 不是對 PING 的回應，且 endpoint 可以隨時結束連線
  socket.setTimeout(5000, () => {
    console.log(`${fileName}: server does not close the TCP connection`);
    process.exit(1);
  });
  const maybeGoawayFrame = await readHttp2Frame(socket);
  const goawayFrame = getGoawayFrame({
    lastStreamID: 0,
    errorCode: ERROR_CODES.INTERNAL_ERROR,
  });
  assert(maybeGoawayFrame.raw.equals(goawayFrame));
  socket.on("close", () => {
    console.log(`${fileName}: ok`);
    process.exit(0);
  });
} else {
  // 3 秒內沒有收到任何 frame 就視為通過
  socket.setTimeout(3000, () => {
    console.log(`${fileName}: ok`);
    process.exit(0);
  });
  const unexpectedHttp2Frame = await readHttp2Frame(socket);
  console.log(
    `${fileName}: server sends frame (type ${unexpectedHttp2Frame.type}) after receiving PING frame with ACK flag`,
  );
  process.exit(1);
}

import http2 from "http2";
import net from "net";
import {
  encodeIntegerRFC7541,
  getHeadersFrame,
  http2ConnectionPreface,
} from "../utils.js";
import { getFileName } from "../utils.js";
import { serverOption } from "../server-option.js";

const fileName = getFileName(import.meta.filename);
const { host, port } = serverOption;

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.2",
      description: `
        However, a HEADERS frame with the END_STREAM flag set can be followed
        by CONTINUATION frames on the same stream.
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
const headersFrame = getHeadersFrame({
  streamID: 1,
  flags: 1,
  fieldBlockFragment: encodeIntegerRFC7541({
    prefix: "001",
    integer: 0,
  }),
});
socket.write(headersFrame);
// 沒有 followed by CONTINUATION frame
// server 會持續等待
socket.once("data", (chunk) => {
  console.log(`${fileName}: failed`);
  process.exit(1);
});
socket.setTimeout(5000, () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});

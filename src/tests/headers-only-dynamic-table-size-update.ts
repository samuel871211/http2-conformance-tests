import http2 from "http2";
import net from "net";
import {
  encodeIntegerRFC7541,
  getHeadersFrame,
  http2ConnectionPreface,
} from "../utils.js";
import { getFileName } from "../utils.js";
import assert from "assert";
import { serverOption } from "../server-option.js";

const fileName = getFileName(import.meta.filename);

const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-6.2",
      description: `
        A HEADERS frame without the END_HEADERS flag set MUST be followed by
        a CONTINUATION frame for the same stream.
      `,
    },
  ],
};

const http2Server = http2.createServer();
http2Server.listen(serverOption.port);

const socket = net.connect({
  host: serverOption.host,
  port: serverOption.port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
const headersFrame = getHeadersFrame({
  streamID: 1,
  flags: 0,
  fieldBlockFragment: encodeIntegerRFC7541({
    prefix: "001",
    integer: 0,
  }),
});
socket.write(headersFrame);
socket.once("data", () => assert(false));
socket.on("close", () => assert(false));
socket.setTimeout(5000, () => {
  console.log(`${fileName}: ok`);
  process.exit(0);
});

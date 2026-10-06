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
} from "../utils.js";
import { writeAsync } from "../utils.js";
import { getFileName } from "../utils.js";

const fileName = getFileName(import.meta.filename);

const config = {
  rfc: [],
};

const http2Server = http2.createServer();
http2Server.listen(serverOption.port);
http2Server.on("request", (req, res) => {
  req.on("data", (chunk) => {
    assert(typeof chunk !== "string" && chunk.equals(Buffer.from([0x00])));
    console.log(`${fileName}: ok`);
    process.exit(0);
  });
});

const socket = net.connect({
  host: serverOption.host,
  port: serverOption.port,
  allowHalfOpen: false,
});
await http2ConnectionPreface(socket);
const headersFrame = getHeadersFrame({
  streamID: 1,
  flags: 4,
  fieldBlockFragment: Buffer.concat([
    encodeIntegerRFC7541({ prefix: "1", integer: 2 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 4 }),
    encodeIntegerRFC7541({ prefix: "1", integer: 6 }),

    encodeIntegerRFC7541({ prefix: "0001", integer: 1 }),
    encodeStringLiteralsRFC7541({ string: "localhost:8080" }),
  ]),
});
const dataFrame0 = getDataFrame({
  streamID: 1,
  flags: 0,
  data: Buffer.alloc(0),
});
const dataFrame1 = getDataFrame({
  streamID: 1,
  flags: 1,
  data: Buffer.alloc(1),
});
await writeAsync(socket, Buffer.concat([headersFrame, dataFrame0, dataFrame1]));

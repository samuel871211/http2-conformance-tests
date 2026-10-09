- 你是一名 HTTP/2 黑箱測試專家，專門針對 RFC 規範，找出各種 Edge Case 測試
- `src/utils.ts` 禁止直接修改（如需修改，請先停下與我討論）
- 如需構造正常的 HTTP/2 frame，請使用 `src/utils.ts` 提供的 util function
- 如需構造異常的 HTTP/2 frame，請使用以下寫法（變數必須為 invalid 開頭），提升可讀性
  ```js
  // prettier-ignore
  const invalidHeadersFrame = Buffer.from([
    0x00, 0x00, 0x00,       // Length
    0x01,                   // Type
    0x05,                   // Flags (END_STREAM + END_HEADERS)
    0x00, 0x00, 0x00, 0x01, // Reserved + Stream Identifier
    0x01,                   // Payload
  ]);
  ```
- 每個測試都需引用對應的 RFC 規範（可為 0 ~ N 個），範例如下
  ```js
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
  ```
- server 標準起手式
  ```js
  const http2Server = http2.createServer();
  http2Server.listen(port);
  ```
- 承上，有需要測試 server 有無觸發對應的 event
  - 寫法可參考：[data-with-0-byte-payload.ts](./data-with-0-byte-payload.ts)
  - 官方文件：https://nodejs.org/docs/latest-v24.x/api/http2.html
- 如測試案例會導致 server 發送 GOAWAY，則標準寫法為

  ```js
  const socket = net.connect({
    host,
    port,
    allowHalfOpen: false,
  });
  // your test here...

  // 確保不符合規範的 server 可以正確被偵測
  socket.setTimeout(5000, () => {
    console.log(`${fileName}: server does not close the TCP connection`);
    process.exit(1);
  });
  // 驗證有收到 goawayFrame
  const maybeGoawayFrame = await onceData(socket);
  const goawayFrame = getGoawayFrame(...);
  assert(maybeGoawayFrame.equals(goawayFrame));
  // 驗證 server 有正確發送 FIN 或 RST
  socket.on("close", () => {
    console.log(`${fileName}: ok`);
    process.exit(0);
  });
  ```

- 如果沒有要針對 [HTTP/2 Connection Preface](https://datatracker.ietf.org/doc/html/rfc9113#section-3.4) 階段做測試，則一律使用
  ```js
  await http2ConnectionPreface(socket);
  ```

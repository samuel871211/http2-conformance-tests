const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-3.4",
      description: `
        To avoid unnecessary latency, clients are permitted to send
        additional frames to the server immediately after sending the client
        connection preface, without waiting to receive the server connection
        preface.
      `,
    },
  ],
};

// todo-yus

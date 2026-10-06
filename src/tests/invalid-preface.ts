const config = {
  rfc: [
    {
      url: "https://datatracker.ietf.org/doc/html/rfc9113#section-3.4",
      description: `
        Clients and servers MUST treat an invalid connection preface as a
        connection error (Section 5.4.1) of type PROTOCOL_ERROR.
      `,
    },
  ],
};

// todo-yus connection preface 有很多情境可以玩

// inside of async init() { ... }
this.server.tool(
  "generate_random_number",
  "Generates a random number between two numbers",
  { min: z.number(), max: z.number() },
  async ({ min, max }) => ({
    content: [
      {
        type: "text",
        text: String(Math.floor(Math.random() * (max - min + 1)) + min),
      },
    ],
  }),
);
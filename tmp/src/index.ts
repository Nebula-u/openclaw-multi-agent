import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

export default defineToolPlugin({
  id: "stategraph-intake-bridge",
  name: "Stategraph Intake Bridge",
  description: "Add Stategraph Intake Bridge tools to OpenClaw.",
  tools: (tool) => [
    tool({
      name: "echo",
      description: "Echo input text.",
      parameters: Type.Object({
        input: Type.String({ description: "Text to echo." }),
      }),
      execute: async ({ input }) => ({ input }),
    }),
  ],
});

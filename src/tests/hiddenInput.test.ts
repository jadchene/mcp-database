import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { readHiddenLine } from "../core/hiddenInput.js";

test("hidden input reads a piped password without echoing it", async () => {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += String(chunk);
  });

  input.end("private-password\n");
  const password = await readHiddenLine("Password: ", input, output);

  assert.equal(password, "private-password");
  assert.equal(rendered.includes("private-password"), false);
  assert.equal(rendered, "Password: \n");
});

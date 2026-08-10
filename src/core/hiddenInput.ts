export async function readHiddenLine(
  prompt: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr
): Promise<string> {
  output.write(prompt);

  if (!input.isTTY || typeof input.setRawMode !== "function") {
    let value = "";
    input.setEncoding("utf8");
    for await (const chunk of input) {
      value += chunk;
      if (value.length > 4096) {
        throw new Error("Hidden input is too long");
      }
    }
    output.write("\n");
    return firstLine(value);
  }

  return new Promise<string>((resolve, reject) => {
    let value = "";

    const cleanup = (): void => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
    };

    const onData = (chunk: Buffer | string): void => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Authorization request cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u0008" || character === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " " && value.length < 1024) {
          value += character;
        }
      }
    };

    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

function firstLine(value: string): string {
  const newlineIndex = value.search(/[\r\n]/);
  return newlineIndex >= 0 ? value.slice(0, newlineIndex) : value;
}

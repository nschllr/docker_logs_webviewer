function splitTimestamp(text) {
  const firstSpace = text.indexOf(" ");
  if (firstSpace === -1) {
    return { timestamp: "", message: text };
  }

  return {
    timestamp: text.slice(0, firstSpace),
    message: text.slice(firstSpace + 1)
  };
}

export function createLineEmitter(onLine) {
  const pending = new Map();

  function flushStream(stream) {
    const current = pending.get(stream);
    if (current) {
      const parts = splitTimestamp(current);
      onLine({ stream, ...parts });
      pending.delete(stream);
    }
  }

  return {
    push(stream, text) {
      const existing = pending.get(stream) || "";
      const combined = existing + text;
      const lines = combined.split(/\r?\n/);
      pending.set(stream, lines.pop() || "");

      for (const line of lines) {
        const parts = splitTimestamp(line);
        onLine({ stream, ...parts });
      }
    },
    flush() {
      for (const stream of pending.keys()) {
        flushStream(stream);
      }
    }
  };
}

export function createDockerLogDecoder({ tty, onFrame }) {
  let buffer = Buffer.alloc(0);

  return {
    write(chunk) {
      if (tty) {
        onFrame("stdout", chunk.toString("utf8"));
        return;
      }

      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const frameLength = buffer.readUInt32BE(4);
        if (buffer.length < 8 + frameLength) {
          return;
        }

        const streamCode = buffer[0];
        const payload = buffer.subarray(8, 8 + frameLength).toString("utf8");
        const stream = streamCode === 2 ? "stderr" : "stdout";
        onFrame(stream, payload);
        buffer = buffer.subarray(8 + frameLength);
      }
    },
    flush() {
      if (tty && buffer.length > 0) {
        onFrame("stdout", buffer.toString("utf8"));
      }
    }
  };
}

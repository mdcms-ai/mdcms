import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { format } from "node:util";

const MAX_DIAGNOSTIC_LINE = 64 * 1024;

/** Reserve the original stdout writer for the transport before evaluating config. */
export function installMcpOutputRouting(options: {
  stdout?: Writable;
  stderr?: Writable;
  destination?: { write: (text: string) => unknown };
  secrets: Array<string | undefined>;
}) {
  const stdout: Writable = options.stdout ?? process.stdout;
  const stderr: Writable = options.stderr ?? process.stderr;
  const originalOut = stdout.write;
  const originalErr = stderr.write;
  const originalConsole = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };
  const secrets = new Set(
    options.secrets.filter((value): value is string => Boolean(value)),
  );
  const redact = (text: string) => {
    text = text
      .replace(/\bBearer\s+[^\s"'<>`,;)}\]]+/gi, "Bearer [redacted]")
      .replace(/\bmdcms_[A-Za-z0-9._~+/=-]+/g, "[redacted]");
    // A shorter known credential must not hide the prefix of a longer one,
    // or remove a generic token marker before it can be recognized.
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      text = text.split(secret).join("[redacted]");
    }
    return text;
  };
  const writeDiagnostic = (
    text: string,
    callback: (error?: Error | null) => void,
  ) => {
    if (!text) {
      callback();
      return;
    }
    if (options.destination && options.destination !== stderr) {
      try {
        options.destination.write(text);
        callback();
      } catch (error) {
        callback(
          error instanceof Error
            ? error
            : new Error("Diagnostic output failed"),
        );
      }
    } else {
      originalErr.call(stderr, text, "utf8", callback);
    }
  };
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let discarding = false;
  function consume(text: string, final = false) {
    let output = "";
    for (const [index, part] of text.split("\n").entries()) {
      if (index > 0) {
        if (!discarding) output += redact(pending) + "\n";
        pending = "";
        discarding = false;
      }
      if (discarding) continue;
      if (pending.length + part.length > MAX_DIAGNOSTIC_LINE) {
        pending = "";
        discarding = true;
        output += "[oversized diagnostic omitted]\n";
      } else pending += part;
    }
    if (final && pending) {
      output += redact(pending);
      pending = "";
    }
    return output;
  }
  // Buffer complete diagnostic records so a credential split across writes is
  // never emitted in fragments. Oversized records are discarded, not truncated.
  const diagnostics = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      writeDiagnostic(consume(decoder.write(chunk)), callback);
    },
    final(callback) {
      writeDiagnostic(consume(decoder.end(), true), callback);
    },
  });
  const protocolOutput = new Writable({
    write(chunk, encoding, callback) {
      originalOut.call(stdout, chunk, encoding, callback);
    },
  });
  let diagnosticFailure: Error | undefined;
  let protocolFailure: Error | undefined;
  diagnostics.on("error", (error) => {
    diagnosticFailure = error;
  });
  protocolOutput.on("error", (error) => {
    protocolFailure = error;
  });
  const drain = () => {
    stdout.emit("drain");
    stderr.emit("drain");
  };
  diagnostics.on("drain", drain);
  stdout.write = diagnostics.write.bind(diagnostics);
  stderr.write = diagnostics.write.bind(diagnostics);
  const log = (...args: unknown[]) => {
    diagnostics.write(`${format(...args)}\n`);
  };
  console.log =
    console.info =
    console.debug =
    console.warn =
    console.error =
      log;
  let restored = false;
  return {
    protocolOutput,
    diagnostics,
    addSecret(secret: string | undefined) {
      if (secret) secrets.add(secret);
    },
    async restore() {
      if (restored) return;
      restored = true;
      try {
        await Promise.all([
          new Promise<void>((resolve) => diagnostics.end(resolve)),
          new Promise<void>((resolve) => protocolOutput.end(resolve)),
        ]);
      } finally {
        stdout.write = originalOut;
        stderr.write = originalErr;
        Object.assign(console, originalConsole);
        diagnostics.off("drain", drain);
      }
      if (diagnosticFailure || protocolFailure)
        throw new Error("MCP output stream failed");
    },
  };
}

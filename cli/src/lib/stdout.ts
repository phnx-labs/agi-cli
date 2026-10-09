/**
 * Write to stdout and resolve once Node has handed every byte to the OS.
 *
 * On a pipe (an ssh channel, `| jq`) stdout writes are asynchronous, so a
 * `process.exit()` right after `process.stdout.write()` drops whatever is still
 * queued: a 200 KB fleet-state reply arrived over ssh cut at exactly 65,536
 * bytes. Await this before exiting whenever a caller parses the output.
 */
export function writeStdoutFlushed(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (err) => (err ? reject(err) : resolve()));
  });
}

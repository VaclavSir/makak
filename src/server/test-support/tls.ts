import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execChecked, exec } from "../tools/exec.ts";

/** A throwaway self-signed certificate for tests. Clients skip verification. */
export const selfSignedCert = async (
  hostname: string
): Promise<{ cert: Buffer; key: Buffer }> => {
  const dir = await mkdtemp(path.join(tmpdir(), "makak-tls-"));
  try {
    const cert = path.join(dir, "cert.pem");
    const key = path.join(dir, "key.pem");
    await execChecked(exec, "openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${hostname}`,
      "-keyout",
      key,
      "-out",
      cert,
    ]);
    return { cert: await readFile(cert), key: await readFile(key) };
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

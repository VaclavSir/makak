import { STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";

/** Answers a WebSocket handshake that won't go through, and closes the socket. */
export const refuseUpgrade = (
  socket: Duplex,
  status: number,
  message?: string
): void => {
  const body = message === undefined ? "" : `${message}\n`;
  const type = body === "" ? "" : "Content-Type: text/plain; charset=utf-8\r\n";
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\n${type}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
};

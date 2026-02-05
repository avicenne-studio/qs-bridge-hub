import { createServer, type RequestListener, type Server } from "node:http";
import { Socket } from "node:net";

export type TrackedServer = {
  server: Server;
  close: () => Promise<void>;
};

export function createTrackedServer(handler: RequestListener): TrackedServer {
  const server = createServer(handler);
  const sockets = new Set<Socket>();

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

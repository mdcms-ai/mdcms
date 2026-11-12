import net from "node:net";
const sockets = [];
try {
  for (let i = 0; i < 7; i++) {
    const socket = net.createServer();
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(0, "127.0.0.1", resolve);
    });
  }
  console.log(sockets.map((socket) => socket.address().port).join("\n"));
} finally {
  for (const socket of sockets) socket.close();
}

/**
 * WebSocket ping/pong heartbeat helpers.
 *
 * Extracted from server.js so tests can import pruneDeadClients without
 * booting the HTTP/WS server.
 */

/**
 * Prune dead WebSocket clients using the ping/pong aliveness flag.
 *
 * On every heartbeat tick the server calls this with `wss.clients`.  Any
 * client whose `isAlive` flag is still `false` from the previous sweep is
 * terminated (firing its existing `close` handler → existing cleanup /
 * `maybeTeardown`).  Live clients have their flag reset to `false` and
 * receive a ping; if they respond with a pong the `pong` handler in
 * server.js sets `isAlive = true` before the next sweep.
 *
 * New connections set `isAlive = true` on creation, so they are never
 * terminated on the very first sweep.
 *
 * @param {Iterable<{isAlive:boolean,terminate:()=>void,ping:()=>void}>} clients
 */
export function pruneDeadClients(clients) {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      ws.terminate();
    } else {
      ws.isAlive = false;
      ws.ping();
    }
  }
}

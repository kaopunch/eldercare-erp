/**
 * Live tracking hub (spec C4) — WebSocket push to the family while a job runs.
 * Path: /ws/care/track/:bookingId?token=<access JWT> — customer who owns the
 * booking only. Server -> client messages:
 *   {type:'location', lat, lng, recorded_at}
 *   {type:'event', event_type, actor, payload, created_at}
 *   {type:'status', status}
 * Caregiver pings arrive over REST (POST /jobs/:id/location) and are fanned
 * out here — one WS direction keeps the surface small (DECISIONS.md M4).
 */
const { WebSocketServer } = require('ws');
const { verifyAccessToken } = require('../shared/crypto');

const TRACK_PATH = /^\/ws\/care\/track\/([0-9a-f-]{36})$/;

/** bookingId -> Set<ws> */
const channels = new Map();

function subscribe(bookingId, socket) {
  if (!channels.has(bookingId)) channels.set(bookingId, new Set());
  channels.get(bookingId).add(socket);
  socket.on('close', () => {
    const set = channels.get(bookingId);
    if (set) {
      set.delete(socket);
      if (!set.size) channels.delete(bookingId);
    }
  });
}

/** Fan a payload out to everyone watching a booking. Safe to call when no one is. */
function publish(bookingId, payload) {
  const set = channels.get(bookingId);
  if (!set) return;
  const message = JSON.stringify(payload);
  for (const socket of set) {
    if (socket.readyState === socket.OPEN) socket.send(message);
  }
}

/**
 * Attach to the HTTP server returned by app.listen().
 * findBookingById is injected to avoid a circular import with the repository.
 */
function attachTrackingHub(server, { findBookingById }) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    const match = url.pathname.match(TRACK_PATH);
    if (!match) return; // not ours — leave for other upgrade handlers

    try {
      const payload = verifyAccessToken(url.searchParams.get('token'));
      const booking = await findBookingById(match[1]);
      const allowed =
        booking &&
        ((payload.role === 'customer' && booking.customer_user_id === payload.sub) ||
          (payload.role === 'caregiver' && booking.caregiver_user_id === payload.sub));
      if (!allowed) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (clientSocket) => {
        subscribe(match[1], clientSocket);
        clientSocket.send(JSON.stringify({ type: 'status', status: booking.status }));
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });

  return { publish };
}

module.exports = { attachTrackingHub, publish };

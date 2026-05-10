const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(200);

function publishRealtimeEvent(event) {
  if (!event) return;
  bus.emit('realtime_event', {
    ...event,
    streamed_at: new Date().toISOString()
  });
}

function subscribeRealtimeEvents(listener) {
  bus.on('realtime_event', listener);
  return () => bus.off('realtime_event', listener);
}

module.exports = {
  publishRealtimeEvent,
  subscribeRealtimeEvents
};

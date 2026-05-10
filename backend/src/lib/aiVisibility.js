const ADMIN_ROLES = new Set(['owner', 'admin', 'dispatcher']);

function normalizeRole(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function roleAliases(role) {
  const normalized = normalizeRole(role);
  const aliases = new Set([normalized]);
  if (normalized === 'driver') aliases.add('contractor');
  if (normalized === 'care_assistant') aliases.add('contractor');
  if (normalized === 'admin' || normalized === 'owner' || normalized === 'dispatcher') aliases.add('admin');
  return aliases;
}

function payloadOf(event = {}) {
  return event.event_payload || event.payload || {};
}

function recipientRoles(event = {}) {
  const payload = payloadOf(event);
  const values = [
    event.recipient_role,
    event.to_role,
    payload.recipient_role,
    payload.to_role,
    payload.party_role,
    payload.role
  ];
  if (Array.isArray(payload.recipient_roles)) values.push(...payload.recipient_roles);
  return values.map(normalizeRole).filter(Boolean);
}

function eventVisibleToActor(event = {}, actor = {}, options = {}) {
  const actorRole = normalizeRole(actor.role);
  if (ADMIN_ROLES.has(actorRole)) return true;
  if (!actorRole) return false;

  if (actor.id && event.actor_user_id && event.actor_user_id === actor.id) return true;

  const aliases = roleAliases(actorRole);
  const recipients = recipientRoles(event);
  if (recipients.some((role) => aliases.has(role))) return true;

  const bookingIds = options.bookingIds || new Set();
  const hasAssignedBooking = event.booking_id && bookingIds.has(event.booking_id);
  return Boolean(hasAssignedBooking && recipients.length && recipients.some((role) => aliases.has(role)));
}

module.exports = {
  ADMIN_ROLES,
  eventVisibleToActor,
  normalizeRole,
  recipientRoles,
  roleAliases
};

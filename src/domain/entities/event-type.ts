/**
 * Event type classification enum
 *
 * Defines the three types of events based on attendance mode:
 * - OFFLINE: In-person events only (physical venue)
 * - ONLINE: Virtual events only (online platforms)
 * - HYBRID: Events offering both in-person and online options
 */
export enum EventType {
  OFFLINE = 'offline',
  ONLINE = 'online',
  HYBRID = 'hybrid',
}

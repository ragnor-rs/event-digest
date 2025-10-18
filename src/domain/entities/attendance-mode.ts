/**
 * Attendance mode classification enum
 *
 * Defines how attendees can participate in an event:
 * - OFFLINE: In-person attendance only (physical venue)
 * - ONLINE: Virtual attendance only (online platforms)
 * - HYBRID: Both in-person and online attendance options available
 */
export enum AttendanceMode {
  OFFLINE = 'offline',
  ONLINE = 'online',
  HYBRID = 'hybrid',
}

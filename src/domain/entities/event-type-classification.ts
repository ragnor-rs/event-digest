import { AttendanceMode } from './attendance-mode';

export interface EventTypeClassification {
  type: AttendanceMode;
  confidence: number;
}

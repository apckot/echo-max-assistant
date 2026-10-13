import type { UserId } from '../../../shared/types/identity.js';
export type TaskId = string;
export type TaskStatus = 'open' | 'completed' | 'cancelled';
export interface Task {
 readonly id: TaskId; readonly userId: UserId; readonly title: string; readonly description: string | null;
 readonly status: TaskStatus; readonly targetDate: string | null; readonly scheduledAt: string | null;
 readonly dueDate: string | null; readonly dueAt: string | null; readonly timezone: string; readonly version: number;
 readonly createdAt: string; readonly updatedAt: string; readonly completedAt: string | null; readonly cancelledAt: string | null;
}
export type TaskErrorCode = 'invalid_command' | 'invalid_title' | 'invalid_description' | 'invalid_time' |
 'invalid_timezone' | 'ambiguous_local_time' | 'nonexistent_local_time' | 'invalid_schedule' |
 'invalid_evidence' | 'unsupported_actor' | 'task_not_found' | 'version_conflict' | 'invalid_transition' |
 'idempotency_conflict' | 'invalid_local_reference' | 'group_limit_exceeded' | 'version_exhausted' | 'account_unavailable';
export interface TaskError { readonly code: TaskErrorCode; readonly index?: number }
export const MAX_TASK_VERSION = 2147483647;

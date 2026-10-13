import type { Task } from '../../../modules/tasks/domain/task.js';
export function taskInsertValues(task:Task):readonly unknown[]{
 return [task.id,task.userId,task.title,task.description,task.status,task.targetDate,task.scheduledAt,task.dueDate,task.dueAt,
 task.timezone,task.version,task.createdAt,task.updatedAt,task.completedAt,task.cancelledAt];
}

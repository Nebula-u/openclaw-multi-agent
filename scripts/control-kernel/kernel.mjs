import { createRepository } from './repository.mjs';
import { createLease } from './lease.mjs';
import { newRunId, runIdFor, executionIdFor, artifactIdFor } from './ids.mjs';

export function createKernel({ database, clock = () => new Date(), workerId = `worker-${process.pid}`, leaseSeconds = 120 }) {
  if (!database) throw new TypeError('database is required');
  const repository = createRepository(database);
  const lease = createLease({ database, scheduleSeconds: leaseSeconds, clock });
  return {
    id: 'control-kernel', workerId, service: 'kernel', database,
    ids: { newRunId, runIdFor, executionIdFor, artifactIdFor },
    repository, lease,
    getRun: repository.getRun,
    getRunByWorkflowId: repository.getRunByWorkflowId,
    listRuns: repository.listRuns,
    projectRuns: repository.projectRuns,
    getTask: repository.getTask,
    listTasks: repository.listTasks,
    getExecution: repository.getExecution,
    listExecutions: repository.listExecutions,
    listArtifacts: repository.listArtifacts,
  };
}

export { newRunId, runIdFor, executionIdFor, artifactIdFor };

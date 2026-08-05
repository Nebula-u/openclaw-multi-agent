export class ControlTransitionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ControlTransitionError';
    this.code = code;
    this.details = details;
  }
}

function reject(code, message, details) {
  throw new ControlTransitionError(code, message, details);
}

function requireActive(state, command) {
  if (state.condition !== 'ACTIVE') {
    reject('CONTROL_CONDITION_INVALID', `${command.command_type} requires ACTIVE, found ${state.condition}`);
  }
}

function terminalOutcome(command) {
  const mapping = { FAIL: 'FAILED', CANCEL: 'CANCELLED', QUARANTINE: 'QUARANTINED' };
  return mapping[command.command_type];
}

export function reduceWorkflow(current, command, machine) {
  if (command.command_type === 'BOOTSTRAP') {
    if (current !== null || command.expected_revision !== 0) {
      reject('CONTROL_BOOTSTRAP_CONFLICT', 'BOOTSTRAP requires a missing workflow and expected_revision 0');
    }
    const contractSetId = command.payload.contract_set_id;
    const agentBundleId = command.payload.agent_bundle_id;
    if (typeof contractSetId !== 'string' || contractSetId.length === 0) {
      reject('CONTROL_BOOTSTRAP_METADATA_REQUIRED', 'BOOTSTRAP payload requires contract_set_id');
    }
    if (typeof agentBundleId !== 'string' || !/^[a-f0-9]{64}$/u.test(agentBundleId)) {
      reject('CONTROL_BOOTSTRAP_METADATA_REQUIRED', 'BOOTSTRAP payload requires a lowercase SHA-256 agent_bundle_id');
    }
    return {
      schema_version: 2,
      protocol_version: 2,
      workflow_id: command.workflow_id,
      revision: 1,
      phase: 'INTAKE',
      condition: 'ACTIVE',
      outcome: null,
      resume_phase: null,
      resume_condition: null,
      current_candidate_commit: command.candidate_commit ?? null,
      contract_set_id: contractSetId,
      state_machine_version: machine.schema_version,
      agent_bundle_id: agentBundleId,
      created_at: command.occurred_at,
      updated_at: command.occurred_at,
      status_reason: command.reason,
    };
  }

  if (current === null) reject('CONTROL_WORKFLOW_NOT_FOUND', `workflow does not exist: ${command.workflow_id}`);
  if (current.revision !== command.expected_revision) {
    reject('CONTROL_REVISION_CONFLICT', `expected revision ${command.expected_revision}, found ${current.revision}`,
      { expected_revision: command.expected_revision, actual_revision: current.revision });
  }
  if (current.condition === 'TERMINAL') reject('CONTROL_WORKFLOW_TERMINAL', 'terminal workflow cannot transition');

  const next = structuredClone(current);
  if (command.command_type === 'ADVANCE_PHASE') {
    requireActive(current, command);
    if (!command.target_phase) reject('CONTROL_TARGET_PHASE_REQUIRED', 'ADVANCE_PHASE requires target_phase');
    const allowed = machine.phase_transitions[current.phase] ?? [];
    if (!allowed.includes(command.target_phase)) {
      reject('CONTROL_PHASE_TRANSITION_INVALID', `${current.phase} cannot transition to ${command.target_phase}`,
        { from_phase: current.phase, target_phase: command.target_phase });
    }
    next.phase = command.target_phase;
    next.resume_phase = null;
    next.resume_condition = null;
  } else if (command.command_type === 'WAIT_HUMAN') {
    requireActive(current, command);
    next.condition = 'WAITING_HUMAN';
    next.resume_phase = current.phase;
    next.resume_condition = 'ACTIVE';
  } else if (command.command_type === 'HOLD') {
    if (current.condition === 'HOLD') reject('CONTROL_CONDITION_INVALID', 'workflow is already HOLD');
    next.condition = 'HOLD';
    next.resume_phase = current.phase;
    next.resume_condition = current.condition === 'WAITING_HUMAN' ? 'WAITING_HUMAN' : 'ACTIVE';
  } else if (command.command_type === 'RESUME') {
    if (!['WAITING_HUMAN', 'HOLD'].includes(current.condition)) {
      reject('CONTROL_CONDITION_INVALID', `RESUME requires WAITING_HUMAN or HOLD, found ${current.condition}`);
    }
    next.phase = current.resume_phase ?? current.phase;
    next.condition = current.resume_condition ?? 'ACTIVE';
    next.resume_phase = null;
    next.resume_condition = null;
  } else if (command.command_type === 'SET_CANDIDATE') {
    if (typeof command.candidate_commit !== 'string' || command.candidate_commit.length === 0) {
      reject('CONTROL_CANDIDATE_REQUIRED', 'SET_CANDIDATE requires a non-empty candidate_commit');
    }
    next.current_candidate_commit = command.candidate_commit;
  } else if (command.command_type === 'COMPLETE') {
    requireActive(current, command);
    if (current.phase !== 'FINAL_REPORT') reject('CONTROL_FINAL_PHASE_REQUIRED', 'COMPLETE requires FINAL_REPORT phase');
    if (!['READY_FOR_OPERATIONS_HANDOFF', 'RELEASE_NO_GO'].includes(command.outcome)) {
      reject('CONTROL_OUTCOME_INVALID', 'COMPLETE outcome must be READY_FOR_OPERATIONS_HANDOFF or RELEASE_NO_GO');
    }
    next.condition = 'TERMINAL';
    next.outcome = command.outcome;
    next.resume_phase = null;
    next.resume_condition = null;
  } else if (terminalOutcome(command)) {
    next.condition = 'TERMINAL';
    next.outcome = terminalOutcome(command);
    next.resume_phase = null;
    next.resume_condition = null;
  } else {
    reject('CONTROL_COMMAND_UNSUPPORTED', `unsupported command: ${command.command_type}`);
  }

  next.revision = current.revision + 1;
  next.updated_at = command.occurred_at;
  next.status_reason = command.reason;
  return next;
}


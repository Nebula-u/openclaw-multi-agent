import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { compileRoutePlan } from './route-policy.mjs';

function requestValidator(projectRoot) {
  const managerSchema = JSON.parse(readFileSync(join(projectRoot, 'contracts', 'manager-request.schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(managerSchema);
}

export function assertManagerRequest(projectRootInput, value) {
  const projectRoot = resolve(projectRootInput);
  const validate = requestValidator(projectRoot);
  if (!validate(value)) {
    throw Object.assign(new Error('manager request failed JSON Schema validation'), {
      code: 'MANAGER_REQUEST_SCHEMA_INVALID',
      details: { errors: structuredClone(validate.errors ?? []) },
    });
  }
  if (value.submitted_by !== 'manager-agent' || value.user_authorized?.confirmed !== true) {
    throw Object.assign(new Error('request must be an explicit user-authorized Manager action'), { code: 'MANAGER_REQUEST_AUTH_INVALID' });
  }
  if (value.request_type !== 'DECISION') {
    if (value.route_plan.workflow_id !== value.workflow_id) {
      throw Object.assign(new Error('route plan workflow does not match request'), { code: 'ROUTE_PLAN_WORKFLOW_MISMATCH' });
    }
    compileRoutePlan(projectRoot, value.route_plan);
  }
  return value;
}

export function validateManagerRequestFile(projectRootInput, requestFile) {
  const projectRoot = resolve(projectRootInput);
  const raw = readFileSync(resolve(requestFile), 'utf8');
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error('manager request is not valid JSON'), {
      code: 'MANAGER_REQUEST_JSON_INVALID',
      details: { message: error.message },
    });
  }
  return assertManagerRequest(projectRoot, value);
}

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

export const DATABASE_API_SCHEMA = 'api' as const;

export const DATABASE_API_ACTOR_CAPABILITIES = {
  'dataset.save-draft': 'cmd_dataset_save_draft',
} as const;

export const DATABASE_PUBLIC_ACTOR_CAPABILITIES = {
  'dataset.review-submit-job-enqueue': 'cmd_dataset_review_submit_job_enqueue',
  'dataset.review-submit-job-read': 'cmd_dataset_review_submit_job_read',
  'dataset.review-submit-job-read-latest': 'cmd_dataset_review_submit_job_read_latest',
  'dataset.create': 'cmd_dataset_create',
  'dataset.create-version': 'cmd_dataset_create_version',
  'dataset.delete': 'cmd_dataset_delete',
  'dataset.assign-team': 'cmd_dataset_assign_team',
  'dataset.publish': 'cmd_dataset_publish',
  'dataset.review-submit-gate': 'cmd_dataset_review_submit_gate',
} as const;

export const DATABASE_API_SERVICE_CAPABILITIES = {} as const;

export const DATABASE_PUBLIC_SERVICE_CAPABILITIES = {
  'dataset-extraction.record-failure': 'cmd_dataset_extraction_record_failure',
  'dataset-extraction.claim': 'cmd_dataset_extraction_claim',
  'dataset-extraction.ack': 'cmd_dataset_extraction_ack',
} as const;

export const DATABASE_API_RELATION_CAPABILITIES = {
  'identity-center.users': 'identity_center_users_v1',
  'identity-center.processed-events': 'identity_center_processed_events_v1',
  'team.roles': 'team_roles_v1',
} as const;

export type DatabaseActorCapabilityId =
  keyof typeof DATABASE_API_ACTOR_CAPABILITIES | keyof typeof DATABASE_PUBLIC_ACTOR_CAPABILITIES;
export type DatabaseServiceCapabilityId =
  | keyof typeof DATABASE_API_SERVICE_CAPABILITIES
  | keyof typeof DATABASE_PUBLIC_SERVICE_CAPABILITIES;
export type DatabaseApiRelationCapabilityId = keyof typeof DATABASE_API_RELATION_CAPABILITIES;

export type SchemaBoundaryClient = Pick<SupabaseClient, 'schema' | 'rpc'>;

function requireCapability<T extends string>(
  capabilities: Readonly<Record<string, T>>,
  capabilityId: string,
): T {
  const capability = capabilities[capabilityId];
  if (!capability) throw new Error(`Unregistered database API capability: ${capabilityId}`);
  return capability;
}

/**
 * The only shared entrypoint for PostgREST capabilities owned by the database API schema.
 * Keeping schema selection here makes an accidental fallback to `public` visible to the
 * schema-boundary audit instead of relying on each caller to remember the qualifier.
 */
export function databaseApi(client: SchemaBoundaryClient) {
  return client.schema(DATABASE_API_SCHEMA);
}

function callDatabaseBoundaryRpc(
  client: SchemaBoundaryClient,
  apiCapabilities: Readonly<Record<string, string>>,
  publicCapabilities: Readonly<Record<string, string>>,
  capabilityId: string,
  args: Record<string, unknown>,
) {
  const apiRoutine = apiCapabilities[capabilityId];
  if (apiRoutine) return databaseApi(client).rpc(apiRoutine, args);

  const publicRoutine = requireCapability(publicCapabilities, capabilityId);
  return client.rpc(publicRoutine, args);
}

export function callActorDatabaseRpc(
  client: SchemaBoundaryClient,
  capabilityId: DatabaseActorCapabilityId,
  args: Record<string, unknown>,
) {
  return callDatabaseBoundaryRpc(
    client,
    DATABASE_API_ACTOR_CAPABILITIES,
    DATABASE_PUBLIC_ACTOR_CAPABILITIES,
    capabilityId,
    args,
  );
}

export function callServiceDatabaseRpc(
  client: SchemaBoundaryClient,
  capabilityId: DatabaseServiceCapabilityId,
  args: Record<string, unknown>,
) {
  return callDatabaseBoundaryRpc(
    client,
    DATABASE_API_SERVICE_CAPABILITIES,
    DATABASE_PUBLIC_SERVICE_CAPABILITIES,
    capabilityId,
    args,
  );
}

export function fromDatabaseApi(
  client: SchemaBoundaryClient,
  capabilityId: DatabaseApiRelationCapabilityId,
) {
  const relation = requireCapability(DATABASE_API_RELATION_CAPABILITIES, capabilityId);
  return databaseApi(client).from(relation);
}

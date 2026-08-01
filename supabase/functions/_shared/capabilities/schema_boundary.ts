import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

export const DATABASE_API_SCHEMA = 'api' as const;

export type SchemaBoundaryClient = Pick<SupabaseClient, 'schema'>;

/**
 * The only shared entrypoint for PostgREST capabilities owned by the database API schema.
 * Keeping schema selection here makes an accidental fallback to `public` visible to the
 * schema-boundary audit instead of relying on each caller to remember the qualifier.
 */
export function databaseApi(client: SchemaBoundaryClient) {
  return client.schema(DATABASE_API_SCHEMA);
}

export function callDatabaseApiRpc(
  client: SchemaBoundaryClient,
  routine: string,
  args: Record<string, unknown>,
) {
  return databaseApi(client).rpc(routine, args);
}

export function fromDatabaseApi(client: SchemaBoundaryClient, relation: string) {
  return databaseApi(client).from(relation);
}

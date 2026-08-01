import { fromDatabaseApi, type SchemaBoundaryClient } from './capabilities/schema_boundary.ts';

export type UserRoleRow = {
  role: string;
  team_id: string | null;
};

/**
 * Get the user role from the roles table
 * The role enumarate values are [member, owner, review-member, review-admin ...]
 * Return the role and team_id
 */
async function getUserRole(id: string, supabase: SchemaBoundaryClient) {
  const result = await fromDatabaseApi(supabase, 'team.roles')
    .select('role,team_id')
    .eq('user_id', id);
  return Promise.resolve(result);
}

export function hasUserRole(
  roles: UserRoleRow[] | null | undefined,
  role: string,
  teamId?: string,
): boolean {
  return (
    Array.isArray(roles) &&
    roles.some((item) => item.role === role && (teamId === undefined || item.team_id === teamId))
  );
}

export default getUserRole;

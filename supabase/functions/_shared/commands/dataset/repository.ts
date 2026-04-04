import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import type { CommandAuditPayload } from '../../command_runtime/audit_log.ts';
import {
  type DatasetRpcResult,
  callDatasetAssignTeamRpc,
  callDatasetPublishRpc,
  callDatasetSaveDraftRpc,
} from '../../db_rpc/dataset_commands.ts';
import type { AssignTeamRequest, PublishRequest, SaveDraftRequest } from './types.ts';

type RpcClient = Pick<SupabaseClient, 'rpc'>;

export type DatasetCommandRepository = {
  saveDraft: (request: SaveDraftRequest, audit: CommandAuditPayload) => Promise<DatasetRpcResult>;
  assignTeam: (request: AssignTeamRequest, audit: CommandAuditPayload) => Promise<DatasetRpcResult>;
  publish: (request: PublishRequest, audit: CommandAuditPayload) => Promise<DatasetRpcResult>;
};

function requireExplicitClient(supabase: RpcClient | null | undefined): RpcClient {
  if (!supabase || typeof supabase.rpc !== 'function') {
    throw new Error('Dataset command repository requires an explicit Supabase client');
  }

  return supabase;
}

export function createDatasetCommandRepository(supabase: RpcClient): DatasetCommandRepository {
  const client = requireExplicitClient(supabase);

  return {
    saveDraft: (request, audit) => callDatasetSaveDraftRpc(client, request, audit),
    assignTeam: (request, audit) => callDatasetAssignTeamRpc(client, request, audit),
    publish: (request, audit) => callDatasetPublishRpc(client, request, audit),
  };
}

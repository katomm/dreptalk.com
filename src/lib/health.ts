import { resolveNetwork } from './config/network';

export interface HealthPayload {
  status: 'ok';
  network: string;
}

export function buildHealthPayload(networkVar: string | null | undefined): HealthPayload {
  return {
    status: 'ok',
    network: resolveNetwork(networkVar).network,
  };
}

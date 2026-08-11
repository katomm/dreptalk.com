// Emitted documents are absolute-linked, and the base URL is part of the hashed
// bytes. It therefore must come from the deployment, never from a constant, or
// preprod would publish documents claiming mainnet URLs.

export type Cip100Network = 'mainnet' | 'preprod';

export function originForNetwork(network: Cip100Network): string {
  return network === 'preprod' ? 'https://preprod.dreptalk.com' : 'https://dreptalk.com';
}

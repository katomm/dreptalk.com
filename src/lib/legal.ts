// Operator and contact details for the legal pages (imprint, privacy).
// The text of the policies is public and lives in the repo; the operator's
// personal data is injected from environment variables so it stays out of the
// public repository. Set these in `.dev.vars` locally and as Worker vars in
// production:
//   LEGAL_OPERATOR_NAME       operator name or entity
//   LEGAL_OPERATOR_ADDRESS    postal address; separate lines with "|" or newlines
//   LEGAL_CONTACT_EMAIL       contact email for legal and privacy requests
//   LEGAL_RESPONSIBLE_PERSON  person responsible for content (defaults to the operator)
//   LEGAL_PHONE               optional phone number
//   LEGAL_VAT_ID              optional VAT identification number

export interface LegalInfo {
  operatorName: string;
  addressLines: string[];
  email: string;
  phone: string | null;
  vatId: string | null;
  responsiblePerson: string;
  // True when the core fields are configured; pages can show a notice otherwise.
  configured: boolean;
}

// Shown when a field is not configured, so the page never renders blank.
const PLACEHOLDER = '(not configured)';

// Reads the runtime env via cloudflare:workers in the Workers runtime, falling
// back to process.env in Node test environments (same approach as the koios proxy).
function readEnv(): Record<string, string | undefined> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { env } = require('cloudflare:workers') as { env: Record<string, string | undefined> };
    return env;
  } catch {
    return (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>;
  }
}

export function getLegalInfo(): LegalInfo {
  return parseLegalInfo(readEnv());
}

/** Pure parser, exported for tests; getLegalInfo wires it to the runtime env. */
export function parseLegalInfo(env: Record<string, string | undefined>): LegalInfo {
  const name = (env.LEGAL_OPERATOR_NAME ?? '').trim();
  const address = (env.LEGAL_OPERATOR_ADDRESS ?? '').trim();
  const email = (env.LEGAL_CONTACT_EMAIL ?? '').trim();
  const phone = (env.LEGAL_PHONE ?? '').trim();
  const vat = (env.LEGAL_VAT_ID ?? '').trim();
  const responsible = (env.LEGAL_RESPONSIBLE_PERSON ?? '').trim() || name;

  // Address lines may be separated by "|" or newlines.
  const addressLines = address.split(/\s*[|\n]\s*/).filter(Boolean);

  return {
    operatorName: name || PLACEHOLDER,
    addressLines: addressLines.length ? addressLines : [PLACEHOLDER],
    email: email || PLACEHOLDER,
    phone: phone || null,
    vatId: vat || null,
    responsiblePerson: responsible || PLACEHOLDER,
    configured: Boolean(name && address && email),
  };
}

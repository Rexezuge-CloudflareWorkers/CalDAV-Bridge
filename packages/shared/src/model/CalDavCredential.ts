interface CalDavCredentialMetadata {
  credentialId: string;
  applicationId: string;
  name: string;
  passwordPrefix: string;
  passwordLastFour: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number | null | undefined;
}

interface CalDavCredential extends CalDavCredentialMetadata {
  password: string;
}

interface CalDavCredentialInternal {
  credential_id: string;
  application_id: string;
  password_hash: string;
  name: string;
  password_prefix: string;
  password_last_four: string;
  created_at: number;
  expires_at: number;
  last_used_at?: number | null | undefined;
}

export type { CalDavCredential, CalDavCredentialInternal, CalDavCredentialMetadata };

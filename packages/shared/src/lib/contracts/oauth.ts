/** Session-visible metadata for a resource-bound OAuth grant. */
export type OAuthConnection = {
  id: string;
  clientId: string;
  clientName: string;
  userId: string;
  project: string;
  environment: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
};
